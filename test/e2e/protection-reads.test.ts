import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { isNativeReadRoute, ROUTES } from "../../src/route-manifest";
import { CALLER_TOKEN, callWorker, POOL, relay, seedPool } from "./harness";

const nativeReads = ROUTES.filter(isNativeReadRoute);
const rulesPath = "/repos/openclaw/octopool/rules/branches/main";

async function setSyntheticPolicy(pattern: string, expectedRevision = 1): Promise<void> {
  const response = await callWorker("/v1/admin/string-rewrites", {
    method: "PUT",
    headers: {
      authorization: "Bearer test-admin-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schema_version: 1,
      expected_revision: expectedRevision,
      rules: [{ pattern, replacement: "public" }],
    }),
  });
  expect(response.status).toBe(200);
}

describe("Worker native protection reads", () => {
  it.each(nativeReads)("hands off $template without any GitHub or cache access", async (entry) => {
    await seedPool();
    await setSyntheticPolicy("internal-model");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    for (const headers of [
      undefined,
      { "if-none-match": '"fixture"' },
      { accept: "application/vnd.github.raw" },
    ]) {
      const response = await relay(
        entry.example,
        CALLER_TOKEN,
        headers === undefined ? {} : { headers },
      );
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "local_credentials_required" } },
      });
    }
    expect(upstream).not.toHaveBeenCalled();
    for (const table of [
      "github_cache_entries",
      "github_public_repo_proofs",
      "github_public_api_rates",
    ]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({
        count: 0,
      });
    }
    const audit = await env.DB.prepare(
      "SELECT identity_id, backend, cacheable, cache_status, route_kind, fallback_reason FROM audit_events WHERE route_kind = ?",
    )
      .bind(entry.kind)
      .all();
    expect(audit.results).toHaveLength(3);
    for (const row of audit.results) {
      expect(row).toEqual({
        identity_id: null,
        backend: null,
        cacheable: 0,
        cache_status: "bypass",
        route_kind: entry.kind,
        fallback_reason: "local_credentials_required",
      });
    }
  });

  it("ignores even preexisting fresh shared/edge content for every native route", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    for (const entry of nativeReads) {
      const request = { pool: POOL, method: "GET", path: entry.example };
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      const key = await githubCacheKey(POOL, request, route);
      // Seed a hypothetical old cache row with a positive TTL. Production native
      // route policy has zero TTL and cannot publish this caller-sensitive shape.
      expect(
        await writeGitHubCache(
          env,
          key,
          request,
          { ...route, kind: "repo_view" },
          {
            status: 200,
            headers: {},
            body: {
              bypass_actors: [{ actor_id: 42, actor_type: "Team" }],
              marker: "privileged-fixture",
            },
            body_encoding: "json",
          },
        ),
      ).toBe("shared");
      const response = await relay(entry.example);
      expect(response.status).toBe(424);
      expect(await response.text()).not.toContain("privileged-fixture");
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first(),
    ).toEqual({ count: 13 });
  });

  it("checks fresh authoritative policy before granting native fallback", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    await setSyntheticPolicy("internal-model");
    expect((await relay(rulesPath)).status).toBe(424);
    await setSyntheticPolicy("^main$", 2);
    const denied = await relay(rulesPath);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    await env.DB.prepare("DELETE FROM string_rewrite_policy").run();
    const unavailable = await relay(rulesPath);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "string_rewrite_policy_unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("enforces current pool owner policy before native handoff", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    await env.DB.prepare("UPDATE pools SET policy_json = ? WHERE id = ?")
      .bind(JSON.stringify({ ...defaultPolicy("other-owner"), allow_public_repos: false }), POOL)
      .run();
    for (const entry of nativeReads) {
      const response = await relay(entry.example);
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "owner_denied" } },
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("checks decoded branch components, query fields, and headers before handoff", async () => {
    await seedPool();
    await setSyntheticPolicy("^internal-model$");
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    for (const branch of ["feature%2Ftopic", "caf%C3%A9", "release%2Bnext"]) {
      expect((await relay(rulesPath.replace("/main", `/${branch}`))).status).toBe(424);
    }
    for (const [path, options] of [
      [rulesPath.replace("/main", "/feature%2F%69nternal-model"), {}],
      [rulesPath.replace("/main", "/feature%252Ftopic"), {}],
      [rulesPath, { query: { q: "internal-model" } }],
      [rulesPath, { query: { "internal-model": "safe" } }],
      [rulesPath, { headers: { "if-none-match": "internal-model" } }],
    ] as const) {
      const response = await relay(path, CALLER_TOKEN, options);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps authentication and mutation rejection ahead of fallback", async () => {
    await seedPool();
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect((await relay(rulesPath, "invalid-caller")).status).toBe(401);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const response = await callWorker("/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ pool: POOL, path: rulesPath, method }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "method_denied" } });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
