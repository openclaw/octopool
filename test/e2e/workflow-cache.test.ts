import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { queries } from "../../src/generated/sql";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { bearer, jsonResponse, relay, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";

const LIST = "/repos/openclaw/octopool/actions/workflows";
const VIEW = `${LIST}/123`;
const workflow = {
  id: 123,
  node_id: "W_fixture",
  name: "CI",
  path: ".github/workflows/ci.yml",
  state: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  url: `https://api.github.com${VIEW}`,
  html_url: "https://github.com/openclaw/octopool/blob/main/.github/workflows/ci.yml",
  badge_url: "https://github.com/openclaw/octopool/workflows/CI/badge.svg",
};

type Envelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  identity?: { id: string; kind: string };
  relay: { cache: string; cache_expires_at: string; route_kind: string };
};

describe("workflow catalogue cache reuse", () => {
  beforeEach(seedPool);

  it.each<{
    scenario: string;
    expected: "hit" | "miss" | "bypass" | "denied";
    pooled?: boolean;
    edge?: boolean;
    filename?: boolean;
  }>([
    { scenario: "anonymous edge entry", expected: "hit", edge: true },
    { scenario: "anonymous shared entry", expected: "hit" },
    { scenario: "pooled entry", expected: "hit", pooled: true },
    { scenario: "anonymous entry during identity lookup outage", expected: "hit" },
    { scenario: "expired source", expected: "miss" },
    { scenario: "source older than requested age", expected: "miss" },
    { scenario: "forced live read", expected: "miss" },
    { scenario: "disabled source identity", expected: "miss", pooled: true },
    { scenario: "removed identity scope", expected: "miss", pooled: true },
    { scenario: "private repository", expected: "denied" },
    { scenario: "missing item", expected: "miss" },
    { scenario: "duplicate item", expected: "miss" },
    { scenario: "wrong repository URL", expected: "miss" },
    { scenario: "string item ID", expected: "miss" },
    { scenario: "explicit default API version", expected: "hit" },
    { scenario: "different API version", expected: "miss" },
    { scenario: "custom media", expected: "miss" },
    { scenario: "shaped view", expected: "miss" },
    { scenario: "shaped source", expected: "miss" },
    { scenario: "query parameters", expected: "miss" },
    { scenario: "filename selector", expected: "hit", filename: true },
    { scenario: "duplicate workflow path", expected: "miss", filename: true },
    { scenario: "partial filename catalogue", expected: "miss", filename: true },
    { scenario: "inactive filename", expected: "miss", filename: true },
    { scenario: "wrong repository URL", expected: "miss", filename: true },
    { scenario: "string item ID", expected: "miss", filename: true },
    { scenario: "forced live read", expected: "miss", filename: true },
    { scenario: "removed identity scope", expected: "miss", filename: true, pooled: true },
    { scenario: "conditional read", expected: "bypass" },
    { scenario: "optional cache read failure", expected: "miss" },
    { scenario: "cold cache", expected: "miss" },
  ])("preserves the raw view contract: $scenario (filename=$filename)", async (test) => {
    let warming = true;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token")
        return jsonResponse({ private: !warming && test.scenario === "private repository" });
      if (url.hostname === "github.com") return jsonResponse({}, 404);
      if (test.pooled && warming && bearer(request) !== "test-primary-token")
        return jsonResponse({}, 503);
      const list = url.pathname === LIST;
      const item =
        test.scenario === "wrong repository URL"
          ? { ...workflow, url: workflow.url.replace("/octopool/", "/other/") }
          : test.scenario === "string item ID"
            ? { ...workflow, id: "123" }
            : test.scenario === "inactive filename"
              ? { ...workflow, state: "disabled_manually" }
              : workflow;
      const workflows =
        test.scenario === "missing item"
          ? []
          : test.scenario === "duplicate workflow path"
            ? [item, { ...item, id: 456, url: `https://api.github.com${LIST}/456` }]
            : test.scenario === "duplicate item"
              ? [item, item]
              : [item];
      const complete = test.filename && test.scenario !== "partial filename catalogue";
      return jsonResponse(
        list ? { total_count: complete ? workflows.length : 101, workflows } : workflow,
        200,
        {
          etag: list ? '"catalogue"' : '"view"',
          "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
          ...(list && !complete ? { link: '<https://api.github.com/next>; rel="next"' } : {}),
        },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const warm = await relay(LIST, undefined, {
      query: { page: "1", per_page: "100" },
      headers:
        test.scenario === "shaped source" ? { "x-octopool-public-shape": "workflow-list-v1" } : {},
    });
    expect(warm.status).toBe(200);
    const source = await env.DB.prepare("SELECT * FROM github_cache_entries").first<{
      cache_key: string;
      expires_at: string;
    }>();
    expect(source).not.toBeNull();
    const key = source!.cache_key;
    if (["expired source", "source older than requested age"].includes(test.scenario)) {
      await env.DB.prepare(
        `UPDATE github_cache_entries SET created_at = datetime('now', '-180 seconds'), expires_at = datetime('now', '${test.scenario === "expired source" ? "-1 second" : "+30 seconds"}') WHERE cache_key = ?`,
      )
        .bind(key)
        .run();
    }
    if (test.scenario === "disabled source identity")
      await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = 'primary'").run();
    if (test.scenario === "removed identity scope")
      await env.DB.prepare("DELETE FROM identity_scopes WHERE identity_id = 'primary'").run();
    if (test.scenario === "anonymous entry during identity lookup outage")
      await env.DB.prepare("ALTER TABLE identities RENAME TO unavailable_identities").run();
    if (test.scenario === "private repository") {
      await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
      await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
    }
    if (test.scenario === "cold cache")
      await env.DB.prepare("DELETE FROM github_cache_entries").run();
    if (!test.edge) await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
    const before = await env.DB.prepare("SELECT * FROM github_cache_entries").all();
    warming = false;
    upstream.mockClear();
    const options = {
      query: test.scenario === "query parameters" ? { page: "1" } : {},
      headers: {
        ...(test.scenario === "source older than requested age"
          ? { "cache-control": "max-age=30" }
          : {}),
        ...(test.scenario === "forced live read" ? { "cache-control": "max-age=0" } : {}),
        ...(test.scenario === "explicit default API version"
          ? { "x-github-api-version": "2022-11-28" }
          : test.scenario === "different API version"
            ? { "x-github-api-version": "2099-01-01" }
            : {}),
        ...(test.scenario === "custom media" ? { accept: "application/vnd.github.raw+json" } : {}),
        ...(test.scenario === "shaped view"
          ? { "x-octopool-public-shape": "workflow-view-v1" }
          : {}),
        ...(test.scenario === "conditional read" ? { "if-none-match": '"view"' } : {}),
      },
    };
    let failedProbes = 0;
    const db = observePublicationD1(env.DB, {
      before: async (sql, values) => {
        if (sql === queries.readGitHubCache && values[0] === key) {
          failedProbes++;
          throw new Error("synthetic catalogue lookup failure");
        }
      },
    });
    const path = test.filename ? `${LIST}/ci.yml` : VIEW;
    const response =
      test.scenario === "optional cache read failure"
        ? await requestWithEnv({ DB: db }, path, options)
        : await relay(path, undefined, options);
    if (test.expected === "denied") {
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { details: { reason: "repo_not_public" } },
      });
      expect(upstream).toHaveBeenCalledOnce();
      return;
    }
    expect(response.status).toBe(200);
    const result = await response.json<Envelope>();
    expect(result).toMatchObject({
      status: 200,
      body: workflow,
      body_encoding: "json",
      relay: { cache: test.expected, route_kind: "workflow_view" },
    });
    expect(result.body).toEqual(workflow);
    if (test.expected === "hit") {
      expect(result.identity).toEqual(test.pooled ? { id: "primary", kind: "pat" } : undefined);
      expect(result.relay.cache_expires_at).toBe(source!.expires_at);
      expect(result.headers).not.toHaveProperty("etag");
      expect(result.headers).not.toHaveProperty("last-modified");
      expect(result.headers).not.toHaveProperty("link");
      expect(upstream).not.toHaveBeenCalled();
      expect((await env.DB.prepare("SELECT * FROM github_cache_entries").all()).results).toEqual(
        before.results,
      );
    } else {
      const resourcePaths = upstream.mock.calls
        .map(([input, init]) => new URL(new Request(input, init).url))
        .filter((url) => url.hostname === "api.github.com")
        .map((url) => url.pathname);
      expect(resourcePaths).toContain(path);
      expect(resourcePaths).not.toContain(LIST);
      if (test.scenario === "optional cache read failure") expect(failedProbes).toBe(1);
    }
  });
});
