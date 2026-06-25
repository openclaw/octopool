import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

type RelayEnvelope = {
  status: number;
  body: unknown;
  identity?: { id: string; kind: string };
  relay: { cache: string; route_kind: string };
};

describe("Worker end-to-end GitHub App identity", () => {
  it("exchanges a signed app JWT and reuses the installation token", async () => {
    await seedGitHubApp("TEST_APP_KEY", 123);
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        expect(url.pathname).toBe("/repos/openclaw/octopool");
        return jsonResponse({ private: false });
      }
      if (request.method === "POST") {
        expect(url.pathname).toBe("/app/installations/123/access_tokens");
        const jwt = bearer(request);
        expect(jwt).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
        expect(decodeJWTPart(jwt!.split(".")[0]!)).toEqual({ alg: "RS256", typ: "JWT" });
        expect(decodeJWTPart(jwt!.split(".")[1]!)).toMatchObject({ iss: "777" });
        return jsonResponse({
          token: "installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      expect(bearer(request)).toBe("installation-token");
      expect(request.headers.get("if-none-match")).toBe('"app-fixture"');
      return jsonResponse({ id: 9, full_name: "openclaw/octopool", private: false });
    });
    vi.stubGlobal("fetch", upstream);

    for (let request = 0; request < 2; request++) {
      const response = await relay("/repos/openclaw/octopool", undefined, {
        headers: { "if-none-match": '"app-fixture"' },
      });
      expect(response.status).toBe(200);
      expect(await response.json<RelayEnvelope>()).toMatchObject({
        status: 200,
        body: { id: 9, full_name: "openclaw/octopool", private: false },
        identity: { id: "primary", kind: "github_app" },
        relay: { cache: "bypass", route_kind: "repo_view" },
      });
    }

    const calls = upstream.mock.calls.map(([input, init]) => new Request(input, init));
    expect(calls.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(calls.filter((request) => bearer(request) === "installation-token")).toHaveLength(2);
    expect(calls.filter((request) => bearer(request) === "test-org-token")).toHaveLength(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE identity_id = 'primary' AND cache_status = 'bypass'",
      ).first(),
    ).toEqual({ count: 2 });
  });

  it("surfaces and audits installation-token exchange failure", async () => {
    await seedGitHubApp("TEST_APP_KEY_FAILURE", 456);
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      expect(request.method).toBe("POST");
      expect(url.pathname).toBe("/app/installations/456/access_tokens");
      return jsonResponse({ message: "installation unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool", undefined, {
      headers: { "if-none-match": '"app-failure"' },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "github_app_token_failed" } });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(
        "SELECT identity_id, status, error_code, cache_status FROM audit_events",
      ).first(),
    ).toEqual({
      identity_id: "primary",
      status: 502,
      error_code: "github_app_token_failed",
      cache_status: "bypass",
    });
  });
});

async function seedGitHubApp(secretRef: string, installationId: number): Promise<void> {
  await seedPool();
  await env.DB.prepare(
    `UPDATE identities
     SET kind = 'github_app', secret_ref = ?, installation_id = ?
     WHERE id = 'primary'`,
  )
    .bind(secretRef, installationId)
    .run();
}

function decodeJWTPart(value: string): unknown {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64)) as unknown;
}
