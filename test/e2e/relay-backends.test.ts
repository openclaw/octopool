import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

type RelayEnvelope = {
  status: number;
  body: unknown;
  identity?: { id: string; kind: string };
  relay: {
    backend?: string;
    cache: string;
    cacheable: boolean;
    route_kind: string;
  };
};

describe("Worker end-to-end relay backends", () => {
  it("serves and caches a public repository through the token-free web backend", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.github.com/repos/openclaw/octopool");
      expect(bearer(request)).toBeUndefined();
      return jsonResponse(
        { id: 7, full_name: "openclaw/octopool", private: false },
        200,
        publicRateHeaders(),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const first = await relay("/repos/openclaw/octopool");
    expect(first.status).toBe(200);
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: { id: 7, full_name: "openclaw/octopool", private: false },
      relay: { backend: "web", cache: "miss", cacheable: true, route_kind: "repo_view" },
    });
    const second = await relay("/repos/openclaw/octopool");
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      relay: { backend: "web", cache: "hit", cacheable: true, route_kind: "repo_view" },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT owner, repo FROM github_public_repos WHERE owner = 'openclaw' AND repo = 'octopool'",
      ).first(),
    ).toEqual({ owner: "openclaw", repo: "octopool" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE identity_id IS NULL AND cache_status IN ('miss', 'hit')",
      ).first(),
    ).toEqual({ count: 2 });
  });

  it("uses and caches the explicit anonymous GitHub API fallback", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.github.com/users/octocat");
      expect(bearer(request)).toBeUndefined();
      return jsonResponse({ id: 8, login: "octocat", name: "The Octocat" });
    });
    vi.stubGlobal("fetch", upstream);

    const first = await relay("/users/octocat");
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: { id: 8, login: "octocat", name: "The Octocat" },
      relay: {
        backend: "github_public",
        cache: "miss",
        cacheable: true,
        route_kind: "user_view",
      },
    });
    const second = await relay("/users/octocat");
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      relay: { backend: "github_public", cache: "hit", route_kind: "user_view" },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("returns local fallback when a local-only route has no token-free result", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.github.com/users/octocat/repos");
      expect(bearer(request)).toBeUndefined();
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/users/octocat/repos");
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "web_only_unavailable" } },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT route_kind, status, error_code, fallback_reason FROM audit_events",
      ).first(),
    ).toEqual({
      route_kind: "user_repo_list",
      status: 424,
      error_code: "fallback_local",
      fallback_reason: "web_only_unavailable",
    });
  });

  it("normalizes policy denial to local fallback and records a denied audit", async () => {
    await seedPool();
    await env.DB.prepare("UPDATE pools SET policy_json = ? WHERE id = 'maintainers'")
      .bind(
        JSON.stringify({
          allowed_owners: ["openclaw"],
          allow_public_repos: false,
          allow_search: true,
          allow_logs: true,
        }),
      )
      .run();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/outsider/project");
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "owner_denied" } },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT route_kind, status, error_code, fallback_reason, cache_status FROM audit_events",
      ).first(),
    ).toEqual({
      route_kind: "denied",
      status: 424,
      error_code: "fallback_local",
      fallback_reason: "owner_denied",
      cache_status: "unknown",
    });
  });

  it("bypasses token-free and response caches for conditional requests", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      expect(bearer(request)).toBe("test-primary-token");
      expect(request.headers.get("if-none-match")).toBe('"fixture-etag"');
      return new Response(null, { status: 304, headers: { etag: '"fixture-etag"' } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay("/repos/openclaw/octopool", undefined, {
      headers: { "if-none-match": '"fixture-etag"' },
    });
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 304,
      body: null,
      identity: { id: "primary", kind: "pat" },
      relay: { cache: "bypass", cacheable: true, route_kind: "repo_view" },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT cache_status, cacheable FROM audit_events").first(),
    ).toEqual({ cache_status: "bypass", cacheable: 0 });
  });
});

function publicRateHeaders(): HeadersInit {
  return {
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": "59",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3_600),
  };
}
