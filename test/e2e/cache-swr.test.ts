import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { backendAdmissionStub } from "../../src/backend-admission";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { bodyPublicationResource } from "../../src/cache-publication";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import {
  CALLER_TOKEN,
  POOL,
  bearer,
  jsonResponse,
  relay,
  runWithContext,
  seedPool,
} from "./harness";
import { ownedWork } from "./owned-work";

const repo = "/repos/openclaw/swr-fixture";
const path = `${repo}/actions/runs/42`;
const client = JSON.stringify(["caller", "test-mac"]);
type Envelope = { body: unknown; relay: { cache: string; stale_reason?: string } };

async function setup(identity = false) {
  await seedPool();
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === repo) return jsonResponse({ private: false });
    if (identity && bearer(request) !== "test-primary-token") return jsonResponse({}, 503);
    return jsonResponse({ id: 42, status: "in_progress" });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

async function expire(seconds = 30) {
  const rows = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").all<{
    cache_key: string;
  }>();
  for (const row of rows.results) await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row.cache_key);
  await env.DB.prepare(
    "UPDATE github_cache_entries SET created_at = datetime('now', ?), expires_at = datetime('now', ?)",
  )
    .bind(`-${seconds + 60} seconds`, `-${seconds} seconds`)
    .run();
  return rows.results;
}

function request(
  ctx: ExecutionContext,
  route = path,
  overrides: {
    CLIENT_BACKEND_CONCURRENCY?: string;
    BACKEND_ADMISSION?: Env["BACKEND_ADMISSION"];
  } = {},
) {
  return worker.fetch(
    new Request("https://octopool.dev/v1/github/request", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ pool: POOL, method: "GET", path: route }),
    }),
    { ...env, ...overrides } as Env,
    ctx,
  );
}

async function cacheRows() {
  return (
    await env.DB.prepare(
      "SELECT cache_key, body_json, created_at, expires_at, publication_id FROM github_cache_entries ORDER BY cache_key",
    ).all()
  ).results;
}

async function audits() {
  return (
    await env.DB.prepare(
      "SELECT cache_status, requested_max_age, fallback_reason, cache_miss_reason FROM audit_events ORDER BY rowid",
    ).all()
  ).results;
}

describe("CI stale-while-revalidate", () => {
  it.each([false, true])(
    "contains background admission RPC failures (retry succeeds=%s)",
    async (recovers) => {
      const upstream = await setup();
      await relay(path);
      await expire();
      const before = await cacheRows();
      upstream.mockClear();
      const real = backendAdmissionStub(env, POOL);
      const acquire = vi.fn(async (id: string, key: string, limit: number) =>
        real.acquire(id, key, limit),
      );
      if (recovers) acquire.mockRejectedValueOnce(new Error("synthetic admission failure"));
      else acquire.mockRejectedValue(new Error("synthetic admission failure"));
      const release = vi.fn(async (id: string) => {
        await real.release(id);
        throw new Error("synthetic lost release acknowledgement");
      });
      const namespace = {
        idFromName: env.BACKEND_ADMISSION.idFromName.bind(env.BACKEND_ADMISSION),
        get: () => ({ acquire, renew: (id: string) => real.renew(id), release }),
      } as unknown as Env["BACKEND_ADMISSION"];
      const response = await runWithContext((ctx) =>
        request(ctx, path, { BACKEND_ADMISSION: namespace }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        relay: { cache: "stale", stale_reason: "stale_while_revalidate" },
      });
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(acquire.mock.calls[1]).toEqual(acquire.mock.calls[0]);
      expect(acquire.mock.calls[0]![2]).toBe(7);
      expect(release).toHaveBeenCalledTimes(1);
      expect(upstream).toHaveBeenCalledTimes(recovers ? 1 : 0);
      if (!recovers) expect(await cacheRows()).toEqual(before);
      expect(await audits()).toHaveLength(2);
      // The failed refresh releases its isolate slot so a later read can refresh.
      expect((await relay(path)).status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it("returns the stored REST creation time for hits and the stale entry during SWR", async () => {
    await setup(true);
    const miss = await (await relay(path)).json<Envelope>();
    expect(miss.relay.cache).toBe("miss");
    expect(miss.relay).not.toHaveProperty("cache_created_at");
    const [fresh] = await cacheRows();
    expect(await (await relay(path)).json()).toMatchObject({
      relay: { cache: "hit", cache_created_at: new Date(`${fresh!.created_at}Z`).toISOString() },
    });
    await expire();
    const [stale] = await cacheRows();
    expect(await (await relay(path)).json()).toMatchObject({
      relay: {
        cache: "stale",
        stale_reason: "stale_while_revalidate",
        cache_created_at: new Date(`${stale!.created_at}Z`).toISOString(),
      },
    });
  });

  const addedRoutes = [
    `${repo}/pulls/42/files`,
    `${repo}/issues/42/comments`,
    `${repo}/issues/comments`,
    `${repo}/pulls/42`,
    `${repo}/contents/README.md`,
  ];

  it.each(addedRoutes)("serves and refreshes SWR for %s", async (route) => {
    const upstream = await setup();
    await relay(route);
    await expire();
    upstream.mockClear();
    expect(await (await relay(route)).json()).toMatchObject({
      relay: { cache: "stale", stale_reason: "stale_while_revalidate" },
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect((await audits()).at(-1)).toMatchObject({
      cache_status: "stale",
      fallback_reason: "stale_while_revalidate",
      requested_max_age: null,
    });
    expect(await (await relay(route)).json()).toMatchObject({ relay: { cache: "hit" } });
  });

  it.each(addedRoutes.flatMap((route) => [0, 300].map((age) => ({ route, age }))))(
    "never serves SWR for $route with explicit max-age=$age",
    async ({ route, age }) => {
      const upstream = await setup();
      await relay(route);
      await expire();
      upstream.mockClear();
      expect(
        await (
          await relay(route, undefined, { headers: { "cache-control": `max-age=${age}` } })
        ).json(),
      ).toMatchObject({ relay: { cache: "miss" } });
      expect(upstream).toHaveBeenCalledOnce();
      expect((await audits()).at(-1)).toMatchObject({
        cache_status: "miss",
        fallback_reason: null,
        requested_max_age: age,
      });
    },
  );

  it.each([false, true])(
    "serves stale before the %s identity refresh finishes, coalesces concurrent reads, and publishes a fresh hit",
    async (identity) => {
      const upstream = await setup(identity);
      await relay(path);
      await expire();
      const entered = ownedWork.gate();
      const release = ownedWork.gate();
      let refreshes = 0;
      const original = upstream.getMockImplementation()!;
      upstream.mockImplementation(async (input, init) => {
        const req = new Request(input, init);
        if (
          new URL(req.url).pathname === path &&
          (!identity || bearer(req) === "test-primary-token")
        ) {
          refreshes++;
          entered.release();
          await release.promise;
          return jsonResponse({ id: 42, status: "completed", conclusion: "success" });
        }
        return original(input, init);
      });
      await runWithContext(async (ctx) => {
        try {
          const response = await request(ctx);
          expect(await response.json()).toMatchObject({
            body: { status: "in_progress" },
            relay: { cache: "stale", stale_reason: "stale_while_revalidate" },
          });
          await entered.promise;
          const responses = await Promise.all(Array.from({ length: 5 }, () => request(ctx)));
          for (const result of responses)
            expect(await result.json()).toMatchObject({ relay: { cache: "stale" } });
          expect(refreshes).toBe(1);
        } finally {
          release.release();
        }
      });
      expect(await audits()).toEqual([
        expect.objectContaining({ cache_status: "miss" }),
        ...Array.from({ length: 6 }, () => ({
          cache_status: "stale",
          requested_max_age: null,
          fallback_reason: "stale_while_revalidate",
          cache_miss_reason: null,
        })),
      ]);
      expect(await (await relay(path)).json()).toMatchObject({
        body: { status: "completed" },
        relay: { cache: "hit" },
      });
      expect(refreshes).toBe(1);
    },
  );

  it.each([
    { seconds: 61, age: undefined, route: path },
    { seconds: 30, age: "max-age=0", route: path },
    { seconds: 30, age: "max-age=300", route: path },
    { seconds: 30, age: undefined, route: `${repo}/issues/42` },
  ])(
    "uses a normal miss for $route, age=$age, expired=$seconds",
    async ({ seconds, age, route }) => {
      const upstream = await setup();
      await relay(route);
      await expire(seconds);
      upstream.mockClear();
      const response = await relay(
        route,
        undefined,
        age === undefined ? {} : { headers: { "cache-control": age } },
      );
      expect(await response.json()).toMatchObject({ relay: { cache: "miss" } });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect((await audits()).at(-1)).toMatchObject({
        requested_max_age: age === undefined ? null : Number(age.slice(8)),
        cache_status: "miss",
      });
    },
  );

  it("leaves the stale response and entry unchanged on refresh failure without an extra audit", async () => {
    const upstream = await setup();
    await relay(path);
    await expire();
    const before = await cacheRows();
    upstream.mockImplementation(async () => jsonResponse({}, 503));
    const log = vi.spyOn(console, "error");
    expect(await (await relay(path)).json()).toMatchObject({
      body: { status: "in_progress" },
      relay: { cache: "stale" },
    });
    expect(await cacheRows()).toEqual(before);
    expect(await audits()).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("background CI cache refresh failed or admission unavailable");
  });

  it("conditionally refreshes a stale body without adding a client audit", async () => {
    const upstream = await setup();
    upstream.mockImplementation(async () =>
      jsonResponse({ id: 42, status: "in_progress" }, 200, {
        etag: '"swr-v1"',
        "x-ratelimit-resource": "core",
      }),
    );
    await relay(path);
    await expire();
    upstream.mockImplementation(async (input, init) => {
      expect(new Request(input, init).headers.get("if-none-match")).toBe('"swr-v1"');
      return new Response(null, { status: 304 });
    });
    expect(await (await relay(path)).json()).toMatchObject({ relay: { cache: "stale" } });
    expect(await audits()).toHaveLength(2);
    expect(await (await relay(path)).json()).toMatchObject({ relay: { cache: "hit" } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late response after the background deadline", async () => {
    const upstream = await setup();
    await relay(path);
    await expire();
    const before = await cacheRows();
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 20_000 ? deadline.signal : timeout(ms),
    );
    const entered = ownedWork.gate();
    const release = ownedWork.gate();
    upstream.mockImplementation(async () => {
      entered.release();
      await release.promise;
      return jsonResponse({ id: 42, status: "completed" });
    });
    await runWithContext(async (ctx) => {
      try {
        expect(await (await request(ctx)).json()).toMatchObject({ relay: { cache: "stale" } });
        await entered.promise;
        deadline.abort();
      } finally {
        release.release();
      }
    });
    expect(await cacheRows()).toEqual(before);
    expect(await audits()).toHaveLength(2);
    const permits = await runInDurableObject(backendAdmissionStub(env, POOL), (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM backend_permits").one(),
    );
    expect(permits.n).toBe(0);
    // A renewal rejected after cancellation leaves its durable lease to expire.
    const owners = await env.DB.prepare(
      "SELECT resource_key, lease_until_ms FROM cache_publication_owners",
    ).all<{ resource_key: string; lease_until_ms: number }>();
    for (const owner of owners.results) {
      expect(owner.lease_until_ms).toBeLessThanOrEqual(Date.now() + 8_000);
    }
  });

  it.each(["epoch", "variant", "identity", "private"])(
    "rejects an otherwise stale entry with invalid %s",
    async (invalid) => {
      const upstream = await setup();
      await relay(path);
      await expire();
      if (invalid === "epoch")
        await env.DB.prepare("UPDATE github_cache_entries SET publication_epoch = 'old'").run();
      if (invalid === "identity")
        await env.DB.prepare(
          "UPDATE github_cache_entries SET identity_id = 'removed', identity_kind = 'pat'",
        ).run();
      if (invalid === "private") {
        await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
        await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/swr-fixture");
        upstream.mockImplementation(async () => jsonResponse({ private: true }));
      }
      const response = await relay(
        path,
        undefined,
        invalid === "variant" ? { headers: { "x-github-api-version": "2099-01-01" } } : {},
      );
      expect((await response.json<Partial<Envelope>>()).relay?.cache).not.toBe("stale");
    },
  );

  it.each(["refresh", "body"])(
    "skips refresh when another isolate owns the %s publication",
    async (ownership) => {
      const upstream = await setup();
      await relay(path);
      const rows = await expire();
      const key = rows[0]!.cache_key;
      const coordinator = poolCoordinatorStub(env, POOL);
      const owner = await coordinator.tryAcquirePublication(
        ownership === "refresh" ? `swr:${key}` : bodyPublicationResource(key),
      );
      expect(owner).toBeDefined();
      upstream.mockClear();
      try {
        expect(await (await relay(path)).json()).toMatchObject({ relay: { cache: "stale" } });
        expect(upstream).not.toHaveBeenCalled();
        expect(await audits()).toHaveLength(2);
      } finally {
        await coordinator.completePublication(owner!, "failed");
      }
    },
  );

  it("skips refresh at caller capacity while leaving the last slot for foreground work", async () => {
    const upstream = await setup();
    await relay(path);
    await expire();
    const admission = backendAdmissionStub(env, POOL);
    expect(await admission.acquire("foreground", client, 2)).toBe(true);
    upstream.mockClear();
    try {
      await runWithContext(async (ctx) => {
        expect(
          await (await request(ctx, path, { CLIENT_BACKEND_CONCURRENCY: "2" })).json(),
        ).toMatchObject({ relay: { cache: "stale" } });
      });
      expect(upstream).not.toHaveBeenCalled();
      expect(await admission.acquire("last-slot", client, 2)).toBe(true);
    } finally {
      await admission.release("foreground");
      await admission.release("last-slot");
    }
  });

  it("caps the isolate at eight refreshes and releases admission and ownership after completion", async () => {
    const upstream = await setup();
    const paths = Array.from({ length: 9 }, (_, i) => `${repo}/actions/runs/${i + 100}`);
    for (let i = 0; i < paths.length; i += 3)
      await Promise.all(paths.slice(i, i + 3).map((route) => relay(route)));
    await expire();
    const release = ownedWork.gate();
    let refreshes = 0;
    upstream.mockImplementation(async () => {
      refreshes++;
      await release.promise;
      return jsonResponse({ status: "in_progress" });
    });
    await runWithContext(async (ctx) => {
      try {
        for (const route of paths) {
          expect(
            await (await request(ctx, route, { CLIENT_BACKEND_CONCURRENCY: "16" })).json(),
          ).toMatchObject({ relay: { cache: "stale" } });
        }
        await expect.poll(() => refreshes).toBe(8);
        const admission = backendAdmissionStub(env, POOL);
        const count = await runInDurableObject(admission, (_instance, state) =>
          state.storage.sql.exec("SELECT COUNT(*) AS n FROM backend_permits").one(),
        );
        expect(count.n).toBe(8);
      } finally {
        release.release();
      }
    });
    expect(refreshes).toBe(8);
    expect(await audits()).toHaveLength(18);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_publication_owners").first("n"),
    ).toBe(0);
    await relay(paths[8]!);
    expect(refreshes).toBe(9);
  }, 30_000);
});
