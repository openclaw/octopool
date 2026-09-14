import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CALLER_TOKEN, callWorker, POOL, seedPool } from "./harness";

describe("Worker error boundary", () => {
  it("logs one correlated safe diagnostic and keeps unexpected errors redacted", async () => {
    await seedPool();
    const querySecret = "query-secret-marker";
    const headerSecret = "header-secret-marker";
    const bodySecret = "body-secret-marker";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error(`synthetic failure\n${querySecret}\n${headerSecret}\n${bodySecret}`);
    failure.name = `CustomError-${querySecret}`;
    failure.stack = `${failure.stack ?? ""}\n    at ${headerSecret} (/tmp/${bodySecret}.ts:999:7)\n${querySecret}`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(failure));

    const response = await callWorker(`/v1/github/request?debug=${querySecret}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CALLER_TOKEN}`,
        "content-type": "application/json",
        "x-secret-like": headerSecret,
      },
      body: JSON.stringify({
        pool: POOL,
        method: "GET",
        path: "/repos/openclaw/octopool",
        ignored_secret_marker: bodySecret,
      }),
    });

    expect(logged).toHaveBeenCalledTimes(1);
    const event = logged.mock.calls[0]?.[0] as {
      event: string;
      code: string;
      request_id: string;
      method: string;
      pathname: string;
      error: { name: string; frames?: { extension: string; line: number; column: number }[] };
    };
    expect(event).toMatchObject({
      event: "octopool.worker.unexpected_exception",
      code: "internal_error",
      method: "POST",
      pathname: "/v1/github/request",
      error: { name: "Error" },
    });
    expect(event.request_id).toBeTruthy();
    expect(event.error.frames?.length).toBeGreaterThan(0);
    expect(event.error.frames?.[0]).toEqual({
      extension: "ts",
      line: expect.any(Number),
      column: expect.any(Number),
    });
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent).not.toContain(querySecret);
    expect(serializedEvent).not.toContain(headerSecret);
    expect(serializedEvent).not.toContain(bodySecret);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal error",
        request_id: event.request_id,
      },
    });
    expect(
      await env.DB.prepare("SELECT status, error_code FROM audit_events WHERE request_id = ?")
        .bind(event.request_id)
        .first(),
    ).toEqual({ status: 500, error_code: "internal_error" });
  });

  it("logs rejected request parsing without inventing caller audit rows", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await callWorker("/v1/github/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: POOL, method: "POST", path: "/user" }),
    });

    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string; request_id: string } }>();
    expect(body.error.code).toBe("method_denied");
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: body.error.request_id,
      route_family: "relay",
      method: "POST",
      status: 403,
      code: "method_denied",
      duration_ms: expect.any(Number),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual({
      count: 0,
    });
  });

  it.each([
    [undefined, "missing_auth"],
    ["private-invalid-token-marker", "invalid_auth"],
  ])("records caller authentication failures: %s", async (token, code) => {
    await seedPool();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await callWorker("/v1/github/request?private-query-marker", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        pool: POOL,
        method: "GET",
        path: "/repos/private-owner-marker/private-repo-marker",
      }),
    });
    const body = await response.json<{ error: { request_id: string; code: string } }>();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe(code);
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: body.error.request_id,
      route_family: "relay",
      method: "POST",
      status: 401,
      code,
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private-");
    expect(upstream).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual({
      count: 0,
    });
  });

  it("records membership denial without logging the member or organization", async () => {
    await seedPool();
    await env.DB.prepare(
      "UPDATE callers SET org_identity_verified_at = '2000-01-01', github_login = 'private-login-marker'",
    ).run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          user: {
            databaseId: 42,
            organizations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await callWorker(`/v1/pools/${POOL}/string-rewrites`, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    const body = await response.json<{ error: { request_id: string; code: string } }>();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("org_member_denied");
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: body.error.request_id,
      route_family: "caller_policy",
      method: "GET",
      status: 403,
      code: "org_member_denied",
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private-");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual({
      count: 0,
    });
  });

  it("records admin policy authentication failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await callWorker("/v1/admin/string-rewrites", {
      headers: { authorization: "Bearer private-admin-token-marker" },
    });
    const body = await response.json<{ error: { request_id: string; code: string } }>();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_admin_auth");
    expect(logged).toHaveBeenCalledExactlyOnceWith({
      event: "octopool.worker.request_error",
      request_id: body.error.request_id,
      route_family: "admin_policy",
      method: "GET",
      status: 401,
      code: "invalid_admin_auth",
      duration_ms: expect.any(Number),
    });
  });
});
