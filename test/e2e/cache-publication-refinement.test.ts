import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { type CacheFillOutcome } from "../../src/cache-fill";
import {
  CACHE_PUBLICATION_EPOCH,
  proofPublicationResource,
  type PublicationOwner,
} from "../../src/cache-publication";
import { withGitHubEgress } from "../../src/github-egress";
import { queries } from "../../src/generated/sql";
import { publicProofCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { ensurePublicGitHubRepo, storePublicRepoProof } from "../../src/public-repos";
import { sqliteTimestamp } from "../../src/sqlite-time";
import { ownedWork } from "./owned-work";
import { observePublicationD1 } from "./publication-d1-observer";

const route = classifyRoute(
  { pool: "a", method: "GET", path: "/repos/OpenClaw/Octopool" },
  defaultPolicy("openclaw"),
);
const resource = proofPublicationResource("openclaw", "octopool");
const readOwner = () =>
  env.DB.prepare(queries.readPublicationOwner)
    .bind(CACHE_PUBLICATION_EPOCH, resource)
    .first<PublicationOwner>();
const readProof = () =>
  env.DB.prepare(queries.readPublicRepoProof)
    .bind(CACHE_PUBLICATION_EPOCH, "openclaw", "octopool")
    .first<{ publication_id: number; is_public: number }>();

// Observe the real RPC result without deciding or manufacturing its acknowledgment.
function observeCompletions(completions: { storage: CacheFillOutcome; accepted: boolean }[]) {
  return new Proxy(env.POOL_COORDINATOR, {
    get(target, key) {
      if (key === "get")
        return (...args: Parameters<typeof target.get>) => {
          const stub = target.get(...args);
          return new Proxy(stub, {
            get(real, method) {
              if (method === "completePublication")
                return async (
                  owner: PublicationOwner,
                  storage: CacheFillOutcome,
                  publicationId?: number,
                ) => {
                  const accepted = await real.completePublication(owner, storage, publicationId);
                  completions.push({ storage, accepted });
                  return accepted;
                };
              const value = Reflect.get(real, method, real);
              return typeof value === "function"
                ? (...values: unknown[]) => Reflect.apply(value, real, values)
                : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it.each([
  ["before", true],
  ["after", true],
  ["before", false],
  ["after", false],
] as const)(
  "uses the replacement verdict after a %s-SQL fault for old public=%s",
  async (phase, oldPublic) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: !oldPublic })),
    );
    const gate = ownedWork.gate();
    const entered = ownedWork.gate();
    const db = observePublicationD1(env.DB, {
      [phase]: async (sql: string) => {
        if (sql !== queries.upsertPublicRepoProof) return;
        entered.release();
        await gate.promise;
        throw new Error(`Forwarded proof ${phase}-SQL transport fault`);
      },
    });
    const completions: { storage: CacheFillOutcome; accepted: boolean }[] = [];
    const pending = ownedWork.track(
      ensurePublicGitHubRepo(
        withGitHubEgress(
          {
            ...env,
            DB: db,
            POOL_COORDINATOR: observeCompletions(completions),
          },
          [],
        ),
        route,
      ).then(
        () => "authorized",
        (error: unknown) => error,
      ),
    );
    await Promise.race([
      entered.promise,
      pending.then((result) => {
        throw new Error(`Proof gate was not reached: ${String(result)}`);
      }),
    ]);
    const a = (await readOwner())!;
    expect(a).not.toBeNull();
    if (phase === "after")
      expect(await readProof()).toMatchObject({
        publication_id: a.id,
        is_public: Number(oldPublic),
      });
    else expect(await readProof()).toBeNull();
    await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?")
      .bind(a.id)
      .run();
    const coordinator = publicProofCoordinatorStub(env);
    const b = (await coordinator.tryAcquirePublication(resource))!;
    expect(b.id).toBeGreaterThan(a.id);
    expect(
      await storePublicRepoProof(
        env,
        "openclaw",
        "octopool",
        !oldPublic,
        sqliteTimestamp(Date.now()),
        b,
      ),
    ).toBe("shared");
    expect(await coordinator.completePublication(b, "shared")).toBe(true);
    gate.release();
    const result = await pending;
    expect(completions).toEqual([{ storage: "unknown", accepted: false }]);
    expect(await readProof()).toMatchObject({
      publication_id: b.id,
      is_public: Number(!oldPublic),
    });
    if (oldPublic) expect(result).toMatchObject({ status: 403, code: "repo_not_public" });
    else expect(result).toBe("authorized");
  },
);

it.each([
  ["renewal", "private"],
  ["renewal", "404"],
  ["write", "private"],
  ["write", "404"],
  ["unknown", "private"],
  ["unknown", "404"],
] as const)(
  "does not replace a lost %s denial (%s) with an older positive receipt",
  async (phase, denial) => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const coordinator = publicProofCoordinatorStub(env);
      const previous = (await coordinator.tryAcquirePublication(resource))!;
      expect(
        await storePublicRepoProof(
          env,
          "openclaw",
          "octopool",
          true,
          sqliteTimestamp(now),
          previous,
        ),
      ).toBe("shared");
      expect(await coordinator.completePublication(previous, "shared")).toBe(true);
      const previousProof = await readProof();
      let rejectedId = 0;
      let probes = 0;
      const expireCurrent = async () => {
        const owner = (await readOwner())!;
        expect(owner.id).toBeGreaterThan(previous.id);
        rejectedId = owner.id;
        await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?")
          .bind(owner.id)
          .run();
        expect(await readProof()).toEqual(previousProof);
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          probes++;
          if (probes === 1 && phase === "renewal") await expireCurrent();
          return denial === "404"
            ? new Response(null, { status: 404 })
            : Response.json({ private: true });
        }),
      );
      const db = observePublicationD1(env.DB, {
        before: async (sql) => {
          if (sql !== queries.upsertPublicRepoProof || probes !== 1 || phase === "renewal") return;
          await expireCurrent();
          if (phase === "unknown") throw new Error("Denial publication transport fault");
        },
      });
      const result = await ensurePublicGitHubRepo(
        withGitHubEgress({ ...env, DB: db }, []),
        route,
      ).then(
        () => "authorized",
        (error: unknown) => error,
      );
      expect(result).toMatchObject({ status: 403, code: "repo_not_public" });
      expect(probes).toBe(2);
      expect(await readOwner()).toBeNull();
      const current = await readProof();
      expect(current?.is_public).toBe(0);
      expect(current!.publication_id).toBeGreaterThan(rejectedId);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["live", "expired-owner", "expired-evidence"])(
  "keeps direct fresh authorization on persistence failure only while valid (%s)",
  async (mode) => {
    const fetcher = vi
      .fn(async () => Response.json({ private: false }))
      .mockResolvedValueOnce(Response.json({ private: false }))
      .mockResolvedValueOnce(Response.json({ private: true }));
    vi.stubGlobal("fetch", fetcher);
    let faulted = false;
    if (mode === "expired-evidence") vi.useFakeTimers({ toFake: ["Date"] });
    const completions: { storage: CacheFillOutcome; accepted: boolean }[] = [];
    const db = observePublicationD1(env.DB, {
      before: async (sql) => {
        if (sql !== queries.upsertPublicRepoProof || faulted) return;
        faulted = true;
        if (mode === "expired-owner")
          await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
        // Consumption metadata expires; native D1 ownership is still live.
        if (mode === "expired-evidence") vi.setSystemTime(Date.now() + 301_000);
        throw new Error("Proof persistence unavailable before execution");
      },
    });
    try {
      const result = await ensurePublicGitHubRepo(
        withGitHubEgress(
          {
            ...env,
            DB: db,
            POOL_COORDINATOR: observeCompletions(completions),
          },
          [],
        ),
        route,
      ).then(
        () => "authorized",
        (error: unknown) => error,
      );
      expect(completions[0]).toEqual({ storage: "unknown", accepted: mode !== "expired-owner" });
      expect(await readOwner()).toBeNull();
      if (mode !== "live") {
        expect(result).toMatchObject({ status: 403, code: "repo_not_public" });
        expect(fetcher).toHaveBeenCalledTimes(2);
      } else {
        expect(result).toBe("authorized");
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(await readProof()).toBeNull();
      }
    } finally {
      if (mode === "expired-evidence") vi.useRealTimers();
    }
  },
);

it("recovers an actual committed positive receipt after an ack fault while still live", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ private: false })),
  );
  let committed = false;
  const completions: { storage: CacheFillOutcome; accepted: boolean }[] = [];
  const db = observePublicationD1(env.DB, {
    after: async (sql, _values, result) => {
      if (sql !== queries.upsertPublicRepoProof) return;
      expect(result.results).toHaveLength(1);
      committed = true;
      throw new Error("Proof acknowledgment lost after native commit");
    },
  });
  await ensurePublicGitHubRepo(
    withGitHubEgress(
      {
        ...env,
        DB: db,
        POOL_COORDINATOR: observeCompletions(completions),
      },
      [],
    ),
    route,
  );
  expect(committed).toBe(true);
  expect(completions).toEqual([{ storage: "shared", accepted: true }]);
  expect(await readProof()).toMatchObject({ is_public: 1 });
});

it.each(["longer", "shorter", "expired"])(
  "renews an exact owner with a %s persisted deadline monotonically",
  async (kind) => {
    const coordinator = publicProofCoordinatorStub(env);
    const owner = (await coordinator.tryAcquirePublication(resource))!;
    // Persist native SQL deadlines; changing JS Date does not advance D1 authority.
    const duration = kind === "longer" ? 60_000 : kind === "shorter" ? 4_000 : -1;
    await env.DB.prepare(
      "UPDATE cache_publication_owners SET lease_until_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) + ? WHERE id = ?",
    )
      .bind(duration, owner.id)
      .run();
    const before = (await readOwner())!.lease_until_ms;
    expect(await coordinator.renewPublication(owner)).toBe(kind !== "expired");
    const after = (await readOwner())!.lease_until_ms;
    if (kind === "shorter") expect(after).toBeGreaterThan(before);
    else expect(after).toBe(before);
  },
);
