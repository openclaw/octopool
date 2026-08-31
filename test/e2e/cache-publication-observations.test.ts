import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import {
  CACHE_PUBLICATION_EPOCH,
  proofPublicationResource,
  type PublicationOwner,
} from "../../src/cache-publication";
import { publicProofCoordinatorStub } from "../../src/pool-coordinator";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { terminalLogCacheProof } from "../../src/terminal-log-cache";
import { withGitHubEgress } from "../../src/github-egress";
import { queries } from "../../src/generated/sql";
import { jsonResponse, relay, runWithContext, seedPool, POOL, CALLER_TOKEN } from "./harness";
import { ownedWork } from "./owned-work";
import { observePublicationD1 } from "./publication-d1-observer";
import { requestWithWarmEnv } from "./identity-routing-support";
import { sqliteTimestamp } from "../../src/sqlite-time";

const path = "/repos/openclaw/octopool/issues/42";
const repoResource = proofPublicationResource("openclaw", "octopool");
const owner = () =>
  env.DB.prepare(queries.readPublicationOwner)
    .bind(CACHE_PUBLICATION_EPOCH, repoResource)
    .first<PublicationOwner>();
const proofCount = () =>
  env.DB.prepare("SELECT count(*) AS n FROM github_public_repo_proofs").first<number>("n");
const apiHeaders = { etag: '"fixture"', "x-ratelimit-resource": "core" };

it.each(["token-free", "revalidation", "terminal-metadata"])(
  "acquires once before actual %s observation and releases before continuation",
  async (site) => {
    await exercise(site, false);
  },
);

it.each(["token-free", "revalidation", "terminal-metadata"])(
  "runs actual %s observation normally on busy without adopting its evidence after release",
  async (site) => {
    await exercise(site, true);
  },
);

async function exercise(site: string, busy: boolean) {
  await seedPool();
  if (site === "revalidation") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ number: 42 }, 200, apiHeaders)),
    );
    expect((await relay(path)).status).toBe(200);
    await expireBody();
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
  }
  const coordinator = publicProofCoordinatorStub(env);
  const incumbent = busy ? await coordinator.tryAcquirePublication(repoResource) : undefined;
  let observations = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.has("authorization")).toBe(false);
      const capability = await owner();
      expect(capability).not.toBeNull();
      if (busy) {
        expect(capability!.id).toBe(incumbent!.id);
        await coordinator.completePublication(incumbent!, "failed");
      }
      observations++;
      return jsonResponse({ number: 42, status: "completed", run_attempt: 1 }, 200, apiHeaders);
    }),
  );
  if (site === "terminal-metadata") {
    const request = {
      pool: POOL,
      method: "GET" as const,
      path: "/repos/openclaw/octopool/actions/jobs/9/logs",
    };
    const policy = defaultPolicy("openclaw");
    expect(
      await runWithContext((ctx) =>
        terminalLogCacheProof(
          withGitHubEgress(env, []),
          ctx,
          request,
          classifyRoute(request, policy),
          policy,
        ),
      ),
    ).toBeDefined();
  } else {
    expect((await relay(path)).status).toBe(200);
  }
  expect(observations).toBe(1);
  expect(await owner()).toBeNull();
  expect(await proofCount()).toBe(busy ? 0 : 1);
}

it("releases the anonymous 304 capability before the real explicit proof guard", async () => {
  await seedPool();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ number: 42 }, 200, apiHeaders)),
  );
  await relay(path);
  await expireBody();
  await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
  await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
  let anonymousId = 0;
  let probes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const capability = await owner();
      expect(capability).not.toBeNull();
      if (request.url.endsWith("/issues/42")) {
        expect(request.headers.get("if-none-match")).toBe('"fixture"');
        anonymousId = capability!.id;
        return new Response(null, { status: 304, headers: apiHeaders });
      }
      probes++;
      expect(capability!.id).toBeGreaterThan(anonymousId);
      expect(await proofCount()).toBe(0);
      return jsonResponse({ private: false });
    }),
  );
  expect((await relay(path)).status).toBe(200);
  expect(probes).toBe(1);
  expect(await owner()).toBeNull();
});

it("adds no publication D1/DO call to a hot anonymous body plus covering edge proof and exposes no receipts", async () => {
  await seedPool();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ number: 42 }, 200, apiHeaders)),
  );
  await relay(path);
  const prior = await env.DB.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
  ).first("seq");
  const statements: string[] = [];
  let publicationRPCs = 0;
  const db = observePublicationD1(env.DB, {
    before: async (sql) => {
      statements.push(sql);
    },
  });
  const namespace = new Proxy(env.POOL_COORDINATOR, {
    get(target, key) {
      if (key === "get")
        return (...args: Parameters<typeof target.get>) => {
          const stub = target.get(...args);
          return new Proxy(stub, {
            get(real, method) {
              const value = Reflect.get(real, method, real);
              if (typeof value !== "function") return value;
              return (...values: unknown[]) => {
                if (String(method).includes("Publication")) publicationRPCs++;
                return Reflect.apply(value, real, values);
              };
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const body = await (
    await requestWithWarmEnv({ DB: db, POOL_COORDINATOR: namespace }, path, {})
  ).text();
  expect(JSON.parse(body)).toMatchObject({ relay: { cache: "hit" }, body: { number: 42 } });
  expect(body).not.toMatch(
    /owner_token|publication_token|publication_id|lease_until_ms|protocol_epoch/,
  );
  expect(publicationRPCs).toBe(0);
  expect(
    statements.filter((sql) =>
      /cache_publication_owners|github_public_repo_proofs|github_cache_entries/.test(sql),
    ),
  ).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
    ).first("seq"),
  ).toBe(prior);
});

async function expireBody() {
  const rows = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").all<{
    cache_key: string;
  }>();
  for (const { cache_key } of rows.results)
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, cache_key);
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second')",
  ).run();
}

it.each([
  ["token-free", "before"],
  ["token-free", "after"],
  ["revalidation", "before"],
  ["revalidation", "after"],
  ["304", "after"],
] as const)(
  "freezes %s body evidence before a delayed proof %s SQL and body ack",
  async (site, phase) => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ number: 42 }, 200, apiHeaders)),
    );
    if (site !== "token-free") {
      expect((await relay(path)).status).toBe(200);
      await expireBody();
      await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
      await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
    }
    if (site === "304")
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (request.url.endsWith("/issues/42")) {
            expect(request.headers.get("if-none-match")).toBe('"fixture"');
            return new Response(null, { status: 304, headers: apiHeaders });
          }
          return jsonResponse({ private: false });
        }),
      );
    // Only JS evidence metadata moves. The D1 lease clock and timers stay native.
    const observedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(observedAt);
    const proofGate = ownedWork.gate();
    const bodyGate = ownedWork.gate();
    const proofEntered = ownedWork.gate();
    const bodyCommitted = ownedWork.gate();
    const holdProof = async (sql: string) => {
      if (sql !== queries.upsertPublicRepoProof) return;
      proofEntered.release();
      await proofGate.promise;
    };
    const db = observePublicationD1(env.DB, {
      ...(phase === "before" ? { before: holdProof } : {}),
      after: async (sql, _values, result) => {
        if (phase === "after") await holdProof(sql);
        if (sql !== queries.writeGitHubCache) return;
        expect(result.results).toHaveLength(1);
        bodyCommitted.release();
        await bodyGate.promise;
      },
    });
    const pending = requestWithWarmEnv({ DB: db }, path, {});
    try {
      await Promise.race([
        proofEntered.promise,
        pending.then(() => {
          throw new Error("Proof gate was not reached");
        }),
      ]);
      vi.setSystemTime(observedAt + 10_000);
      proofGate.release();
      await Promise.race([
        bodyCommitted.promise,
        pending.then(() => {
          throw new Error("Body gate was not reached");
        }),
      ]);
      const committed = await env.DB.prepare(
        "SELECT created_at, expires_at, body_json FROM github_cache_entries",
      ).first();
      vi.setSystemTime(observedAt + 20_000);
      bodyGate.release();
      const response = await pending;
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toMatch(/observedAt|publication_token|owner_token|protocol_epoch/);
      expect(committed?.created_at).toBe(sqliteTimestamp(observedAt));
      expect(committed?.expires_at).toBe(sqliteTimestamp(observedAt + 300_000));
      expect(
        await env.DB.prepare(
          "SELECT created_at, expires_at, body_json FROM github_cache_entries",
        ).first(),
      ).toEqual(committed);
      expect(
        await env.DB.prepare("SELECT checked_at FROM github_public_repo_proofs").first(
          "checked_at",
        ),
      ).toBe(committed?.created_at);
      expect(String(committed?.body_json)).not.toContain("observedAt");
    } finally {
      proofGate.release();
      bodyGate.release();
      try {
        await pending;
      } finally {
        vi.useRealTimers();
      }
    }
  },
);

it.each(["token-free", "revalidation"])(
  "retains %s first-page evidence through delayed native aggregation",
  async (site) => {
    await seedPool();
    const jobsPath = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";
    const options = {
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    };
    const secondPage = ownedWork.gate();
    const aggregationEntered = ownedWork.gate();
    let holding = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        expect(request.headers.has("authorization")).toBe(false);
        if (url.hostname === "github.com") return jsonResponse({}, 404);
        if (url.pathname.endsWith("/attempts/2"))
          return jsonResponse({ status: "completed", run_attempt: 2 });
        expect(url.pathname).toBe(jobsPath);
        const page = Number(url.searchParams.get("page"));
        if (holding && page === 2) {
          // The first page releases its proof authority before aggregation starts.
          expect(await owner()).toBeNull();
          aggregationEntered.release();
          await secondPage.promise;
        }
        return jsonResponse(
          {
            total_count: 101,
            jobs: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
              id: (page - 1) * 100 + index + 1,
              status: "completed",
            })),
          },
          200,
          apiHeaders,
        );
      }),
    );
    if (site === "revalidation") {
      expect((await relay(jobsPath, undefined, options)).status).toBe(200);
      await expireBody();
      await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
      await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
    }
    const observedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(observedAt);
    holding = true;
    const pending = requestWithWarmEnv({}, jobsPath, options);
    try {
      await Promise.race([
        aggregationEntered.promise,
        pending.then(() => {
          throw new Error("Aggregation gate was not reached");
        }),
      ]);
      vi.setSystemTime(observedAt + 10_000);
      secondPage.release();
      expect((await pending).status).toBe(200);
      const row = await env.DB.prepare(
        "SELECT created_at, expires_at, body_json FROM github_cache_entries WHERE route_kind = 'run_jobs'",
      ).first<{ created_at: string; expires_at: string; body_json: string }>();
      expect(JSON.parse(row!.body_json).jobs).toHaveLength(101);
      expect(row!.created_at).toBe(sqliteTimestamp(observedAt));
      expect(row!.expires_at).toBe(sqliteTimestamp(observedAt + 3_600_000));
    } finally {
      secondPage.release();
      try {
        await pending;
      } finally {
        vi.useRealTimers();
      }
    }
  },
);

it("fails a missing publication RPC through the native Worker boundary and drains real background work", async () => {
  await seedPool();
  const response = await ownedWork.track(
    (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL.fetch(
      "https://octopool.dev/v1/github/request",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CALLER_TOKEN}`,
          "content-type": "application/json",
          "x-test-identity-protocol": "missing-publication",
        },
        body: JSON.stringify({ pool: POOL, method: "GET", path }),
      },
    ),
  );
  const text = await ownedWork.track(response.text());
  expect(response.status).toBe(500);
  expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error" } });
  expect(response.headers.get("x-test-feedback-calls")).toBe("2");
  expect(response.headers.get("x-test-background-registered")).toBe(
    response.headers.get("x-test-background-settled"),
  );
  expect(await proofCount()).toBe(0);
});

it("completes the following native reset and ordinary publication after missing RPC", async () => {
  await seedPool();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ number: 42 }, 200, apiHeaders)),
  );
  expect((await relay(path)).status).toBe(200);
  expect(await proofCount()).toBe(1);
});
