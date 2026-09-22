import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { queries } from "../../src/generated/sql";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { bearer, CALLER_TOKEN, callWorker, jsonResponse, relay, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";

const BASE = "/repos/openclaw/octopool/actions/runs/42/jobs";
const ATTEMPT = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";
const jobs = [1, 2].map((id) => ({
  id,
  run_id: 42,
  run_attempt: 2,
  name: `Job ${id}`,
  status: "in_progress",
  labels: ["linux"],
  runner_group_name: "Public runners",
  steps: [{ name: "Build", status: "in_progress", number: 1 }],
}));

type Envelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  identity?: { id: string; kind: string };
  relay: { cache: string; cache_expires_at: string };
};

describe("complete raw jobs page reuse", () => {
  beforeEach(seedPool);

  it.each<{
    scenario: string;
    expected: "hit" | "miss" | "bypass" | "denied";
    pooled?: boolean;
    edge?: boolean;
    attempt?: boolean;
    filter?: "latest" | "all";
  }>([
    { scenario: "anonymous edge", expected: "hit", edge: true },
    { scenario: "anonymous shared", expected: "hit" },
    { scenario: "pooled source", expected: "hit", pooled: true },
    { scenario: "attempt-qualified source", expected: "hit", attempt: true },
    { scenario: "completed attempt source", expected: "hit", attempt: true },
    { scenario: "same latest filter", expected: "hit", filter: "latest" },
    { scenario: "same all filter", expected: "hit", filter: "all" },
    { scenario: "complete empty source", expected: "hit" },
    { scenario: "changed filter", expected: "miss", filter: "latest" },
    { scenario: "different attempt", expected: "miss", attempt: true },
    { scenario: "different pool", expected: "miss" },
    { scenario: "expired source", expected: "miss" },
    { scenario: "explicit age bound", expected: "miss" },
    { scenario: "forced fresh", expected: "miss" },
    { scenario: "conditional request", expected: "bypass" },
    { scenario: "revoked source", expected: "miss", pooled: true },
    { scenario: "removed source scope", expected: "miss", pooled: true },
    { scenario: "private repository", expected: "denied" },
    { scenario: "policy denial", expected: "denied" },
    { scenario: "cache probe failure", expected: "miss" },
    { scenario: "cold source", expected: "miss" },
    { scenario: "incomplete count", expected: "miss" },
    { scenario: "invalid count", expected: "miss" },
    { scenario: "source exceeds requested size", expected: "miss" },
    { scenario: "linked source", expected: "miss" },
    { scenario: "non-JSON source", expected: "miss" },
    { scenario: "different API version", expected: "miss" },
    { scenario: "custom media", expected: "miss" },
    { scenario: "shaped source", expected: "miss" },
    { scenario: "later page", expected: "miss" },
    { scenario: "unknown query", expected: "miss" },
  ])("preserves the exact REST contract: $scenario", async (test) => {
    const path = test.attempt ? ATTEMPT : BASE;
    const sourceJobs =
      test.scenario === "complete empty source"
        ? []
        : test.scenario === "completed attempt source"
          ? jobs.map((job) => ({
              ...job,
              status: "completed",
              steps: job.steps.map((step) => ({ ...step, status: "completed" })),
            }))
          : jobs;
    const sourceBody = {
      total_count:
        test.scenario === "incomplete count"
          ? 3
          : test.scenario === "invalid count"
            ? "2"
            : sourceJobs.length,
      jobs: sourceJobs,
      upstream_field: "preserved",
    };
    let warming = true;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token")
        return jsonResponse({ private: !warming && test.scenario === "private repository" });
      if (url.hostname === "github.com") return new Response(null, { status: 404 });
      if (warming && test.pooled && bearer(request) !== "test-primary-token")
        return new Response(null, { status: 503 });
      if (url.pathname === ATTEMPT.replace("/jobs", ""))
        return jsonResponse({ id: 42, run_attempt: 2, status: "completed" });
      if (warming) {
        return jsonResponse(sourceBody, 200, {
          etag: '"large-page"',
          "last-modified": "Sun, 20 Sep 2026 00:00:00 GMT",
          ...(test.scenario === "linked source"
            ? { link: '<https://api.github.com/jobs?page=1>; rel="last"' }
            : {}),
        });
      }
      if (test.scenario === "private repository") return new Response(null, { status: 404 });
      const size = Number(url.searchParams.get("per_page") ?? 30);
      const changed =
        test.scenario === "incomplete count" || test.scenario === "changed filter"
          ? [...jobs, { ...jobs[0], id: 3, run_attempt: 1 }]
          : test.scenario === "different attempt"
            ? sourceJobs.map((job) => ({ ...job, run_attempt: 1 }))
            : sourceJobs;
      return jsonResponse({
        ...sourceBody,
        total_count: changed.length,
        jobs: changed.slice(0, size),
      });
    });
    vi.stubGlobal("fetch", upstream);
    expect(
      (
        await relay(path, undefined, {
          query: { per_page: "100", ...(test.filter ? { filter: test.filter } : {}) },
          headers:
            test.scenario === "shaped source"
              ? { "x-octopool-public-shape": "actions-jobs-v1" }
              : {},
        })
      ).status,
    ).toBe(200);
    const source = await env.DB.prepare(
      "SELECT cache_key, expires_at FROM github_cache_entries WHERE route_kind = 'run_jobs'",
    ).first<{
      cache_key: string;
      expires_at: string;
    }>();
    expect(source).not.toBeNull();
    const key = source!.cache_key;
    if (test.scenario === "completed attempt source") {
      expect(
        await env.DB.prepare(
          "SELECT unixepoch(expires_at)-unixepoch(created_at) AS ttl FROM github_cache_entries WHERE cache_key = ?",
        )
          .bind(key)
          .first("ttl"),
      ).toBe(3600);
    }
    if (test.scenario === "different pool") {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO pools (id,name,policy_json) SELECT 'other','Other',policy_json FROM pools WHERE id = 'maintainers'",
        ),
        env.DB.prepare("INSERT INTO caller_pools (caller_id,pool_id) VALUES ('caller','other')"),
      ]);
    }
    if (test.scenario === "expired source" || test.scenario === "explicit age bound") {
      await env.DB.prepare(
        `UPDATE github_cache_entries SET created_at = datetime('now', '-120 seconds'), expires_at = datetime('now', '${test.scenario === "expired source" ? "-1 second" : "+30 seconds"}') WHERE cache_key = ?`,
      )
        .bind(key)
        .run();
    }
    if (test.scenario === "revoked source")
      await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = 'primary'").run();
    if (test.scenario === "removed source scope")
      await env.DB.prepare("DELETE FROM identity_scopes WHERE identity_id = 'primary'").run();
    if (test.scenario === "private repository") {
      await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
      await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
    }
    if (test.scenario === "non-JSON source")
      await env.DB.prepare(
        "UPDATE github_cache_entries SET body_encoding = 'text', body_json = ? WHERE cache_key = ?",
      )
        .bind(JSON.stringify(JSON.stringify(sourceBody)), key)
        .run();
    if (test.scenario === "cold source")
      await env.DB.prepare("DELETE FROM github_cache_entries").run();
    if (!test.edge) await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
    if (test.scenario === "policy denial") {
      expect(
        (
          await callWorker("/v1/admin/string-rewrites", {
            method: "PUT",
            headers: {
              authorization: "Bearer test-admin-token",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              schema_version: 1,
              expected_revision: 1,
              rules: [{ pattern: "actions/runs", replacement: "public" }],
            }),
          })
        ).status,
      ).toBe(200);
    }
    const before = await env.DB.prepare("SELECT * FROM github_cache_entries").all();
    warming = false;
    upstream.mockClear();
    const targetPath = test.scenario === "different attempt" ? ATTEMPT.replace("/2/", "/1/") : path;
    const options = {
      query: {
        ...(test.filter
          ? { filter: test.scenario === "changed filter" ? "all" : test.filter }
          : {}),
        ...(test.scenario === "source exceeds requested size" ? { per_page: "1" } : {}),
        ...(test.scenario === "later page" ? { page: "2" } : {}),
        ...(test.scenario === "unknown query" ? { unknown: "value" } : {}),
      },
      headers: {
        ...(test.scenario === "explicit age bound" ? { "cache-control": "max-age=30" } : {}),
        ...(test.scenario === "forced fresh" ? { "cache-control": "max-age=0" } : {}),
        ...(test.scenario === "conditional request" ? { "if-none-match": '"client"' } : {}),
        ...(test.scenario === "different API version"
          ? { "x-github-api-version": "2099-01-01" }
          : {}),
        ...(test.scenario === "custom media" ? { accept: "application/vnd.github.raw+json" } : {}),
      },
    };
    let failedProbes = 0;
    const db = observePublicationD1(env.DB, {
      before: async (sql, values) => {
        if (sql === queries.readGitHubCache && values[0] === key) {
          failedProbes++;
          throw new Error("synthetic optional cache probe failure");
        }
      },
    });
    const response =
      test.scenario === "different pool"
        ? await callWorker("/v1/github/request", {
            method: "POST",
            headers: {
              authorization: `Bearer ${CALLER_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ pool: "other", method: "GET", path: targetPath, ...options }),
          })
        : test.scenario === "cache probe failure"
          ? await requestWithEnv({ DB: db }, targetPath, options)
          : await relay(targetPath, undefined, options);
    if (test.expected === "denied") {
      expect(response.status).toBe(test.scenario === "policy denial" ? 403 : 424);
      expect(await response.json()).toMatchObject(
        test.scenario === "policy denial"
          ? { error: { code: "string_rewrite_denied" } }
          : { error: { details: { reason: "repo_not_public" } } },
      );
      if (test.scenario === "policy denial") expect(upstream).not.toHaveBeenCalled();
      else {
        const tokens = upstream.mock.calls.map(([input, init]) => bearer(input, init));
        expect(tokens.filter((token) => token === "test-org-token")).toHaveLength(1);
        expect(tokens).not.toContain("test-primary-token");
      }
      return;
    }
    expect(response.status).toBe(200);
    const wire = await response.json<Envelope>();
    expect(wire.relay.cache).toBe(test.expected);
    expect(wire.body_encoding).toBe("json");
    if (test.expected === "hit") {
      expect(wire.body).toEqual(sourceBody);
      expect(wire.identity).toEqual(test.pooled ? { id: "primary", kind: "pat" } : undefined);
      expect(wire.relay.cache_expires_at).toBe(source!.expires_at);
      for (const header of ["etag", "last-modified", "content-length", "link"])
        expect(wire.headers).not.toHaveProperty(header);
      expect(upstream).not.toHaveBeenCalled();
      expect((await env.DB.prepare("SELECT * FROM github_cache_entries").all()).results).toEqual(
        before.results,
      );
    } else {
      const resourceCalls = upstream.mock.calls
        .map(([input, init]) => new URL(new Request(input, init).url))
        .filter((url) => url.hostname === "api.github.com" && url.pathname === targetPath);
      expect(resourceCalls).toHaveLength(1);
      expect(resourceCalls[0]!.searchParams.get("per_page")).toBe(
        test.scenario === "source exceeds requested size" ? "1" : null,
      );
      if (test.scenario === "incomplete count")
        expect(wire.body).toMatchObject({ total_count: 3, jobs: expect.any(Array) });
      if (test.scenario === "source exceeds requested size")
        expect(wire.body).toMatchObject({ total_count: 2, jobs: [jobs[0]] });
      if (test.scenario === "cache probe failure") expect(failedProbes).toBe(1);
    }
  });
});
