import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../../src/policy";
import { seedPublicRepoProof as recordPublicGitHubRepo } from "./cache-publication-fixture";
import {
  deniedRepoSearchQueries,
  repoSearchPaths,
  validRepoSearchQueries,
} from "../fixtures/restricted-search";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const searchBody = { total_count: 1, incomplete_results: false, items: [{ id: 7 }] };

function mockSearchUpstream() {
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.github.com" && url.pathname.startsWith("/search/")) {
      return jsonResponse(searchBody, 200, rateHeaders({ remaining: 4_999 }));
    }
    if (url.hostname === "api.github.com" && url.pathname.startsWith("/repos/")) {
      return jsonResponse({ private: false });
    }
    if (url.hostname === "github.com") {
      return new Response('<meta name="octolytics-dimension-repository_public" content="true" />');
    }
    throw new Error(`Unexpected synthetic upstream: ${request.url}`);
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

async function cacheRows() {
  return (await env.DB.prepare("SELECT * FROM github_cache_entries ORDER BY cache_key").all())
    .results;
}

async function expectSearchDenied(response: Response) {
  expect.soft(response.status).toBe(424);
  expect.soft(await response.json()).toMatchObject({
    error: { code: "fallback_local", details: { reason: "search_denied" } },
  });
}

describe.each(repoSearchPaths)("Worker restricted search boundary for %s", (path) => {
  beforeEach(seedPool);

  it.each(deniedRepoSearchQueries)("denies q=%j before dispatch or cache writes", async (q) => {
    const upstream = mockSearchUpstream();
    const edgePut = vi.spyOn(caches.default, "put");
    await expectSearchDenied(await relay(path, undefined, { query: { q } }));
    // relay() drains waitUntil, so these include eventual fetches and publications.
    expect.soft(upstream).not.toHaveBeenCalled();
    expect.soft(await cacheRows()).toEqual([]);
    expect.soft(edgePut).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT route_kind, status, error_code, fallback_reason, identity_id, cache_status FROM audit_events",
      ).first(),
    ).toEqual({
      route_kind: "denied",
      status: 424,
      error_code: "fallback_local",
      fallback_reason: "search_denied",
      identity_id: null,
      cache_status: "unknown",
    });
  });

  it.each(validRepoSearchQueries)("dispatches valid q=%j unchanged", async (q) => {
    const upstream = mockSearchUpstream();
    const response = await relay(path, undefined, { query: { q } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 200, body: searchBody });
    const requests = upstream.mock.calls.map(([input, init]) => new Request(input, init));
    const resourceCalls = requests.filter((request) => new URL(request.url).pathname === path);
    expect(resourceCalls).toHaveLength(1);
    expect(new URL(resourceCalls[0]!.url).searchParams.get("q")).toBe(q);
    expect(bearer(resourceCalls[0]!)).toBe(
      path === "/search/code" ? "test-primary-token" : undefined,
    );
    expect(await cacheRows()).toHaveLength(1);
  });

  it.each(["edge", "shared"])(
    "rejects legacy malformed queries before %s cache reuse",
    async (layer) => {
      const validRequest = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
        query: { q: "repo:openclaw/octopool needle" },
      });
      const route = classifyRoute(validRequest, {
        ...defaultPolicy("openclaw"),
        allow_search: true,
      });
      await recordPublicGitHubRepo(env, route);
      const queries = [
        'repo:openclaw/octopool repo:"other/private" needle',
        "NOT repo:openclaw/octopool needle",
      ];
      for (const q of queries) {
        // Reproduce the old trusted route attached to an unchecked full query.
        const request = { ...validRequest, query: { q } };
        const key = await githubCacheKey(request.pool, request, route);
        await writeGitHubCache(env, key, request, route, {
          status: 200,
          headers: {},
          body: searchBody,
          body_encoding: "json",
        });
        if (layer === "shared") await deleteEdgeJSON("github-publication-v1", key);
      }
      const before = await cacheRows();
      expect(before).toHaveLength(2);
      const upstream = mockSearchUpstream();
      const edgePut = vi.spyOn(caches.default, "put");
      for (const q of queries)
        await expectSearchDenied(await relay(path, undefined, { query: { q } }));
      expect(upstream).not.toHaveBeenCalled();
      expect(await cacheRows()).toEqual(before);
      expect(edgePut).not.toHaveBeenCalled();
    },
  );

  it("retains search policy denial and authenticates before grammar denial", async () => {
    await env.DB.prepare(
      "UPDATE pools SET policy_json = json_set(policy_json, '$.allow_search', json('false'))",
    ).run();
    const upstream = mockSearchUpstream();
    await expectSearchDenied(
      await relay(path, undefined, { query: { q: "repo:openclaw/octopool needle" } }),
    );
    const response = await relay(path, "invalid-caller-token", {
      query: { q: 'repo:openclaw/octopool repo:"other/private" needle' },
    });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(await cacheRows()).toEqual([]);
  });
});

describe("Worker restricted search shape and protection boundaries", () => {
  beforeEach(seedPool);

  it.each([true, false])(
    "does not let the issue shape bypass grammar with allow_search=%s",
    async (allowSearch) => {
      await env.DB.prepare(
        "UPDATE pools SET policy_json = json_set(policy_json, '$.allow_search', json(?))",
      )
        .bind(JSON.stringify(allowSearch))
        .run();
      const upstream = mockSearchUpstream();
      for (const q of [
        'repo:openclaw/octopool repo:"other/private" type:issue needle',
        "NOT repo:openclaw/octopool type:issue needle",
      ]) {
        await expectSearchDenied(
          await relay("/search/issues", undefined, {
            query: { q },
            headers: { "x-octopool-public-shape": "issue-search-v1" },
          }),
        );
      }
      expect(upstream).not.toHaveBeenCalled();
      expect(await cacheRows()).toEqual([]);
    },
  );

  it.each([
    ["needle", 'repo:openclaw/octopool repo:"other/private" needle'],
    ["^https://api\\.github\\.com/search/code", "repo:openclaw/octopool needle"],
  ])("preserves protected input and canonical egress denial %#", async (pattern, q) => {
    await env.DB.prepare("UPDATE string_rewrite_policy SET rules_json = ?")
      .bind(JSON.stringify([{ pattern, replacement: "public" }]))
      .run();
    const upstream = mockSearchUpstream();
    const response = await relay("/search/code", undefined, { query: { q } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    const resourceCalls = upstream.mock.calls.filter(([input, init]) =>
      new URL(new Request(input, init).url).pathname.startsWith("/search/"),
    );
    expect(resourceCalls).toHaveLength(0);
    expect(await cacheRows()).toEqual([]);
  });
});
