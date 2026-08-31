import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { ensurePool, loadPoolPolicy } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { seedPublicRepoProof as recordPublicGitHubRepo } from "./cache-publication-fixture";
import { malformedStoredPolicies, restrictivePolicy } from "../fixtures/stored-policy";
import {
  bearer,
  CALLER_TOKEN,
  callWarmWorker,
  callWorker,
  jsonResponse,
  POOL,
  rateHeaders,
  relay,
  seedPool,
} from "./harness";

const CHECK_PATH =
  "/repos/openclaw/octopool/commits/0123456789abcdef0123456789abcdef01234567/check-runs";
const LOG_PATH = "/repos/elsewhere/octopool/actions/jobs/42/logs";
const CACHE_BODY = { total_count: 1, check_runs: [{ id: 7, name: "cached-policy-fixture" }] };
const LIVE_BODY = { total_count: 1, check_runs: [{ id: 8, name: "pooled-policy-fixture" }] };

async function storePolicy(raw: string): Promise<void> {
  await env.DB.prepare("UPDATE pools SET policy_json = ? WHERE id = ?").bind(raw, POOL).run();
}

async function seedCachedChecks(path = CHECK_PATH): Promise<string> {
  const request = { pool: POOL, method: "GET", path };
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  await recordPublicGitHubRepo(env, route);
  const key = await githubCacheKey(POOL, request, route);
  expect(
    await writeGitHubCache(env, key, request, route, {
      status: 200,
      headers: {},
      body: CACHE_BODY,
      body_encoding: "json",
    }),
  ).toBe("shared");
  return key;
}

function mockUpstream() {
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
    if (bearer(request) === "test-primary-token") {
      if (new URL(request.url).pathname.endsWith("/logs")) {
        return new Response("pooled-log-fixture", { headers: rateHeaders({ remaining: 4_999 }) });
      }
      return jsonResponse(LIVE_BODY, 200, rateHeaders({ remaining: 4_999 }));
    }
    return jsonResponse({ message: "synthetic public backend unavailable" }, 503);
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

async function expectUnavailable(response: Response): Promise<void> {
  expect.soft(response.status).toBe(503);
  expect.soft(response.headers.get("cache-control")).toBe("no-store");
  expect.soft(await response.json()).toEqual({
    error: {
      code: "pool_policy_unavailable",
      message: "Pool policy is unavailable",
      request_id: expect.any(String),
    },
  });
}

async function coordinatorSnapshot() {
  return runInDurableObject(poolCoordinatorStub(env, POOL), (instance) => instance.snapshot());
}

function warmRelay(): Promise<Response> {
  return callWarmWorker("/v1/github/request", {
    method: "POST",
    headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ pool: POOL, method: "GET", path: CHECK_PATH }),
  });
}

describe("Worker stored pool policy", () => {
  beforeEach(async () => {
    // The real table fixture has a fresh identity-bound membership timestamp.
    await seedPool();
    await storePolicy(JSON.stringify(restrictivePolicy));
  });

  it.each(malformedStoredPolicies)(
    "rejects $name before edge/shared cache or pooled dispatch",
    async ({ raw }) => {
      const key = await seedCachedChecks();
      await storePolicy(raw);
      const upstream = mockUpstream();
      const edgeMatch = vi.spyOn(caches.default, "match");
      await expectUnavailable(await relay(CHECK_PATH));
      await deleteEdgeJSON("github-publication-v1", key);
      await expectUnavailable(await relay(CHECK_PATH));
      await expectUnavailable(
        await relay(CHECK_PATH, CALLER_TOKEN, { headers: { "if-none-match": '"miss"' } }),
      );
      expect.soft(upstream).not.toHaveBeenCalled();
      expect.soft(edgeMatch).not.toHaveBeenCalled();
      expect.soft(await coordinatorSnapshot()).toEqual({ leases: [], rates: [], cooldowns: [] });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual({
        count: 0,
      });
    },
  );

  it("rejects corrupted restrictive policy instead of enabling public-owner cache and pooled logs", async () => {
    const outsidePath = CHECK_PATH.replace("/openclaw/", "/elsewhere/");
    await seedCachedChecks(outsidePath);
    await env.DB.prepare(
      "INSERT INTO identity_scopes (identity_id, owner, permission, allow_private) VALUES ('primary', '*', 'read', 0)",
    ).run();
    const upstream = mockUpstream();
    for (const [path, reason] of [
      [outsidePath, "owner_denied"],
      [LOG_PATH, "logs_denied"],
    ] as const) {
      const denied = await relay(path);
      expect(denied.status).toBe(424);
      expect(await denied.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason } },
      });
    }
    expect(upstream).not.toHaveBeenCalled();
    await storePolicy('{"private-policy-marker":');
    await expectUnavailable(await relay(outsidePath));
    await expectUnavailable(
      await relay(LOG_PATH, CALLER_TOKEN, { headers: { "if-none-match": '"miss"' } }),
    );
    expect.soft(upstream).not.toHaveBeenCalled();
    expect(await coordinatorSnapshot()).toEqual({ leases: [], rates: [], cooldowns: [] });
  });

  it.each([
    { name: "complete restrictive", raw: JSON.stringify(restrictivePolicy) },
    { name: "partial", raw: '{"allow_public_repos":false}' },
    { name: "empty object", raw: "{}" },
  ])("serves valid $name policy through cache and pooled paths", async ({ raw }) => {
    await storePolicy(raw);
    await seedCachedChecks();
    const upstream = mockUpstream();
    const cached = await relay(CHECK_PATH);
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({ body: CACHE_BODY, relay: { cache: "hit" } });
    expect(upstream).not.toHaveBeenCalled();
    const live = await relay(CHECK_PATH, CALLER_TOKEN, { headers: { "if-none-match": '"miss"' } });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      body: LIVE_BODY,
      identity: { id: "primary" },
      relay: { cache: "bypass" },
    });
    expect((await coordinatorSnapshot()).leases).toHaveLength(1);
  });

  it("keeps local authentication ahead of stored-policy errors", async () => {
    await storePolicy("null");
    const upstream = mockUpstream();
    const missing = await callWorker("/v1/github/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: POOL, method: "GET", path: CHECK_PATH }),
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: "missing_auth" } });
    const invalid = await relay(CHECK_PATH, "invalid-caller");
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_auth" } });
    await env.DB.prepare("DELETE FROM caller_pools").run();
    const ungranted = await relay(CHECK_PATH);
    expect(ungranted.status).toBe(401);
    expect(await ungranted.json()).toMatchObject({ error: { code: "invalid_auth" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("creates defaults only for a new pool and never overwrites corrupt existing storage", async () => {
    await ensurePool(env, "new-pool");
    await expect(loadPoolPolicy(env, "new-pool")).resolves.toEqual(
      defaultPolicy(env.DEFAULT_ALLOWED_OWNERS),
    );
    await storePolicy("null");
    await ensurePool(env, POOL);
    const upstream = mockUpstream();
    await expectUnavailable(await relay(CHECK_PATH));
    expect(
      await env.DB.prepare("SELECT policy_json FROM pools WHERE id = ?").bind(POOL).first(),
    ).toEqual({ policy_json: "null" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("recovers a failed cold lookup immediately after storage is repaired", async () => {
    await seedCachedChecks();
    await storePolicy("[]");
    const upstream = mockUpstream();
    await expectUnavailable(await relay(CHECK_PATH));
    await expectUnavailable(await warmRelay());
    await storePolicy("{}");
    const repaired = await warmRelay();
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ body: CACHE_BODY, relay: { cache: "hit" } });
    expect(upstream).not.toHaveBeenCalled();
    expect(await coordinatorSnapshot()).toEqual({ leases: [], rates: [], cooldowns: [] });
  });

  it("preserves caller-owned native fallback for valid policies and reports corrupt policy as unavailable", async () => {
    const path = "/repos/openclaw/octopool/rules/branches/main";
    const upstream = mockUpstream();
    const valid = await relay(path);
    expect(valid.status).toBe(424);
    expect(await valid.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "local_credentials_required" } },
    });
    await storePolicy("null");
    await expectUnavailable(await relay(path));
    expect(upstream).not.toHaveBeenCalled();
    expect(await coordinatorSnapshot()).toEqual({ leases: [], rates: [], cooldowns: [] });
  });

  it("retains global string protection before pool failure and native fallback", async () => {
    await storePolicy("null");
    const upstream = mockUpstream();
    await env.DB.prepare("UPDATE string_rewrite_policy SET rules_json = ?")
      .bind('[{"pattern":"octopool","replacement":"public"}]')
      .run();
    const denied = await relay(CHECK_PATH);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    await env.DB.prepare("DELETE FROM string_rewrite_policy").run();
    const unavailable = await relay("/repos/openclaw/octopool/rules/branches/main");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "string_rewrite_policy_unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("retains the 30-second valid-policy window, then rejects corruption and recovers without caching failure", async () => {
    await seedCachedChecks();
    const upstream = mockUpstream();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect((await relay(CHECK_PATH)).status).toBe(200);
    await storePolicy("null");
    clock.mockReturnValue(now + 29_999);
    expect((await warmRelay()).status).toBe(200);
    clock.mockReturnValue(now + 30_000);
    await expectUnavailable(await warmRelay());
    await expectUnavailable(await warmRelay());
    await storePolicy('{"allowed_owners":[],"allow_public_repos":false}');
    const repaired = await warmRelay();
    expect(repaired.status).toBe(424);
    expect(await repaired.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "owner_denied" } },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(await coordinatorSnapshot()).toEqual({ leases: [], rates: [], cooldowns: [] });
  });
});
