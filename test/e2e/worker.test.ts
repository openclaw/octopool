import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PoolCoordinator } from "../../src/index";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { deleteEdgeJSON } from "../../src/edge-cache";
import type { CoordinatorSnapshot } from "../../src/types";
import {
  bearer,
  callWorker,
  CALLER_TOKEN,
  githubUpstream,
  jsonResponse,
  POOL,
  rateHeaders,
  relay,
  seedAudit,
  seedCaller,
  seedPool,
  seedWebSession,
} from "./harness";
import { ownedWork } from "./owned-work";

type RelayEnvelope = {
  status: number;
  body: unknown;
  identity?: { id: string; kind: string };
  relay: {
    backend?: string;
    cache: string;
    cacheable: boolean;
    coalesced?: boolean;
    route_kind: string;
    stale_ok?: boolean;
    stale_reason?: string;
  };
};

type UsageEnvelope = {
  requests: number;
  errors: number;
  fallbacks: number;
  cache_hits: number;
  cache_misses: number;
  eligible_cache_hit_rate: number | null;
};

type StatsEnvelope = {
  pool: string;
  operator: { github_login: string; client_name: string };
  client_filter?: string;
  pool_usage: UsageEnvelope;
  caller_usage: UsageEnvelope;
  client_usage: UsageEnvelope;
  clients: (UsageEnvelope & { client_name: string })[];
  routes: (UsageEnvelope & { route_kind: string })[];
  caller_routes: (UsageEnvelope & { route_kind: string })[];
  client_routes: (UsageEnvelope & { route_kind: string })[];
  backends: { backend: string; route_kind: string; requests: number }[];
  fallback_reasons: { reason: string; route_kind: string; requests: number }[];
  cache: { total_entries: number };
};

type DashboardEnvelope = {
  pool: string;
  operator: { github_login: string; dashboard_role: string };
  identities: { total: number; active: number };
  usage: {
    requests_24h: number;
    fallbacks_24h: number;
    denied_24h: number;
    cache_hit_rate_24h: number | null;
    eligible_cache_hit_rate_24h: number | null;
  };
  route_usage: { route_kind: string; eligible_cache_hit_rate: number | null }[];
  cache: { total_entries: number };
  coordinator: CoordinatorSnapshot;
};

describe("Worker end-to-end relay", () => {
  it("runs the real Worker, D1 migrations, and Durable Object through cache miss and hit", async () => {
    await seedPool();
    const upstream = githubUpstream({
      primary: jsonResponse({ id: 1, full_name: "openclaw/octopool", private: false }),
    });
    vi.stubGlobal("fetch", upstream);

    const first = await relay("/repos/openclaw/octopool");
    expect(first.status).toBe(200);
    const firstBody = await first.json<RelayEnvelope>();
    expect(firstBody).toMatchObject({
      status: 200,
      body: { id: 1, full_name: "openclaw/octopool", private: false },
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "miss", cacheable: true, route_kind: "repo_view" },
    });

    const second = await relay("/repos/openclaw/octopool");
    expect(second.status).toBe(200);
    const secondBody = await second.json<RelayEnvelope>();
    expect(secondBody).toMatchObject({
      status: 200,
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "hit", cacheable: true, route_kind: "repo_view" },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);

    const audits = await env.DB.prepare(
      "SELECT cache_status, identity_id, backend, route_kind, status FROM audit_events",
    ).all<{
      cache_status: string;
      identity_id: string | null;
      backend: string | null;
      route_kind: string;
      status: number;
    }>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results).toEqual(
      expect.arrayContaining([
        {
          cache_status: "miss",
          identity_id: "primary",
          backend: "github_identity",
          route_kind: "repo_view",
          status: 200,
        },
        {
          cache_status: "hit",
          identity_id: "primary",
          backend: null,
          route_kind: "repo_view",
          status: 200,
        },
      ]),
    );
  });

  it("rejects a cached response from a disabled identity and uses an active replacement", async () => {
    await seedPool({ secondary: true });
    const upstream = githubUpstream({
      primary: jsonResponse({ id: 1, private: false }),
      secondary: jsonResponse({ id: 2, private: false }),
    });
    vi.stubGlobal("fetch", upstream);

    const primed = await relay("/repos/openclaw/octopool");
    expect(primed.status).toBe(200);
    expect(await primed.json<RelayEnvelope>()).toMatchObject({
      body: { id: 1 },
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "miss" },
    });
    await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = 'primary'").run();

    const replacement = await relay("/repos/openclaw/octopool");
    expect(replacement.status).toBe(200);
    expect(await replacement.json<RelayEnvelope>()).toMatchObject({
      body: { id: 2 },
      identity: { id: "secondary", kind: "pat" },
      relay: { cache: "miss", route_kind: "repo_view" },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-secondary-token",
      ),
    ).toHaveLength(1);
    const cacheIdentities = await env.DB.prepare(
      "SELECT identity_id FROM github_cache_entries ORDER BY identity_id",
    ).all<{ identity_id: string }>();
    expect(cacheIdentities.results).toEqual([
      { identity_id: "primary" },
      { identity_id: "secondary" },
    ]);
    const audits = await env.DB.prepare(
      "SELECT identity_id, cache_status, status FROM audit_events ORDER BY rowid",
    ).all<{ identity_id: string; cache_status: string; status: number }>();
    expect(audits.results).toEqual([
      { identity_id: "primary", cache_status: "miss", status: 200 },
      { identity_id: "secondary", cache_status: "miss", status: 200 },
    ]);
  });

  it("retries a rate-limited identity and persists its coordinator cooldown", async () => {
    await seedPool({ secondary: true });
    const upstream = githubUpstream({
      primary: jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      ),
      secondary: jsonResponse(
        { id: 2, full_name: "openclaw/octopool", private: false },
        200,
        rateHeaders({ remaining: 4999 }),
      ),
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      identity: { id: "secondary", kind: "pat" },
      relay: { cache: "miss", route_kind: "repo_view" },
    });
    const tokens = upstream.mock.calls
      .map(([request, init]) => bearer(request, init))
      .filter(Boolean);
    expect(tokens).toContain("test-primary-token");
    expect(tokens).toContain("test-secondary-token");

    const coordinator = poolCoordinatorStub(env, POOL);
    const snapshot = await runInDurableObject(
      coordinator,
      (instance: PoolCoordinator): CoordinatorSnapshot => instance.snapshot(),
    );
    expect(snapshot.cooldowns).toEqual([
      expect.objectContaining({
        identity_id: "primary",
        route_key: "*",
        status: 429,
      }),
    ]);
    expect(snapshot.rates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identity_id: "primary", limit_count: 5000, remaining: 0 }),
        expect.objectContaining({ identity_id: "secondary", limit_count: 5000, remaining: 4999 }),
      ]),
    );
  });

  it("scopes permission 403 cooldowns to the failed route", async () => {
    await seedPool({ secondary: true });
    const routeA = "/repos/openclaw/octopool";
    const routeB = "/repos/openclaw/octopool/issues/42";
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const token = bearer(request);
      if (token === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (token === undefined) {
        return jsonResponse({ message: "public backend unavailable" }, 503);
      }
      if (request.url.endsWith(routeA) && token === "test-primary-token") {
        return jsonResponse(
          { message: "Resource not accessible by integration" },
          403,
          rateHeaders({ remaining: 4_998 }),
        );
      }
      if (request.url.endsWith(routeA) && token === "test-secondary-token") {
        return jsonResponse(
          { id: 7, full_name: "openclaw/octopool", private: false },
          200,
          rateHeaders({ remaining: 4_997 }),
        );
      }
      if (request.url.endsWith(routeB) && token === "test-primary-token") {
        return jsonResponse(
          { id: 42, number: 42, title: "Route-scoped cooldown" },
          200,
          rateHeaders({ remaining: 4_997 }),
        );
      }
      return jsonResponse({ message: "unexpected identity request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const retried = await relay(routeA);
    expect(retried.status).toBe(200);
    expect(await retried.json<RelayEnvelope>()).toMatchObject({
      identity: { id: "secondary", kind: "pat" },
      relay: { route_kind: "repo_view" },
    });

    const unrelated = await relay(routeB);
    expect(unrelated.status).toBe(200);
    expect(await unrelated.json<RelayEnvelope>()).toMatchObject({
      identity: { id: "primary", kind: "pat" },
      relay: { route_kind: "issue_view" },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) =>
          new Request(request, init).url.endsWith(routeA) &&
          bearer(request, init) === "test-secondary-token",
      ),
    ).toHaveLength(1);
    expect(
      upstream.mock.calls.filter(
        ([request, init]) =>
          new Request(request, init).url.endsWith(routeB) &&
          bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE fallback_reason = 'identities_cooling_down'",
      ).first(),
    ).toEqual({ count: 0 });

    const coordinator = poolCoordinatorStub(env, POOL);
    const snapshot = await runInDurableObject(
      coordinator,
      (instance: PoolCoordinator): CoordinatorSnapshot => instance.snapshot(),
    );
    expect(snapshot.cooldowns).toEqual([
      expect.objectContaining({
        identity_id: "primary",
        route_key: "GET /repos/openclaw/octopool",
        status: 403,
      }),
    ]);
  });

  it("serves fresh identity cache before excluding a rate-depleted identity", async () => {
    await seedPool();
    const upstream = githubUpstream({
      primary: jsonResponse(
        { id: 3, full_name: "openclaw/octopool", private: false },
        200,
        rateHeaders({ remaining: 0 }),
      ),
    });
    vi.stubGlobal("fetch", upstream);

    const primed = await relay("/repos/openclaw/octopool");
    expect(primed.status).toBe(200);
    expect(await primed.json<RelayEnvelope>()).toMatchObject({
      body: { id: 3 },
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "miss", route_kind: "repo_view" },
    });

    const cached = await relay("/repos/openclaw/octopool");
    expect(cached.status).toBe(200);
    expect(await cached.json<RelayEnvelope>()).toMatchObject({
      body: { id: 3 },
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "hit", route_kind: "repo_view" },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);
  });

  it("coalesces concurrent cache misses into one authenticated GitHub request", async () => {
    await seedPool();
    let primaryStarted!: () => void;
    const { promise: primaryGate, release: releasePrimary } = ownedWork.gate();
    const started = new Promise<void>((resolve) => {
      primaryStarted = resolve;
    });
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const token = bearer(input, init);
      if (token === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (token === "test-primary-token") {
        primaryStarted();
        await primaryGate;
        return jsonResponse({ id: 3, full_name: "openclaw/octopool", private: false });
      }
      return jsonResponse({ message: "public backend unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const firstPromise = relay("/repos/openclaw/octopool");
    const requests = [firstPromise];
    try {
      await started;
      const secondPromise = relay("/repos/openclaw/octopool");
      requests.push(secondPromise);
      await new Promise((resolve) => setTimeout(resolve, 150));
      releasePrimary();
      const envelopes = await Promise.all(
        [firstPromise, secondPromise].map(async (responsePromise) => {
          const response = await responsePromise;
          expect(response.status).toBe(200);
          return response.json<RelayEnvelope>();
        }),
      );

      expect(envelopes.map(({ relay: result }) => result.cache).sort()).toEqual(["hit", "miss"]);
      // Miniflare may not schedule the follower until the leader has published the cache entry.
      const coalesced = envelopes.some(({ relay: result }) => result.coalesced === true);
      expect(
        upstream.mock.calls.filter(
          ([request, init]) => bearer(request, init) === "test-primary-token",
        ),
      ).toHaveLength(1);
      const audits = await env.DB.prepare(
        "SELECT cache_status, coalesced FROM audit_events ORDER BY cache_status",
      ).all<{ cache_status: string; coalesced: number }>();
      expect(audits.results).toEqual([
        { cache_status: "hit", coalesced: coalesced ? 1 : 0 },
        { cache_status: "miss", coalesced: 0 },
      ]);
    } finally {
      releasePrimary();
      await Promise.allSettled(requests);
    }
  });

  it("serves a stale cache entry when the only identity becomes rate limited", async () => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      githubUpstream({
        primary: jsonResponse({ id: 4, full_name: "openclaw/octopool", private: false }),
      }),
    );
    const primed = await relay("/repos/openclaw/octopool");
    expect(primed.status).toBe(200);
    const cacheRow = await env.DB.prepare(
      "SELECT cache_key FROM github_cache_entries LIMIT 1",
    ).first<{ cache_key: string }>();
    expect(cacheRow).not.toBeNull();
    await env.DB.prepare(
      `UPDATE github_cache_entries
       SET expires_at = datetime('now', '-1 second'),
           stale_expires_at = datetime('now', '+1 hour')
       WHERE cache_key = ?`,
    )
      .bind(cacheRow!.cache_key)
      .run();
    await deleteEdgeJSON("github-v1", cacheRow!.cache_key);
    const limited = githubUpstream({
      primary: jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      ),
    });
    vi.stubGlobal("fetch", limited);

    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: { id: 4, full_name: "openclaw/octopool", private: false },
      identity: { id: "primary", kind: "pat" },
      relay: {
        cache: "stale",
        route_kind: "repo_view",
        stale_ok: true,
        stale_reason: "github_rate_limited",
      },
    });
    expect(
      limited.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);
    const audits = await env.DB.prepare(
      "SELECT cache_status, status FROM audit_events ORDER BY created_at",
    ).all<{ cache_status: string; status: number }>();
    expect(audits.results).toEqual([
      { cache_status: "miss", status: 200 },
      { cache_status: "stale", status: 200 },
    ]);

    const blocked = await relay("/repos/openclaw/octopool");
    expect(blocked.status).toBe(200);
    expect(await blocked.json<RelayEnvelope>()).toMatchObject({
      body: { id: 4, full_name: "openclaw/octopool", private: false },
      identity: { id: "primary", kind: "pat" },
      relay: {
        cache: "stale",
        route_kind: "repo_view",
        stale_ok: true,
        stale_reason: "identities_cooling_down",
      },
    });
    expect(
      limited.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-primary-token",
      ),
    ).toHaveLength(1);
  });

  it("tries another identity before serving stale cache", async () => {
    await seedPool({ secondary: true });
    vi.stubGlobal(
      "fetch",
      githubUpstream({
        primary: jsonResponse({ id: 6, full_name: "openclaw/octopool", private: false }),
      }),
    );
    const primed = await relay("/repos/openclaw/octopool");
    expect(primed.status).toBe(200);
    const cacheRow = await env.DB.prepare(
      "SELECT cache_key FROM github_cache_entries LIMIT 1",
    ).first<{ cache_key: string }>();
    expect(cacheRow).not.toBeNull();
    await env.DB.prepare(
      `UPDATE github_cache_entries
       SET expires_at = datetime('now', '-1 second'),
           stale_expires_at = datetime('now', '+1 hour')
       WHERE cache_key = ?`,
    )
      .bind(cacheRow!.cache_key)
      .run();
    await deleteEdgeJSON("github-v1", cacheRow!.cache_key);

    const upstream = githubUpstream({
      primary: jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      ),
      secondary: jsonResponse(
        { id: 7, full_name: "openclaw/octopool", private: false },
        200,
        rateHeaders({ remaining: 4998 }),
      ),
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { id: 7 },
      identity: { id: "secondary", kind: "pat" },
      relay: { cache: "miss", route_kind: "repo_view" },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-secondary-token",
      ),
    ).toHaveLength(1);
  });

  it("serves stale cache from an earlier identity after all identities fail", async () => {
    await seedPool({ secondary: true });
    vi.stubGlobal(
      "fetch",
      githubUpstream({
        primary: jsonResponse({ id: 8, full_name: "openclaw/octopool", private: false }),
      }),
    );
    const primed = await relay("/repos/openclaw/octopool");
    expect(primed.status).toBe(200);
    const cacheRow = await env.DB.prepare(
      "SELECT cache_key FROM github_cache_entries LIMIT 1",
    ).first<{ cache_key: string }>();
    expect(cacheRow).not.toBeNull();
    await env.DB.prepare(
      `UPDATE github_cache_entries
       SET expires_at = datetime('now', '-1 second'),
           stale_expires_at = datetime('now', '+1 hour')
       WHERE cache_key = ?`,
    )
      .bind(cacheRow!.cache_key)
      .run();
    await deleteEdgeJSON("github-v1", cacheRow!.cache_key);

    const upstream = githubUpstream({
      primary: jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      ),
      secondary: jsonResponse(
        { message: "rate limited" },
        429,
        rateHeaders({ remaining: 0, retryAfter: 60 }),
      ),
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: { id: 8 },
      identity: { id: "primary", kind: "pat" },
      relay: {
        cache: "stale",
        route_kind: "repo_view",
        stale_ok: true,
        stale_reason: "github_rate_limited",
      },
    });
    expect(
      upstream.mock.calls.filter(
        ([request, init]) => bearer(request, init) === "test-secondary-token",
      ),
    ).toHaveLength(1);
  });

  it("serves stale anonymous cache after selected identities become rate limited", async () => {
    await seedPool();
    const publicResponse = {
      type: "file",
      encoding: "base64",
      name: "README.md",
      path: "README.md",
      content: "IyBPY3RvcG9vbAo=",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const token = bearer(input, init);
        if (token === undefined) {
          return jsonResponse(publicResponse);
        }
        return jsonResponse({ message: "unexpected identity request" }, 500);
      }),
    );
    const primed = await relay("/repos/openclaw/octopool/contents/README.md");
    expect(primed.status).toBe(200);
    expect(await primed.json<RelayEnvelope>()).toMatchObject({
      body: publicResponse,
      relay: { backend: "web", cache: "miss" },
    });

    const cacheRow = await env.DB.prepare(
      "SELECT cache_key, identity_id FROM github_cache_entries LIMIT 1",
    ).first<{ cache_key: string; identity_id: string | null }>();
    expect(cacheRow).toMatchObject({ identity_id: null });
    await env.DB.prepare(
      `UPDATE github_cache_entries
       SET expires_at = datetime('now', '-1 second'),
           stale_expires_at = datetime('now', '+1 hour')
       WHERE cache_key = ?`,
    )
      .bind(cacheRow!.cache_key)
      .run();
    await deleteEdgeJSON("github-v1", cacheRow!.cache_key);

    const limited = vi.fn<typeof fetch>(async (input, init) => {
      const token = bearer(input, init);
      const url = new URL(new Request(input, init).url);
      if (token === undefined) {
        if (url.pathname === "/repos/openclaw/octopool") {
          return jsonResponse({ private: false });
        }
        return jsonResponse({ message: "public unavailable" }, 503);
      }
      if (token === "test-primary-token") {
        return jsonResponse(
          { message: "rate limited" },
          429,
          rateHeaders({ remaining: 0, retryAfter: 60 }),
        );
      }
      return jsonResponse({ message: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", limited);

    const response = await relay("/repos/openclaw/octopool/contents/README.md");
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: publicResponse,
      relay: {
        backend: "web",
        cache: "stale",
        stale_ok: true,
        stale_reason: "github_rate_limited",
      },
    });
  });

  it("rejects invalid caller authentication before touching GitHub", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool", "wrong-token");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_auth" } });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("Worker end-to-end read models", () => {
  it("filters client stats within the authenticated caller", async () => {
    await seedPool();
    await seedCaller("other", "other-token", "other");
    await env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES (?, ?, ?, ?)",
    )
      .bind("caller-ci-token", "caller", "unused-ci-hash", "ci-runner")
      .run();
    await seedAudit("request-1", "caller", "repo_view", "miss", 200, {
      backend: "github_web",
    });
    await seedAudit("request-2", "caller", "repo_view", "hit", 200);
    await seedAudit("request-3", "caller", "workflow_run_list", "miss", 200, {
      callerTokenId: "caller-ci-token",
      clientName: "ci-runner",
    });
    await seedAudit("request-4", "caller", "workflow_run_list", "hit", 200, {
      callerTokenId: "caller-ci-token",
      clientName: "ci-runner",
    });
    await seedAudit("request-5", "other", "actions_log", "unknown", 424, {
      errorCode: "fallback_local",
      fallbackReason: "owner_denied",
      cacheable: 0,
    });

    const response = await callWorker(`/v1/pools/${POOL}/stats?since=24h`, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<StatsEnvelope>();
    expect(body).toMatchObject({
      pool: POOL,
      operator: { github_login: "caller", client_name: "test-mac" },
      pool_usage: {
        requests: 5,
        errors: 1,
        fallbacks: 1,
        cache_hits: 2,
        cache_misses: 2,
      },
      caller_usage: {
        requests: 4,
        errors: 0,
        fallbacks: 0,
        cache_hits: 2,
        cache_misses: 2,
      },
      client_usage: {
        requests: 2,
        errors: 0,
        fallbacks: 0,
        cache_hits: 1,
        cache_misses: 1,
      },
      cache: { total_entries: 0 },
    });
    expect(body).not.toHaveProperty("client_filter");
    expect(body.pool_usage.eligible_cache_hit_rate).toBe(0.5);
    expect(body.caller_usage.eligible_cache_hit_rate).toBe(0.5);
    expect(body.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_name: "ci-runner", requests: 2 }),
        expect.objectContaining({ client_name: "test-mac", requests: 2 }),
      ]),
    );
    expect(body.routes.map(({ route_kind }) => route_kind)).toEqual([
      "repo_view",
      "workflow_run_list",
      "actions_log",
    ]);
    expect(body.caller_routes).toEqual([
      expect.objectContaining({ route_kind: "repo_view", requests: 2 }),
      expect.objectContaining({ route_kind: "workflow_run_list", requests: 2 }),
    ]);
    expect(body.client_routes).toEqual([
      expect.objectContaining({ route_kind: "repo_view", requests: 2 }),
    ]);
    expect(body.backends).toEqual([
      expect.objectContaining({ backend: "github_web", route_kind: "repo_view", requests: 1 }),
    ]);
    expect(body.fallback_reasons).toEqual([
      expect.objectContaining({ reason: "owner_denied", route_kind: "actions_log", requests: 1 }),
    ]);

    const filteredResponse = await callWorker(
      `/v1/pools/${POOL}/stats?since=24h&client=ci-runner`,
      { headers: { authorization: `Bearer ${CALLER_TOKEN}` } },
    );
    expect(filteredResponse.status).toBe(200);
    const filtered = await filteredResponse.json<StatsEnvelope>();
    expect(filtered).toMatchObject({
      operator: { github_login: "caller", client_name: "test-mac" },
      client_filter: "ci-runner",
      client_usage: { requests: 2, cache_hits: 1, cache_misses: 1 },
    });
    expect(filtered.client_routes).toEqual([
      expect.objectContaining({ route_kind: "workflow_run_list", requests: 2 }),
    ]);

    const foreignResponse = await callWorker(`/v1/pools/${POOL}/stats?since=24h&client=other-mac`, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    expect(foreignResponse.status).toBe(200);
    const foreign = await foreignResponse.json<StatsEnvelope>();
    expect(foreign).toMatchObject({
      operator: { github_login: "caller", client_name: "test-mac" },
      client_filter: "other-mac",
      client_usage: { requests: 0, cache_hits: 0, cache_misses: 0 },
      client_routes: [],
    });

    const invalidResponse = await callWorker(
      `/v1/pools/${POOL}/stats?since=24h&client=not%20a%20hostname`,
      { headers: { authorization: `Bearer ${CALLER_TOKEN}` } },
    );
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: { code: "client_name_invalid" },
    });
  });

  it("composes the authenticated dashboard from D1 and Durable Object state", async () => {
    await seedPool();
    const session = await seedWebSession();
    await seedAudit("request-1", "caller", "repo_view", "miss", 200);
    await seedAudit("request-2", "caller", "repo_view", "hit", 200);
    await seedAudit("request-3", "caller", "actions_log", "unknown", 424, {
      errorCode: "fallback_local",
      fallbackReason: "owner_denied",
      cacheable: 0,
    });

    const response = await callWorker(`https://octopool.openclaw.ai/v1/dashboard?pool=${POOL}`, {
      headers: { cookie: `octopool_session=${session}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<DashboardEnvelope>();
    expect(body).toMatchObject({
      pool: POOL,
      operator: { github_login: "caller", dashboard_role: "admin" },
      identities: { total: 1, active: 1 },
      usage: {
        requests_24h: 3,
        fallbacks_24h: 0,
        denied_24h: 1,
        cache_hit_rate_24h: 0.5,
        eligible_cache_hit_rate_24h: 0.5,
      },
      cache: { total_entries: 0 },
    });
    expect(body.route_usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route_kind: "repo_view", eligible_cache_hit_rate: 0.5 }),
        expect.objectContaining({
          route_kind: "actions_log",
          eligible_cache_hit_rate: null,
          fallbacks: 0,
        }),
      ]),
    );
    expect(body.coordinator).toEqual({ rates: [], cooldowns: [], leases: [] });
  });
});
