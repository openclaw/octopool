import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  bearer,
  callWorker,
  jsonResponse,
  orgMembershipResponse,
  POOL,
  seedPool,
  seedWebSession,
} from "./harness";

const APP = "https://octopool.openclaw.ai";

describe("Worker end-to-end web sessions", () => {
  it("rejects OAuth membership for a substituted account without creating a session", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/login/oauth/access_token")
        return jsonResponse({ access_token: "oauth-user-token" });
      if (path === "/user") return jsonResponse({ id: 101, login: "old-name" });
      if (path === "/graphql") return orgMembershipResponse(true, 202);
      return jsonResponse({}, 500);
    });
    vi.stubGlobal("fetch", upstream);
    const start = await callWorker(`${APP}/login/github`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await callWorker(
      `${APP}/login/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `octopool_oauth_state=${encodeURIComponent(state)}` } },
    );
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("github_identity_mismatch");
    expect(cookieValue(callback, "octopool_session")).toBeUndefined();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM callers").first()).toEqual({
      count: 0,
    });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM web_sessions").first()).toEqual({
      count: 0,
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("binds stale browser sessions to the stored immutable account", async () => {
    await seedPool();
    const session = await seedWebSession();
    await env.DB.prepare(
      "UPDATE callers SET github_user_id = 101, github_login = 'old-name', org_identity_verified_at = '2020-01-01' WHERE id = 'caller'",
    ).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => orgMembershipResponse(true, 202)),
    );
    const response = await callWorker(`${APP}/v1/me`, {
      headers: { cookie: `octopool_session=${session}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "github_identity_mismatch" } });
    expect(
      await env.DB.prepare(
        "SELECT org_identity_verified_at FROM callers WHERE id = 'caller'",
      ).first(),
    ).toEqual({ org_identity_verified_at: "2020-01-01" });
  });

  it("returns a typed browser error when the GitHub OAuth exchange fails", async () => {
    let exchangeHadSignal = false;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
        exchangeHadSignal = request.signal instanceof AbortSignal;
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return jsonResponse({ message: "unexpected OAuth request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const start = await callWorker(`${APP}/login/github`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await callWorker(
      `${APP}/login/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `octopool_oauth_state=${encodeURIComponent(state)}` } },
    );

    expect(exchangeHadSignal).toBe(true);
    expect(callback.status).toBe(502);
    expect(callback.headers.get("content-type")).toContain("text/html");
    const html = await callback.text();
    expect(html).toContain("github_oauth_failed");
    expect(html).toContain("GitHub OAuth token exchange failed");
  });

  it("completes OAuth, persists a hashed session, serves authenticated pages, and logs out", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
        expect(request.method).toBe("POST");
        expect((await request.formData()).get("code")).toBe("oauth-code");
        return jsonResponse({ access_token: "oauth-user-token" });
      }
      if (url.pathname === "/user" && bearer(request) === "oauth-user-token") {
        return jsonResponse({ id: 501, login: "web-user", name: "Web User" });
      }
      if (url.pathname === "/graphql" && bearer(request) === "test-org-token") {
        return orgMembershipResponse(true, 501);
      }
      return jsonResponse({ message: "unexpected OAuth request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const next = "/dashboard?pool=alt";
    const start = await callWorker(`${APP}/login/github?next=${encodeURIComponent(next)}`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://octopool.dev/login/github/callback",
    );
    const state = authorize.searchParams.get("state")!;
    expect(state).toMatch(/^state\./);
    expect(cookieValue(start, "octopool_oauth_state")).toBe(state);

    const callback = await callWorker(
      `${APP}/login/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `octopool_oauth_state=${encodeURIComponent(state)}` } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(next);
    const session = cookieValue(callback, "octopool_session");
    expect(session).toMatch(/^sess_/);
    expect(upstream).toHaveBeenCalledTimes(3);

    const caller = await env.DB.prepare(
      "SELECT id, github_login, dashboard_role FROM callers WHERE github_user_id = 501",
    ).first<{ id: string; github_login: string; dashboard_role: string }>();
    expect(caller).toMatchObject({ github_login: "web-user", dashboard_role: "none" });
    expect(
      await env.DB.prepare(
        "SELECT 1 AS present FROM caller_pools WHERE caller_id = ? AND pool_id = ?",
      )
        .bind(caller!.id, POOL)
        .first(),
    ).toEqual({ present: 1 });
    const storedSession = await env.DB.prepare(
      "SELECT session_hash, caller_id FROM web_sessions WHERE caller_id = ?",
    )
      .bind(caller!.id)
      .first<{ session_hash: string; caller_id: string }>();
    expect(storedSession?.caller_id).toBe(caller!.id);
    expect(storedSession?.session_hash).not.toBe(session);

    await env.DB.prepare("UPDATE callers SET dashboard_role = 'admin' WHERE id = ?")
      .bind(caller!.id)
      .run();
    const cookie = `octopool_session=${encodeURIComponent(session!)}`;
    const me = await callWorker(`${APP}/v1/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      caller: { id: caller!.id, github_login: "web-user", dashboard_role: "admin" },
    });
    const dashboard = await callWorker(`${APP}/dashboard`, { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-type")).toContain("text/html");
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(
      await env.DB.prepare(
        "SELECT org_verified_at, org_identity_verified_at FROM callers WHERE github_user_id = 501",
      ).first(),
    ).toEqual({ org_verified_at: null, org_identity_verified_at: expect.any(String) });

    const logout = await callWorker(`${APP}/logout`, { headers: { cookie } });
    expect(logout.status).toBe(302);
    expect(cookieValue(logout, "octopool_session")).toBe("");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE caller_id = ?")
        .bind(caller!.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    const afterLogout = await callWorker(`${APP}/v1/me`, { headers: { cookie } });
    expect(afterLogout.status).toBe(401);
    expect(await afterLogout.json()).toMatchObject({ error: { code: "invalid_web_session" } });
  });

  it("redirects dashboard login through query-bearing next paths and rejects control chars", async () => {
    await seedPool();
    const session = await seedWebSession();

    const redirect = await callWorker(`${APP}/dashboard?pool=alt`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      "https://octopool.openclaw.ai/login/github?next=%2Fdashboard%3Fpool%3Dalt",
    );

    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
        return jsonResponse({ access_token: "oauth-user-token" });
      }
      if (url.pathname === "/user" && bearer(request) === "oauth-user-token") {
        return jsonResponse({ id: 502, login: "web-user-2" });
      }
      if (url.pathname === "/graphql" && bearer(request) === "test-org-token") {
        return orgMembershipResponse(true, 502);
      }
      return jsonResponse({ message: "unexpected OAuth request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const start = await callWorker(
      `${APP}/login/github?next=${encodeURIComponent("/dashboard\rset-cookie:x")}`,
      { headers: { cookie: `octopool_session=${session}` } },
    );
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await callWorker(
      `${APP}/login/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `octopool_oauth_state=${encodeURIComponent(state)}` } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
  });

  it("refreshes stale membership and rejects revoked members", async () => {
    await seedPool();
    const session = await seedWebSession();
    await env.DB.prepare(
      "UPDATE callers SET org_identity_verified_at = datetime('now', '-2 days') WHERE id = 'caller'",
    ).run();
    let isMember = true;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/graphql" && bearer(request) === "test-org-token") {
        return orgMembershipResponse(isMember, 42);
      }
      return jsonResponse({ message: "unexpected membership request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);
    const cookie = `octopool_session=${session}`;

    const refreshed = await callWorker(`${APP}/v1/me`, { headers: { cookie } });
    expect(refreshed.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const verified = await env.DB.prepare(
      "SELECT org_identity_verified_at FROM callers WHERE id = 'caller'",
    ).first<{ org_identity_verified_at: string }>();
    expect(Date.now() - Date.parse(verified!.org_identity_verified_at)).toBeLessThan(60_000);

    await env.DB.prepare(
      "UPDATE callers SET org_identity_verified_at = datetime('now', '-2 days') WHERE id = 'caller'",
    ).run();
    isMember = false;
    const revoked = await callWorker(`${APP}/v1/me`, { headers: { cookie } });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ error: { code: "org_member_denied" } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

function cookieValue(response: Response, name: string): string | undefined {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(header);
  return match === null ? undefined : decodeURIComponent(match[1] ?? "");
}
