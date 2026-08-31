import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_EDGE_CACHE_NAMESPACE,
  githubCacheKey,
  writeGitHubCache,
  type CachedGitHubResponse,
} from "../../src/cache";
import { CACHE_PUBLICATION_EPOCH, bodyPublicationResource } from "../../src/cache-publication";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON, readEdgeJSON, writeEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { bearer, jsonResponse, POOL, rateHeaders, relay, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

const STATS = ["contributors", "commit_activity", "code_frequency", "participation", "punch_card"];
const pathFor = (kind: string) => `/repos/openclaw/octopool/stats/${kind}`;

describe("Worker repository statistics cache lifecycle", () => {
  // Behavior: pending polls progress. Regression/gap: generic 2xx storage pinned 202 for an hour.
  // Native requests, D1 and Cache API observe publication; no production test seam.
  it.each(STATS)("does not store pending %s and lets the next poll reach ready", async (kind) => {
    await seedPool();
    const path = pathFor(kind);
    let calls = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.github.com${path}`);
      expect(bearer(request)).toBeUndefined();
      calls++;
      return jsonResponse(calls === 1 ? {} : [1, 2, 3], calls === 1 ? 202 : 200, {
        ...rateHeaders({ remaining: 59 }),
        etag: calls === 1 ? '"pending"' : '"ready"',
      });
    });
    vi.stubGlobal("fetch", upstream);
    const request = { pool: POOL, method: "GET" as const, path };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const key = await githubCacheKey(POOL, request, route);

    const pending = await relay(path);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      status: 202,
      body: {},
      body_encoding: "json",
      headers: { etag: '"pending"' },
      relay: { cache: "miss", backend: "web", cacheable: true },
    });
    expect(await env.DB.prepare("SELECT status FROM github_cache_entries").all()).toMatchObject({
      results: [],
    });
    expect(await readEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key)).toBeUndefined();
    expect(await env.DB.prepare("SELECT id FROM cache_publication_owners").all()).toMatchObject({
      results: [],
    });
    expect(await env.DB.prepare("SELECT is_public FROM github_public_repo_proofs").first()).toEqual(
      {
        is_public: 1,
      },
    );
    expect(await (await relay(path)).json()).toMatchObject({
      status: 200,
      body: [1, 2, 3],
      relay: { cache: "miss" },
    });
    expect(await (await relay(path)).json()).toMatchObject({
      status: 200,
      body: [1, 2, 3],
      relay: { cache: "hit" },
    });
    expect(calls).toBe(2);
  });

  // Behavior: even late current-epoch legacy pending data cannot be served or validated.
  // Gap: fresh/identity/age/stale readers used to accept it. Real persisted ready receipts
  // are converted into frozen legacy rows, independently of the new writer predicate.
  it.each([
    ["edge", "etag"],
    ["shared", "etag"],
    ["identity", "etag"],
    ["max-age=0", "etag"],
    ["max-age=20", "last-modified"],
    ["stale", "etag"],
    ["stale", "last-modified"],
  ] as const)("refuses legacy pending %s with %s", async (mode, validator) => {
    await seedPool();
    const request = { pool: POOL, method: "GET" as const, path: pathFor("commit_activity") };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const identity = mode === "identity" ? (await loadIdentities(env, POOL, route))[0] : undefined;
    const key = await githubCacheKey(POOL, request, route, identity);
    await seedPublicRepoProof(env, route);
    expect(
      await writeOwnedGitHubCache(
        env,
        key,
        request,
        route,
        {
          status: 200,
          body: [7],
          headers: {
            ...rateHeaders({ remaining: 59 }),
            [validator]: validator === "etag" ? '"legacy"' : "Mon, 31 Aug 2026 00:00:00 GMT",
          } as Record<string, string>,
        },
        identity,
      ),
    ).toBe("shared");
    await makeLegacyPending(key);
    if (mode === "stale") await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
    if (mode !== "edge") await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
    if (mode === "stale" || mode.startsWith("max-age")) {
      await env.DB.prepare(`UPDATE github_cache_entries
        SET created_at = datetime('now', '-180 seconds'), expires_at = datetime('now', '-1 second')
        WHERE cache_key = ?`)
        .bind(key)
        .run();
    }
    let resourceCalls = 0;
    let validators = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const upstream = new Request(input, init);
        if (bearer(upstream) === "test-org-token") return jsonResponse({ private: false });
        expect(upstream.url).toBe(`https://api.github.com${request.path}`);
        resourceCalls++;
        if (upstream.headers.has("if-none-match") || upstream.headers.has("if-modified-since")) {
          validators++;
          return new Response(null, { status: 304, headers: rateHeaders({ remaining: 59 }) });
        }
        if (mode === "stale" || (mode === "identity" && bearer(upstream) === undefined)) {
          return jsonResponse({ message: "unavailable" }, 503);
        }
        return jsonResponse([8], 200, rateHeaders({ remaining: 59 }));
      }),
    );
    const result = await relay(request.path, undefined, {
      headers: mode.startsWith("max-age") ? { "cache-control": mode } : {},
    });
    if (mode === "stale") {
      expect(result.status).toBe(424);
    } else {
      expect(await result.json()).toMatchObject({
        status: 200,
        body: [8],
        relay: { cache: "miss" },
      });
    }
    expect(validators).toBe(0);
    expect(resourceCalls).toBeGreaterThan(0);
  });

  // Behavior: a real waiting request reacquires after intentional nonpublication.
  // Regression: the old shared notification served the leader's pending body. Only
  // fetch is gated; scalar native DO state establishes registration, with owned drains.
  it("serializes a pending leader and lets its follower fetch ready", async () => {
    await seedPool();
    const path = pathFor("contributors");
    const entered = ownedWork.gate();
    const gate = ownedWork.gate();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        expect(new Request(input, init).url).toBe(`https://api.github.com${path}`);
        calls++;
        if (calls === 1) {
          entered.release();
          await gate.promise;
          return jsonResponse({}, 202, rateHeaders({ remaining: 59 }));
        }
        return jsonResponse([9], 200, rateHeaders({ remaining: 59 }));
      }),
    );
    const leader = relay(path);
    const requests = [leader];
    try {
      await entered.promise;
      const follower = relay(path);
      requests.push(follower);
      await waitForFollower(follower);
      expect(calls).toBe(1);
      gate.release();
      expect(await (await leader).json()).toMatchObject({
        status: 202,
        body: {},
        relay: { cache: "miss" },
      });
      expect(await (await follower).json()).toMatchObject({
        status: 200,
        body: [9],
        relay: { cache: "miss" },
      });
      expect(calls).toBe(2);
      expect(await env.DB.prepare("SELECT status FROM github_cache_entries").first()).toEqual({
        status: 200,
      });
    } finally {
      gate.release();
      await Promise.allSettled(requests);
    }
  });

  // Behavior: a late old writer's completed shared result is still rejected by followers.
  // Gap: a publication notification alone says nothing about status eligibility. A real
  // owner writes ready data, then the fixture freezes legacy 202 before actual completion.
  it("rejects a late legacy pending publication after a follower registered", async () => {
    await seedPool();
    const request = { pool: POOL, method: "GET" as const, path: pathFor("contributors") };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const key = await githubCacheKey(POOL, request, route);
    await seedPublicRepoProof(env, route);
    const coordinator = poolCoordinatorStub(env, POOL);
    const owner = (await coordinator.tryAcquirePublication(bodyPublicationResource(key)))!;
    const follower = relay(request.path);
    try {
      await waitForFollower(follower);
      expect(
        await writeGitHubCache(
          env,
          key,
          request,
          route,
          {
            status: 200,
            body: [1],
            headers: rateHeaders({ remaining: 59 }) as Record<string, string>,
          },
          owner,
        ),
      ).toBe("shared");
      await makeLegacyPending(key);
      const upstream = vi.fn(async () => jsonResponse([2], 200, rateHeaders({ remaining: 59 })));
      vi.stubGlobal("fetch", upstream);
      expect(await coordinator.completePublication(owner, "shared", owner.id)).toBe(true);
      expect(await (await follower).json()).toMatchObject({
        status: 200,
        body: [2],
        relay: { cache: "miss" },
      });
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.completePublication(owner, "failed");
      await Promise.allSettled([follower]);
    }
  });

  // Behavior: forced pending leaves ready bytes and original lifetime intact.
  // Regression: 202 used to overwrite/renew the row. Advancing metadata Date together
  // makes lifetime extension observable; timers and native D1 clocks remain real.
  it("keeps the ready publication unchanged after a forced pending response", async () => {
    await seedPool();
    const path = pathFor("participation");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(`https://api.github.com${path}`);
        calls++;
        if (calls === 2) {
          expect(request.headers.get("if-none-match")).toBe('"ready"');
          return jsonResponse({}, 202, { etag: '"pending"', ...rateHeaders({ remaining: 59 }) });
        }
        return jsonResponse([3], 200, { etag: '"ready"', ...rateHeaders({ remaining: 59 }) });
      }),
    );
    await relay(path);
    const before = await env.DB.prepare("SELECT * FROM github_cache_entries").first<{
      cache_key: string;
    }>();
    const edgeBefore = await readEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, before!.cache_key);
    const later = Date.now() + 10_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(later);
    try {
      expect(
        await (await relay(path, undefined, { headers: { "cache-control": "max-age=0" } })).json(),
      ).toMatchObject({
        status: 202,
        body: {},
        headers: { etag: '"pending"' },
        relay: { cache: "miss" },
      });
      expect(await env.DB.prepare("SELECT * FROM github_cache_entries").first()).toEqual(before);
      expect(await readEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, before!.cache_key)).toEqual(
        edgeBefore,
      );
      expect(await (await relay(path)).json()).toMatchObject({
        status: 200,
        body: [3],
        relay: { cache: "hit" },
      });
      expect(calls).toBe(2);
    } finally {
      await ownedWork.drain();
      vi.useRealTimers();
    }
  });

  // Behavior: intentional nonpublication revokes only its exact owner, never invents
  // a data ID, and expired cleanup cannot signal live completion. Native D1/RPC
  // receipts cover the new outcome without mocking ownership decisions.
  it.each([false, true])("completes no-store truthfully with expired=%s", async (expired) => {
    await seedPool();
    const request = { pool: POOL, method: "GET" as const, path: pathFor("contributors") };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const key = await githubCacheKey(POOL, request, route);
    const coordinator = poolCoordinatorStub(env, POOL);
    const owner = (await coordinator.tryAcquirePublication(bodyPublicationResource(key)))!;
    const follower = ownedWork.track(coordinator.acquirePublication(owner.resource_key));
    try {
      await waitForFollower(follower);
      expect(
        await writeGitHubCache(
          env,
          key,
          request,
          route,
          { status: 202, headers: {}, body: {} },
          owner,
        ),
      ).toBe("none");
      // Catch invalid arguments inside the native DO, not across the long-lived
      // Runner RPC lifetime. Valid completion and waiter delivery below remain RPCs.
      await runInDurableObject(coordinator, async (instance) => {
        await expect(instance.completePublication(owner, "none", owner.id)).rejects.toThrow(
          "Invalid publication completion",
        );
      });
      expect(
        await coordinator.completePublication({ ...owner, owner_token: "wrong-token" }, "none"),
      ).toBe(false);
      if (expired)
        await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?")
          .bind(owner.id)
          .run();
      expect(await coordinator.completePublication(owner, "none")).toBe(!expired);
      expect(await follower).toEqual(
        expired ? { kind: "retry" } : { kind: "completed", outcome: "none" },
      );
      expect(
        await env.DB.prepare("SELECT id FROM cache_publication_owners WHERE id = ?")
          .bind(owner.id)
          .first(),
      ).toBeNull();
      expect(await env.DB.prepare("SELECT status FROM github_cache_entries").first()).toBeNull();
      expect(await readEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key)).toBeUndefined();
      const next = (await coordinator.tryAcquirePublication(owner.resource_key))!;
      expect(next.id).toBeGreaterThan(owner.id);
      expect(await coordinator.completePublication(owner, "none")).toBe(false);
      expect(await coordinator.renewPublication(next)).toBe(true);
      await coordinator.completePublication(next, "failed");
    } finally {
      await coordinator.completePublication(owner, "failed");
      await Promise.allSettled([follower]);
    }
  });

  // Behavior: caller conditionals retain exact responses and bypass all body storage.
  // Gap: statistics-specific no-store must not change the existing conditional contract.
  // Real relay requests and row snapshots exercise both validator headers without a seam.
  it.each(["if-none-match", "if-modified-since"])(
    "preserves caller %s for pending statistics",
    async (header) => {
      await seedPool();
      const path = pathFor("code_frequency");
      const value = header === "if-none-match" ? '"caller"' : "Mon, 31 Aug 2026 00:00:00 GMT";
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
        expect(request.headers.get(header)).toBe(value);
        return jsonResponse({}, 202, { etag: '"pending"', ...rateHeaders({ remaining: 59 }) });
      });
      vi.stubGlobal("fetch", upstream);
      expect(
        await (await relay(path, undefined, { headers: { [header]: value } })).json(),
      ).toMatchObject({
        status: 202,
        body: {},
        body_encoding: "json",
        relay: { cache: "bypass" },
      });
      expect(await env.DB.prepare("SELECT status FROM github_cache_entries").first()).toBeNull();
    },
  );

  // Behavior: ready statistics still revalidate and use bounded outage stale fallback.
  // The status rejection must not retire valid data. Real fills/expiry fixtures exercise
  // both allowed reuse and a caller age bound, without new production hooks.
  it.each(["304", "outage", "bounded-outage"])(
    "preserves ready statistics through %s",
    async (mode) => {
      await seedPool();
      const path = pathFor("commit_activity");
      let primed = false;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") {
            expect(request.url).toBe("https://api.github.com/repos/openclaw/octopool");
            return jsonResponse({ private: false });
          }
          expect(request.url).toBe(`https://api.github.com${path}`);
          if (!primed)
            return jsonResponse([4], 200, { etag: '"ready"', ...rateHeaders({ remaining: 59 }) });
          if (mode === "304") {
            expect(request.headers.get("if-none-match")).toBe('"ready"');
            return new Response(null, { status: 304, headers: rateHeaders({ remaining: 59 }) });
          }
          return jsonResponse({ message: "unavailable" }, 503);
        }),
      );
      await relay(path);
      primed = true;
      const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").first<{
        cache_key: string;
      }>();
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime('now', '-180 seconds'), expires_at = datetime('now', '-1 second')",
      ).run();
      await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
      await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
      const result = await relay(path, undefined, {
        headers: mode === "bounded-outage" ? { "cache-control": "max-age=20" } : {},
      });
      if (mode === "bounded-outage") expect(result.status).toBe(424);
      else
        expect(await result.json()).toMatchObject({
          status: 200,
          body: [4],
          relay: { cache: mode === "304" ? "hit" : "stale" },
        });
    },
  );

  // Behavior: only stats 202 changes. Native ready/empty/negative responses preserve
  // the existing success gate and payload encoding; no private predicate oracle.
  it.each([
    [pathFor("punch_card"), 200],
    [pathFor("punch_card"), 204],
    [pathFor("punch_card"), 404],
    [pathFor("punch_card"), 422],
    [pathFor("punch_card"), 500],
    ["/repos/openclaw/octopool/languages", 202],
  ] as const)("preserves %s status %i cache behavior", async (path, status) => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (bearer(input, init) === "test-org-token") return jsonResponse({ private: false });
        return status === 204
          ? new Response(null, { status, headers: rateHeaders({ remaining: 59 }) })
          : jsonResponse([], status, rateHeaders({ remaining: 59 }));
      }),
    );
    const first = await relay(path);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status, body: status === 204 ? null : [] });
    const rows = await env.DB.prepare("SELECT status FROM github_cache_entries").all();
    expect(rows.results).toEqual(status < 300 ? [{ status }] : []);
    if (status < 300)
      expect(await (await relay(path)).json()).toMatchObject({
        status,
        body: status === 204 ? null : [],
        relay: { cache: "hit" },
      });
  });
});

async function makeLegacyPending(key: string): Promise<void> {
  const edge = await readEdgeJSON<CachedGitHubResponse & { protocol_epoch: string }>(
    GITHUB_EDGE_CACHE_NAMESPACE,
    key,
  );
  expect(edge).toMatchObject({ status: 200, protocol_epoch: CACHE_PUBLICATION_EPOCH });
  await env.DB.prepare(
    "UPDATE github_cache_entries SET status = 202, body_json = '{}' WHERE cache_key = ? AND publication_epoch = ?",
  )
    .bind(key, CACHE_PUBLICATION_EPOCH)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT status, publication_id FROM github_cache_entries WHERE cache_key = ?",
    )
      .bind(key)
      .first(),
  ).toMatchObject({ status: 202, publication_id: expect.any(Number) });
  expect(
    await writeEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key, { ...edge, status: 202, body: {} }, 3600),
  ).toBe(true);
}

async function waitForFollower(follower: Promise<unknown>): Promise<void> {
  await Promise.race([
    vi.waitFor(
      async () => {
        const waiting = await runInDurableObject(
          poolCoordinatorStub(env, POOL),
          (instance) =>
            (instance as unknown as { publicationWaiters: Map<string, unknown> }).publicationWaiters
              .size,
        );
        expect(waiting).toBe(1);
      },
      { timeout: 5_000 },
    ),
    follower.then(() => {
      throw new Error("Follower completed before coordinator waiting");
    }),
  ]);
}
