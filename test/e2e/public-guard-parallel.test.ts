import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { backendWorkSignal } from "../../src/backend-work";
import { backendAdmissionStub } from "../../src/backend-admission";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { CACHE_PUBLICATION_EPOCH } from "../../src/cache-publication";
import { writeEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { sqliteTimestamp } from "../../src/sqlite-time";
import { bearer, jsonResponse, POOL, rateHeaders, relay, seedPool } from "./harness";
import { ownedWork } from "./owned-work";
import { requestWithEnv } from "./identity-routing-support";

const path = "/repos/openclaw/octopool/check-runs/42/annotations";
const body = [
  { path: "synthetic.ts", message: "synthetic pooled response", annotation_level: "notice" },
];

function trackCacheWrites() {
  const cache = caches.default;
  const put = vi.fn(cache.put.bind(cache));
  vi.stubGlobal("caches", {
    default: { put, match: cache.match.bind(cache), delete: cache.delete.bind(cache) },
  });
  return put;
}

function observeCompletions(
  observe: (resource: string, outcome: string) => void,
  acquire?: (resource: string) => void,
) {
  return new Proxy(env.POOL_COORDINATOR, {
    get(target, key) {
      if (key === "get")
        return (...args: Parameters<typeof target.get>) => {
          const stub = target.get(...args);
          return new Proxy(stub, {
            get(real, method) {
              if (method === "acquirePublication")
                return (resource: string) => {
                  acquire?.(resource);
                  return real.acquirePublication(resource);
                };
              if (method === "completePublication")
                return async (...values: Parameters<typeof real.completePublication>) => {
                  const result = await real.completePublication(...values);
                  observe(values[0].resource_key, values[1]);
                  return result;
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

async function permits() {
  return runInDurableObject(backendAdmissionStub(env, POOL), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM backend_permits").toArray(),
  );
}

async function expectNoBodyPublication(put: MockInstance<Cache["put"]>, outcomes: string[]) {
  expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM cache_publication_owners").first("n"),
  ).toBe(0);
  expect(await env.ACTIONS_LOGS.list()).toMatchObject({ objects: [] });
  const namespaces = put.mock.calls.map(([request]) => new URL((request as Request).url).pathname);
  expect(namespaces.some((name) => name.includes(GITHUB_EDGE_CACHE_NAMESPACE))).toBe(false);
  expect(outcomes.length).toBeGreaterThan(0);
  expect(outcomes.every((outcome) => outcome === "failed")).toBe(true);
  expect(await permits()).toEqual([]);
}

function holdUpstreams(resource: (signal: AbortSignal) => Response | Promise<Response>) {
  const guardStarted = ownedWork.gate();
  const fetchStarted = ownedWork.gate();
  const guard = ownedWork.gate();
  let verdict = jsonResponse({ private: false });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const token = bearer(input, init);
    if (token === "test-org-token") {
      guardStarted.release();
      await guard.promise;
      return verdict;
    }
    if (token === "test-primary-token") {
      fetchStarted.release();
      return resource(new Request(input, init).signal);
    }
    return jsonResponse({ message: "anonymous unavailable" }, 503);
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    started: Promise.all([guardStarted.promise, fetchStarted.promise]),
    finish(response = jsonResponse({ private: false })) {
      verdict = response;
      guard.release();
    },
  };
}

describe("pooled miss public guard overlap", () => {
  it("starts the pooled fetch before the guard resolves and preserves the happy response", async () => {
    await seedPool();
    const put = trackCacheWrites();
    const upstream = holdUpstreams(() => jsonResponse(body, 200, { etag: '"synthetic"' }));
    let settled = false;
    const response = relay(path).then((result) => {
      settled = true;
      return result;
    });
    await upstream.started;
    expect(settled).toBe(false);
    expect(await permits()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(
      0,
    );
    upstream.finish();
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      status: 200,
      headers: { "content-type": "application/json", etag: '"synthetic"' },
      body,
      body_encoding: "json",
      identity: { id: "primary", kind: "pat" },
      relay: {
        pool: POOL,
        request_id: expect.any(String),
        cacheable: true,
        cache: "miss",
        stale_ok: false,
        route_kind: "check_run_annotations",
        lease_reason: "highest_remaining",
      },
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(
      1,
    );
    expect(
      put.mock.calls.some(([request]) =>
        new URL(new Request(request).url).pathname.includes(GITHUB_EDGE_CACHE_NAMESPACE),
      ),
    ).toBe(true);
    expect(await permits()).toEqual([]);
  });

  it.each([
    ["private", () => jsonResponse({ private: true }), "repo_not_public"],
    ["inconclusive", () => jsonResponse({ message: "denied" }, 403), "repo_public_check_failed"],
  ] as const)(
    "discards a successful upstream on %s guard failure without publication",
    async (_name, verdict, reason) => {
      await seedPool();
      const put = trackCacheWrites();
      const outcomes: string[] = [];
      const coordinator = observeCompletions((resource, outcome) => {
        if (resource.startsWith("cache:")) outcomes.push(outcome);
      });
      const upstream = holdUpstreams(() =>
        jsonResponse(body, 200, { ...rateHeaders({ remaining: 4999 }), etag: '"private-etag"' }),
      );
      const response = requestWithEnv({ POOL_COORDINATOR: coordinator }, path, {});
      await upstream.started;
      upstream.finish(verdict());
      const result = await response.catch((error: unknown) => error);
      await expectNoBodyPublication(put, outcomes);
      if (!(result instanceof Response)) throw result;
      expect(result.status).toBe(424);
      const text = await result.text();
      expect(JSON.parse(text)).toMatchObject({
        error: { code: "fallback_local", details: { reason } },
      });
      expect(text).not.toContain("synthetic pooled response");
      expect(text).not.toContain("private-etag");
      expect(result.headers.has("etag")).toBe(false);
      expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toEqual([
        expect.objectContaining({ identity_id: "primary", remaining: 4999 }),
      ]);
    },
  );

  it.each(["transport", "503", "403", "429"])(
    "returns the guard error when upstream also fails (%s)",
    async (kind) => {
      await seedPool();
      const upstream = holdUpstreams(() => {
        if (kind === "transport") throw new TypeError("fetch failed: synthetic upstream failure");
        return jsonResponse(
          { message: "You have exceeded a secondary rate limit" },
          Number(kind),
          rateHeaders({ remaining: 0, retryAfter: 60 }),
        );
      });
      const response = relay(path);
      await upstream.started;
      upstream.finish(jsonResponse({ private: true }));
      const result = await response;
      expect(result.status).toBe(424);
      expect(await result.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "repo_not_public" } },
      });
      expect(await permits()).toEqual([]);
      expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual([]);
    },
  );

  it("preserves the upstream error response when the guard succeeds", async () => {
    await seedPool();
    const failure = { message: "synthetic upstream failure" };
    const upstream = holdUpstreams(() => jsonResponse(failure, 503));
    const response = relay(path);
    await upstream.started;
    upstream.finish();
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: 503,
      body: failure,
      identity: { id: "primary" },
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(
      0,
    );
  });

  it("cancels a held pooled fetch and releases admission as soon as the guard rejects", async () => {
    await seedPool();
    const resource = ownedWork.gate();
    let signal: AbortSignal | undefined;
    const upstream = holdUpstreams((current) => {
      signal = current;
      return new Promise<Response>((resolve, reject) => {
        current.addEventListener("abort", () => reject(current.reason), { once: true });
        void resource.promise.then(() => resolve(jsonResponse(body)));
      });
    });
    const response = relay(path);
    await upstream.started;
    upstream.finish(jsonResponse({ private: true }));
    await expect.poll(() => signal?.aborted).toBe(true);
    expect(await (await response).json()).toMatchObject({
      error: { details: { reason: "repo_not_public" } },
    });
    expect(await permits()).toEqual([]);
    expect((await poolCoordinatorStub(env, POOL).snapshot()).cooldowns).toEqual([]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(
      0,
    );
  });

  it("allows only the public-proof owner to dispatch before a shared denial", async () => {
    await seedPool();
    const joined = ownedWork.gate();
    let acquisitions = 0;
    const coordinator = observeCompletions(
      () => {},
      (resource) => {
        if (resource.startsWith("public-repo:") && ++acquisitions === 3) joined.release();
      },
    );
    const upstream = holdUpstreams(() => jsonResponse(body));
    const requests = [requestWithEnv({ POOL_COORDINATOR: coordinator }, path, {})];
    await upstream.started;
    requests.push(
      ...[43, 44].map((id) =>
        requestWithEnv({ POOL_COORDINATOR: coordinator }, path.replace("42", String(id)), {}),
      ),
    );
    await joined.promise;
    upstream.finish(jsonResponse({ private: true }));
    for (const response of await Promise.all(requests)) {
      expect(await response.json()).toMatchObject({
        error: { details: { reason: "repo_not_public" } },
      });
    }
    expect(
      upstream.fetcher.mock.calls.filter(
        ([input, init]) => bearer(input, init) === "test-primary-token",
      ),
    ).toHaveLength(1);
    expect(await permits()).toEqual([]);
  });

  it("does not dispatch a pooled read after a delayed identity selection resumes", async () => {
    await seedPool();
    const selected = ownedWork.gate();
    const resume = ownedWork.gate();
    let signal: AbortSignal | undefined;
    const real = poolCoordinatorStub(env, POOL);
    const coordinator = new Proxy(env.POOL_COORDINATOR, {
      get(target, key) {
        if (key === "get")
          return (...args: Parameters<typeof target.get>) => {
            const stub = target.get(...args);
            return new Proxy(stub, {
              get(current, method) {
                if (method === "selectIdentity")
                  return async (...values: Parameters<typeof real.selectIdentity>) => {
                    signal = backendWorkSignal();
                    selected.release();
                    await resume.promise;
                    return current.selectIdentity(...values);
                  };
                const value = Reflect.get(current, method, current);
                return typeof value === "function"
                  ? (...values: unknown[]) => Reflect.apply(value, current, values)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const upstream = holdUpstreams(() => jsonResponse(body));
    const response = requestWithEnv({ POOL_COORDINATOR: coordinator }, path, {});
    await selected.promise;
    upstream.finish(jsonResponse({ private: true }));
    await expect.poll(() => signal?.aborted).toBe(true);
    resume.release();
    expect(await (await response).json()).toMatchObject({
      error: { details: { reason: "repo_not_public" } },
    });
    expect(
      upstream.fetcher.mock.calls.some(
        ([input, init]) => bearer(input, init) === "test-primary-token",
      ),
    ).toBe(false);
    expect(await permits()).toEqual([]);
  });

  it("rejects a fresh negative edge proof without starting a pooled fetch", async () => {
    await seedPool();
    await writeEdgeJSON(
      PUBLIC_PROOF_EDGE_NAMESPACE,
      "openclaw/octopool",
      {
        protocol_epoch: CACHE_PUBLICATION_EPOCH,
        is_public: false,
        checked_at: sqliteTimestamp(Date.now()),
        expires_at: sqliteTimestamp(Date.now() + 60_000),
        publication_id: 1,
        publication_token: "synthetic-proof",
      },
      60,
    );
    const upstream = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: "anonymous unavailable" }, 503),
    );
    vi.stubGlobal("fetch", upstream);
    const result = await relay(path);
    expect(result.status).toBe(424);
    expect(await result.json()).toMatchObject({
      error: { details: { reason: "repo_not_public" } },
    });
    expect(
      upstream.mock.calls.some(([input, init]) => bearer(input, init) === "test-primary-token"),
    ).toBe(false);
    expect(await permits()).toEqual([]);
  });
});
