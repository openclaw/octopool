import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { insertAudit } from "../../src/db";
import { poolHealth } from "../../src/health";
import {
  bearer,
  callWorker,
  callWarmWorker,
  CALLER_TOKEN,
  jsonResponse,
  orgMembershipResponse,
  POOL,
  runScheduled,
  seedAudit,
  seedPool,
  seedWebSession,
} from "./harness";

describe("Worker end-to-end control plane", () => {
  it("rejects membership from a replacement account without refreshing the enrolled caller", async () => {
    await seedPool();
    const stale = "2020-01-01T00:00:00.000Z";
    await env.DB.prepare(
      "UPDATE callers SET github_user_id = 101, github_login = 'old-name', org_identity_verified_at = ? WHERE id = 'caller'",
    )
      .bind(stale)
      .run();
    const upstream = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: {
          user: {
            databaseId: 202,
            organizations: {
              nodes: [{ login: "openclaw" }],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await authenticatedGet(`/v1/pools/${POOL}/health`);
    const stored = await env.DB.prepare(
      "SELECT github_user_id, github_login, org_identity_verified_at AS org_verified_at FROM callers WHERE id = 'caller'",
    ).first();
    expect.soft(response.status).toBe(403);
    expect
      .soft(await response.json())
      .toMatchObject({ error: { code: "github_identity_mismatch" } });
    expect
      .soft(stored)
      .toEqual({ github_user_id: 101, github_login: "old-name", org_verified_at: stale });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("attributes legacy macOS .local client aliases to the canonical host", async () => {
    await seedPool();
    await env.DB.prepare(
      "UPDATE caller_tokens SET client_name = 'clawstudio.local' WHERE id = 'caller-client-token'",
    ).run();

    const response = await authenticatedGet(`/v1/pools/${POOL}/stats?since=24h`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operator: { client_name: "clawstudio" },
    });
  });

  it("refreshes the same account across pages and preserves fresh and warm-cache membership", async () => {
    await seedPool();
    await setEnrollment(101, "old-name", STALE);
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(membershipPage(101, ["other"], "next"))
      .mockResolvedValueOnce(membershipPage(101, ["OpenClaw"]));
    vi.stubGlobal("fetch", upstream);

    expect((await authenticatedGet(`/v1/pools/${POOL}/health`)).status).toBe(200);
    const stored = await enrollment();
    expect(stored).toMatchObject({ github_user_id: 101, github_login: "old-name" });
    expect(Date.now() - Date.parse(stored!.org_verified_at!)).toBeLessThan(60_000);
    expect(upstream).toHaveBeenCalledTimes(2);
    const requests = upstream.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests[0].query).toContain("databaseId");
    expect(requests.map((request) => request.variables)).toEqual([
      { login: "old-name", after: null },
      { login: "old-name", after: "next" },
    ]);
    expect(
      (
        await callWarmWorker(`/v1/pools/${POOL}/health`, {
          headers: { authorization: `Bearer ${CALLER_TOKEN}` },
        })
      ).status,
    ).toBe(200);
    expect((await authenticatedGet(`/v1/pools/${POOL}/health`)).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await enrollment()).toEqual(stored);
  });

  it("rejects account substitution on a later organization page", async () => {
    await seedPool();
    await setEnrollment(101, "old-name", STALE);
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(membershipPage(101, ["other"], "next"))
      .mockResolvedValueOnce(membershipPage(202, ["openclaw"]));
    vi.stubGlobal("fetch", upstream);
    const response = await authenticatedGet(`/v1/pools/${POOL}/health`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "github_identity_mismatch" } });
    expect((await enrollment())!.org_verified_at).toBe(STALE);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["completed nonmembership", () => membershipPage(101, ["other"]), 403, "org_member_denied"],
    [
      "missing account",
      () => jsonResponse({ data: { user: null } }),
      403,
      "github_identity_mismatch",
    ],
    [
      "missing database ID",
      () =>
        jsonResponse({
          data: {
            user: {
              organizations: {
                nodes: [{ login: "openclaw" }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        }),
      502,
      "org_verification_failed",
    ],
    [
      "malformed node",
      () =>
        jsonResponse({
          data: {
            user: {
              databaseId: 101,
              organizations: {
                nodes: [null],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        }),
      502,
      "org_verification_failed",
    ],
    [
      "malformed node alongside membership",
      () =>
        jsonResponse({
          data: {
            user: {
              databaseId: 101,
              organizations: {
                nodes: [{ login: "openclaw" }, { login: 123 }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        }),
      502,
      "org_verification_failed",
    ],
    [
      "missing pagination",
      () =>
        jsonResponse({
          data: {
            user: {
              databaseId: 101,
              organizations: {
                nodes: [{ login: "openclaw" }],
              },
            },
          },
        }),
      502,
      "org_verification_failed",
    ],
    [
      "invalid JSON",
      () => new Response("synthetic-private-upstream"),
      502,
      "org_verification_failed",
    ],
    [
      "query failure",
      () => jsonResponse({ errors: [{ message: "synthetic-private-upstream" }] }),
      502,
      "org_verification_failed",
    ],
    [
      "HTTP failure",
      () => jsonResponse({ message: "synthetic-private-upstream" }, 401),
      502,
      "org_verification_failed",
    ],
    [
      "transport failure",
      () => {
        throw new Error("synthetic-private-upstream");
      },
      502,
      "org_verification_failed",
    ],
  ] as const)(
    "keeps the timestamp unchanged for %s",
    async (_name, responseForFetch, statusCode, code) => {
      await seedPool();
      await setEnrollment(101, "old-name", STALE);
      const upstream = vi.fn<typeof fetch>(async () => responseForFetch());
      vi.stubGlobal("fetch", upstream);
      const response = await authenticatedGet(`/v1/pools/${POOL}/health`);
      expect(response.status).toBe(statusCode);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code } });
      expect(body).not.toContain("synthetic-private-upstream");
      expect(body).not.toContain("test-org-token");
      expect((await enrollment())!.org_verified_at).toBe(STALE);
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["stale", "fresh"])(
    "fails closed for a legacy null ID with a %s timestamp on bearer and web auth",
    async (freshness) => {
      await seedPool();
      const timestamp = freshness === "fresh" ? new Date().toISOString() : STALE;
      await setEnrollment(null, "old-name", timestamp);
      const session = await seedWebSession();
      const upstream = vi.fn<typeof fetch>(async () => membershipPage(202, ["openclaw"]));
      vi.stubGlobal("fetch", upstream);
      for (const response of [
        await authenticatedGet(`/v1/pools/${POOL}/health`),
        await callWorker("https://octopool.openclaw.ai/v1/me", {
          headers: { cookie: `octopool_session=${session}` },
        }),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: {
            code: "github_identity_required",
            message: expect.stringContaining("sign in again"),
          },
        });
      }
      expect(await enrollment()).toEqual({
        github_user_id: null,
        github_login: "old-name",
        org_verified_at: timestamp,
      });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("recovers a renamed account only through a fresh verified login by the same ID", async () => {
    await seedPool();
    await setEnrollment(101, "old-name", STALE);
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/user")
        return jsonResponse({ id: 101, login: "new-name" });
      const { variables } = await request.json<{ variables: { login: string } }>();
      return membershipPage(variables.login === "new-name" ? 101 : 202, ["openclaw"]);
    });
    vi.stubGlobal("fetch", upstream);
    expect((await authenticatedGet(`/v1/pools/${POOL}/health`)).status).toBe(403);
    const login = await postJSON("/v1/login/github-cli", {
      github_token: "renamed-user-token",
      client_name: "new-client",
    });
    expect(login.status).toBe(201);
    expect(await login.json()).toMatchObject({
      caller: { id: "caller", github_login: "new-name" },
    });
    expect(await enrollment()).toMatchObject({ github_user_id: 101, github_login: "new-name" });
    expect((await enrollment())!.org_verified_at).not.toBe(STALE);
    expect((await authenticatedGet(`/v1/pools/${POOL}/health`)).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("enrolls a legacy user's fresh login separately without reviving old credentials or grants", async () => {
    await seedPool();
    await setEnrollment(null, "old-name", STALE);
    const session = await seedWebSession();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === "/user"
        ? jsonResponse({ id: 202, login: "old-name" })
        : membershipPage(202, ["openclaw"]);
    });
    vi.stubGlobal("fetch", upstream);
    const login = await postJSON("/v1/login/github-cli", { github_token: "fresh-user-token" });
    expect(login.status).toBe(201);
    const body = await login.json<{ caller: { id: string }; token: string }>();
    expect(body.caller.id).not.toBe("caller");
    expect(
      (
        await callWorker(`/v1/pools/${POOL}/health`, {
          headers: { authorization: `Bearer ${body.token}` },
        })
      ).status,
    ).toBe(200);
    expect((await authenticatedGet(`/v1/pools/${POOL}/health`)).status).toBe(403);
    expect(
      (
        await callWorker("https://octopool.openclaw.ai/v1/me", {
          headers: { cookie: `octopool_session=${session}` },
        })
      ).status,
    ).toBe(403);
    expect(await enrollment()).toEqual({
      github_user_id: null,
      github_login: "old-name",
      org_verified_at: STALE,
    });
    expect(
      await env.DB.prepare("SELECT dashboard_role FROM callers WHERE id = ?")
        .bind(body.caller.id)
        .first(),
    ).toEqual({ dashboard_role: "none" });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each(["CLI", "admin"])(
    "binds %s enrollment to the account resolved before membership",
    async (surface) => {
      await seedPool();
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        return path === "/graphql"
          ? membershipPage(202, ["openclaw"])
          : jsonResponse({ id: 101, login: "old-name" });
      });
      vi.stubGlobal("fetch", upstream);
      const response =
        surface === "CLI"
          ? await postJSON("/v1/login/github-cli", { github_token: "fresh-user-token" })
          : await postJSON(
              "/v1/admin/callers",
              { pool: POOL, github_login: "old-name" },
              "test-admin-token",
            );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "github_identity_mismatch" } });
      expect(upstream.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        surface === "CLI" ? "/user" : "/users/old-name",
        "/graphql",
      ]);
      expect(await env.DB.prepare("SELECT count(*) AS count FROM callers").first()).toEqual({
        count: 1,
      });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM caller_tokens").first()).toEqual({
        count: 1,
      });
    },
  );

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
      if (url.pathname === "/graphql" && bearer(request) === "test-org-token") {
        return orgMembershipResponse(true, 99);
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
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(
        "SELECT org_verified_at, org_identity_verified_at FROM callers WHERE github_user_id = 99",
      ).first(),
    ).toEqual({ org_verified_at: null, org_identity_verified_at: expect.any(String) });
  });

  it("keeps different CLI clients active while rotating only a re-logged client", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/user" && bearer(request) === "github-user-token") {
        return jsonResponse({ id: 101, login: "cli-user", name: "CLI User" });
      }
      if (url.pathname === "/graphql" && bearer(request) === "github-user-token") {
        return orgMembershipResponse(true, 101);
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

    const invalidClient = await postJSON("/v1/login/github-cli", {
      github_token: "github-user-token",
      pool: POOL,
      client_name: "not a hostname",
    });
    expect(invalidClient.status).toBe(400);
    expect(await invalidClient.json()).toMatchObject({
      error: { code: "client_name_invalid" },
    });
    expect(upstream).not.toHaveBeenCalled();

    const response = await postJSON("/v1/login/github-cli", {
      github_token: "github-user-token",
      pool: POOL,
      client_name: "cli-macbook",
    });
    expect(response.status).toBe(201);
    const body = await response.json<{
      caller: { github_login: string; client_name: string };
      token: string;
    }>();
    expect(body.caller).toMatchObject({ github_login: "cli-user", client_name: "cli-macbook" });
    expect(upstream).toHaveBeenCalledTimes(2);
    const firstHealth = await callWorker(`/v1/pools/${POOL}/health`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(firstHealth.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(
        "SELECT org_verified_at, org_identity_verified_at FROM callers WHERE github_user_id = 101",
      ).first(),
    ).toEqual({ org_verified_at: null, org_identity_verified_at: expect.any(String) });

    const studioResponse = await postJSON("/v1/login/github-cli", {
      github_token: "github-user-token",
      pool: POOL,
      client_name: "cli-mac-studio",
    });
    const studio = await studioResponse.json<{ token: string }>();
    expect(studioResponse.status).toBe(201);

    const rotatedResponse = await postJSON("/v1/login/github-cli", {
      github_token: "github-user-token",
      pool: POOL,
      client_name: "cli-macbook",
    });
    const rotated = await rotatedResponse.json<{ token: string }>();
    expect(rotatedResponse.status).toBe(201);

    const [oldMacBook, macStudio, newMacBook] = await Promise.all([
      callWorker(`/v1/pools/${POOL}/health`, {
        headers: { authorization: `Bearer ${body.token}` },
      }),
      callWorker(`/v1/pools/${POOL}/health`, {
        headers: { authorization: `Bearer ${studio.token}` },
      }),
      callWorker(`/v1/pools/${POOL}/health`, {
        headers: { authorization: `Bearer ${rotated.token}` },
      }),
    ]);
    expect(oldMacBook.status).toBe(401);
    expect(macStudio.status).toBe(200);
    expect(newMacBook.status).toBe(200);

    const tokens = await env.DB.prepare(
      "SELECT client_name FROM caller_tokens ORDER BY client_name",
    ).all<{ client_name: string }>();
    expect(tokens.results).toEqual([
      { client_name: "cli-mac-studio" },
      { client_name: "cli-macbook" },
    ]);
    const studioSession = await env.DB.prepare(
      "SELECT id, caller_id FROM caller_tokens WHERE client_name = 'cli-mac-studio'",
    ).first<{ id: string; caller_id: string }>();
    expect(studioSession).not.toBeNull();

    let newestToken = "";
    for (let index = 0; index < 15; index += 1) {
      const extraResponse = await postJSON("/v1/login/github-cli", {
        github_token: "github-user-token",
        pool: POOL,
        client_name: `ephemeral-${index}`,
      });
      expect(extraResponse.status).toBe(201);
      newestToken = (await extraResponse.json<{ token: string }>()).token;
    }
    const bounded = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM caller_tokens WHERE caller_id = (SELECT id FROM callers WHERE github_login = 'cli-user')",
    ).first<{ count: number }>();
    expect(bounded?.count).toBe(16);
    const [retiredStudio, preservedMacBook, newestClient] = await Promise.all([
      callWorker(`/v1/pools/${POOL}/health`, {
        headers: { authorization: `Bearer ${studio.token}` },
      }),
      callWorker(`/v1/pools/${POOL}/health`, {
        headers: { authorization: `Bearer ${rotated.token}` },
      }),
      callWorker(`/v1/pools/${POOL}/health`, {
        headers: { authorization: `Bearer ${newestToken}` },
      }),
    ]);
    expect(retiredStudio.status).toBe(401);
    expect(preservedMacBook.status).toBe(200);
    expect(newestClient.status).toBe(200);

    await insertAudit(env, {
      requestId: "retired-studio-request",
      callerId: studioSession!.caller_id,
      callerTokenId: studioSession!.id,
      clientName: "cli-mac-studio",
      pool: POOL,
      routeKey: "health:retired-client",
      routeKind: "repo_view",
      status: 200,
      durationMs: 1,
    });
    const retiredAudit = await env.DB.prepare(
      "SELECT caller_token_id, client_name FROM audit_events WHERE request_id = 'retired-studio-request'",
    ).first<{ caller_token_id: string | null; client_name: string }>();
    expect(retiredAudit).toEqual({ caller_token_id: null, client_name: "cli-mac-studio" });
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

const STALE = "2020-01-01T00:00:00.000Z";

function membershipPage(userId: number, logins: string[], cursor: string | null = null): Response {
  return jsonResponse({
    data: {
      user: {
        databaseId: userId,
        organizations: {
          nodes: logins.map((login) => ({ login })),
          pageInfo: { endCursor: cursor, hasNextPage: cursor !== null },
        },
      },
    },
  });
}

async function setEnrollment(
  userId: number | null,
  login: string,
  timestamp: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE callers SET github_user_id = ?, github_login = ?, org_identity_verified_at = ? WHERE id = 'caller'",
  )
    .bind(userId, login, timestamp)
    .run();
}

function enrollment() {
  return env.DB.prepare(
    "SELECT github_user_id, github_login, org_identity_verified_at AS org_verified_at FROM callers WHERE id = 'caller'",
  ).first<{
    github_user_id: number | null;
    github_login: string;
    org_verified_at: string | null;
  }>();
}

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
