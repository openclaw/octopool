import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { poolHealth } from "../../src/health";
import {
  bearer,
  callWorker,
  CALLER_TOKEN,
  jsonResponse,
  POOL,
  runScheduled,
  seedAudit,
  seedPool,
  seedWebSession,
} from "./harness";

describe("Worker end-to-end control plane", () => {
  it("reports active, disabled, empty, and missing pool health correctly", async () => {
    await seedPool({ secondary: true });
    await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = 'secondary'").run();

    const health = await authenticatedGet(`/v1/pools/${POOL}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      pool: POOL,
      identities_total: 2,
      identities_healthy: 1,
      policy_version: 1,
    });

    await env.DB.batch([
      env.DB.prepare("INSERT INTO pools (id, name, policy_json) VALUES ('empty', 'empty', '{}')"),
      env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES ('caller', 'empty')"),
    ]);
    const empty = await authenticatedGet("/v1/pools/empty/health");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ identities_total: 0, identities_healthy: 0 });

    await expect(poolHealth(env, "missing")).rejects.toMatchObject({
      status: 404,
      code: "pool_not_found",
    });
  });

  it("gates and persists admin identity provisioning with scope replacement", async () => {
    await seedPool();
    const path = `/v1/admin/pools/${POOL}/identities`;
    const body = {
      id: "app",
      kind: "github_app",
      login: "octopool-app",
      secret_ref: "TEST_APP_KEY",
      installation_id: 123,
      weight: 90,
      scopes: [{ owner: "openclaw", repo: "octopool", allow_private: true }],
    };

    const unauthenticated = await postJSON(path, body);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "missing_auth" } });

    const created = await postJSON(path, body, "test-admin-token");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      identity: { id: "app", kind: "github_app", installation_id: 123, weight: 90 },
    });

    const updated = await postJSON(
      path,
      { ...body, weight: 110, scopes: [{ owner: "openclaw", allow_private: false }] },
      "test-admin-token",
    );
    expect(updated.status).toBe(201);
    const identity = await env.DB.prepare(
      "SELECT kind, installation_id, weight FROM identities WHERE id = 'app'",
    ).first<{ kind: string; installation_id: number; weight: number }>();
    expect(identity).toEqual({ kind: "github_app", installation_id: 123, weight: 110 });
    const scopes = await env.DB.prepare(
      "SELECT owner, repo, allow_private FROM identity_scopes WHERE identity_id = 'app'",
    ).all<{ owner: string; repo: string | null; allow_private: number }>();
    expect(scopes.results).toEqual([{ owner: "openclaw", repo: null, allow_private: 0 }]);

    const conflict = await postJSON(path, { ...body, kind: "pat" }, "test-admin-token");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "identity_conflict" } });
  });

  it("creates an admin-provisioned caller whose returned token authenticates", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.pathname === "/orgs/openclaw/members/new-user" &&
        bearer(request) === "test-org-token"
      ) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/users/new-user") {
        return jsonResponse({ id: 99, login: "new-user" });
      }
      return jsonResponse({ message: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await postJSON(
      "/v1/admin/callers",
      { pool: POOL, github_login: "new-user", name: "New User" },
      "test-admin-token",
    );
    expect(response.status).toBe(201);
    const body = await response.json<{
      caller: { github_login: string; name: string; pool: string };
      token: string;
    }>();
    expect(body.caller).toMatchObject({
      github_login: "new-user",
      name: "New User",
      pool: POOL,
    });
    expect(body.token).toMatch(/^op_/);
    expect(upstream).toHaveBeenCalledTimes(2);

    const health = await callWorker(`/v1/pools/${POOL}/health`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(health.status).toBe(200);
  });

  it("limits CLI login to the configured pool and creates a usable caller", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/user" && bearer(request) === "github-user-token") {
        return jsonResponse({ id: 101, login: "cli-user", name: "CLI User" });
      }
      if (
        url.pathname === "/orgs/openclaw/members/cli-user" &&
        bearer(request) === "github-user-token"
      ) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ message: "unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const denied = await postJSON("/v1/login/github-cli", {
      github_token: "github-user-token",
      pool: "other",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "pool_denied" } });
    expect(upstream).not.toHaveBeenCalled();

    const response = await postJSON("/v1/login/github-cli", {
      github_token: "github-user-token",
      pool: POOL,
    });
    expect(response.status).toBe(201);
    const body = await response.json<{ caller: { github_login: string }; token: string }>();
    expect(body.caller.github_login).toBe("cli-user");
    expect(upstream).toHaveBeenCalledTimes(2);
    const health = await callWorker(`/v1/pools/${POOL}/health`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ identities_total: 0, identities_healthy: 0 });
  });

  it("enforces dashboard host, session, role, and pool-grant boundaries", async () => {
    await seedPool();
    const appDashboard = `https://octopool.openclaw.ai/v1/dashboard?pool=${POOL}`;

    const publicHost = await callWorker(`/v1/dashboard?pool=${POOL}`);
    expect(publicHost.status).toBe(404);
    const anonymous = await callWorker(appDashboard);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: "missing_web_session" } });

    const session = await seedWebSession();
    await env.DB.prepare("UPDATE callers SET dashboard_role = 'none' WHERE id = 'caller'").run();
    const deniedRole = await callWorker(appDashboard, {
      headers: { cookie: `octopool_session=${session}` },
    });
    expect(deniedRole.status).toBe(403);
    expect(await deniedRole.json()).toMatchObject({ error: { code: "dashboard_denied" } });

    await env.DB.prepare("UPDATE callers SET dashboard_role = 'admin' WHERE id = 'caller'").run();
    await env.DB.prepare("DELETE FROM caller_pools WHERE caller_id = 'caller'").run();
    const deniedPool = await callWorker(appDashboard, {
      headers: { cookie: `octopool_session=${session}` },
    });
    expect(deniedPool.status).toBe(403);
    expect(await deniedPool.json()).toMatchObject({ error: { code: "pool_denied" } });
  });

  it("prunes expired cache and old audit rows through the scheduled handler", async () => {
    await seedPool();
    await seedAudit("old-audit", "caller", "repo_view", "miss", 200);
    await seedAudit("fresh-audit", "caller", "repo_view", "hit", 200);
    await env.DB.prepare(
      "UPDATE audit_events SET created_at = datetime('now', '-31 days') WHERE request_id = 'old-audit'",
    ).run();
    await env.DB.batch([cacheEntry("old-cache", "-1 hour"), cacheEntry("fresh-cache", "+1 hour")]);

    await runScheduled();

    const audits = await env.DB.prepare(
      "SELECT request_id FROM audit_events ORDER BY request_id",
    ).all<{ request_id: string }>();
    expect(audits.results).toEqual([{ request_id: "fresh-audit" }]);
    const cache = await env.DB.prepare(
      "SELECT cache_key FROM github_cache_entries ORDER BY cache_key",
    ).all<{ cache_key: string }>();
    expect(cache.results).toEqual([{ cache_key: "fresh-cache" }]);
  });
});

function authenticatedGet(path: string): Promise<Response> {
  return callWorker(path, { headers: { authorization: `Bearer ${CALLER_TOKEN}` } });
}

function postJSON(path: string, body: unknown, token?: string): Promise<Response> {
  return callWorker(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function cacheEntry(cacheKey: string, staleOffset: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO github_cache_entries (
      cache_key, pool_id, method, path, query_json, headers_json, route_key, route_kind, status,
      response_headers_json, body_json, body_encoding, expires_at, stale_expires_at
    ) VALUES (?, ?, 'GET', '/fixture', '{}', '{}', 'fixture', 'repo_view', 200, '{}', '{}',
      'json', datetime('now', ?), datetime('now', ?))`,
  ).bind(cacheKey, POOL, staleOffset, staleOffset);
}
