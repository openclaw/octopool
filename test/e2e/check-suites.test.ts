import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

const base = "/repos/openclaw/octopool/check-suites/42";
const suite = { id: 42, status: "completed", updated_at: "2020-01-01T00:00:00Z" };
const checks = {
  total_count: 1,
  check_runs: [{ id: 7, status: "completed", completed_at: "2020-01-01T00:00:00Z" }],
};

describe.each([
  { path: base, kind: "check_suite_view", body: suite },
  { path: `${base}/check-runs`, kind: "check_suite_check_runs", body: checks },
])("check suite relay $kind", ({ path, kind, body }) => {
  it("uses pooled reads after public proof and shares the cached body", async () => {
    await seedPool();
    let pooled = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
        if (bearer(request) === "test-primary-token") {
          pooled++;
          expect(new URL(request.url).pathname).toBe(path);
          expect(request.headers.get("accept")).toBe("application/vnd.github+json");
          expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
          return jsonResponse(body);
        }
        expect(bearer(request)).toBeUndefined();
        return jsonResponse({}, 503);
      }),
    );
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    expect(await (await relay(path, undefined, { headers })).json()).toMatchObject({
      body,
      identity: { id: "primary" },
      relay: { route_kind: kind, cache: "miss", cacheable: true },
    });
    expect(await (await relay(path)).json()).toMatchObject({ body, relay: { cache: "hit" } });
    expect(pooled).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT unixepoch(expires_at) - unixepoch(created_at) AS fresh, unixepoch(stale_expires_at) - unixepoch(expires_at) AS stale FROM github_cache_entries LIMIT 1",
      ).first(),
    ).toEqual({ fresh: 300, stale: 300 });
    expect(
      await (await relay(path, undefined, { headers: { "cache-control": "max-age=0" } })).json(),
    ).toMatchObject({ body, relay: { cache: "miss" } });
    expect(pooled).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT route_kind, route_key FROM audit_events ORDER BY rowid LIMIT 1",
      ).first(),
    ).toEqual({ route_kind: kind, route_key: `GET ${path.replace("/42", "/:id")}` });
  });

  it("denies private repositories before using a pooled credential or body cache", async () => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: true });
        expect(bearer(request)).toBeUndefined();
        return jsonResponse({}, 404);
      }),
    );
    const response = await relay(path);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "repo_not_public" } },
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 0 });
  });

  it("rejects unsupported query keys before contacting GitHub", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await relay(path, undefined, { query: { app_id: "15368" } });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "route_denied" } },
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});
