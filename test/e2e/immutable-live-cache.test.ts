import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { githubCacheKey } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import type { RelayRequest } from "../../src/types";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { callWorker, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

const REPO = "/repos/openclaw/immutable-fixture";
const SHA = "a".repeat(40);
const LIVE = { "cache-control": "max-age=0" };
const immutable: Fixture[] = [
  { path: `${REPO}/contents/file.txt`, query: { ref: SHA }, body: { sha: SHA } },
  ...["git/trees", "git/blobs"].map((kind) => ({
    path: `${REPO}/${kind}/${SHA}`,
    body: { sha: SHA },
  })),
];

type Fixture = {
  path: string;
  query?: RelayRequest["query"];
  body: unknown;
  completedAttempt?: boolean;
};

async function seed(fixture: Fixture, source = "anonymous", publicProof = true) {
  await seedPool();
  const request: RelayRequest = {
    pool: "maintainers",
    method: "GET",
    path: fixture.path,
    ...(fixture.query === undefined ? {} : { query: fixture.query }),
  };
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  const identity =
    source === "identity" ? (await loadIdentities(env, request.pool, route))[0] : undefined;
  const key = await githubCacheKey(request.pool, request, route, identity);
  await writeOwnedGitHubCache(
    env,
    key,
    request,
    { ...route, ...(fixture.completedAttempt ? { run_attempt_completed: true } : {}) },
    {
      status: 200,
      headers: { "x-ratelimit-resource": "core" },
      body: fixture.body,
      body_encoding: "json",
    },
    identity,
  );
  if (publicProof) await seedPublicRepoProof(env, route);
  return { request, key };
}

describe("immutable live cache reads", () => {
  it.each([
    {
      path: `${REPO}/commits/${SHA}`,
      body: { sha: SHA, commit: { comment_count: 0 } },
      updated: { sha: SHA, commit: { comment_count: 1 } },
    },
    {
      path: `${REPO}/compare/${SHA}...${"b".repeat(40)}`,
      body: { commits: [{ sha: SHA, commit: { comment_count: 0 } }] },
      updated: { commits: [{ sha: SHA, commit: { comment_count: 1 } }] },
    },
    {
      path: `${REPO}/git/commits/${SHA}`,
      body: { sha: SHA, verification: { verified: false, reason: "unknown_key" } },
      updated: { sha: SHA, verification: { verified: true, reason: "valid" } },
    },
  ])("refreshes mutable metadata at the same SHA for $path", async (fixture) => {
    await seed(fixture);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        jsonResponse(fixture.updated, 200, rateHeaders({ remaining: 4_999 })),
      ),
    );
    const response = await relay(fixture.path, undefined, { headers: LIVE });
    expect(await response.json()).toMatchObject({
      body: fixture.updated,
      relay: { cache: "miss" },
    });
  });

  it.each([
    { path: `${REPO}/actions/runs/42/attempts/2`, body: { status: "completed" } },
    {
      path: `${REPO}/actions/runs/42/attempts/2/jobs`,
      body: { total_count: 1, jobs: [{ status: "completed" }] },
      completedAttempt: true,
    },
    { path: `${REPO}/actions/jobs/7`, body: { status: "completed" } },
  ])("observes deletion of completed Actions data for $path", async (fixture) => {
    await seed(fixture);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (new URL(new Request(input, init).url).pathname === REPO) {
          return jsonResponse({ private: false });
        }
        return jsonResponse({ message: "Not Found" }, 404, rateHeaders({ remaining: 4_999 }));
      }),
    );
    const response = await relay(fixture.path, undefined, { headers: LIVE });
    expect(await response.json()).toMatchObject({ status: 404, body: { message: "Not Found" } });
  });

  it("applies current string-rewrite protection before reusing immutable content", async () => {
    const fixture = immutable[0]!;
    await seed(fixture);
    expect(
      (
        await callWorker("/v1/admin/string-rewrites", {
          method: "PUT",
          headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
          body: JSON.stringify({
            schema_version: 1,
            expected_revision: 1,
            rules: [{ pattern: "immutable-fixture", replacement: "public" }],
          }),
        })
      ).status,
    ).toBe(200);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await relay(fixture.path, undefined, { headers: LIVE });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  describe.each(["anonymous", "identity"])("%s source", (source) => {
    it.each(immutable)(
      "serves $path without upstream work and preserves creation proof",
      async (fixture) => {
        const { key } = await seed(fixture, source);
        const row = await env.DB.prepare(
          "SELECT created_at FROM github_cache_entries WHERE cache_key = ?",
        )
          .bind(key)
          .first<{ created_at: string }>();
        const upstream = vi.fn<typeof fetch>(async () => {
          throw new Error("Unexpected upstream fetch");
        });
        vi.stubGlobal("fetch", upstream);
        for (const layer of ["edge", "D1"]) {
          if (layer === "D1") await deleteEdgeJSON("github-publication-v1", key);
          const result = await relay(fixture.path, undefined, {
            ...(fixture.query === undefined ? {} : { query: fixture.query }),
            headers: LIVE,
          });
          expect(await result.json()).toMatchObject({
            body: fixture.body,
            relay: {
              cache: "hit",
              cache_created_at: new Date(`${row!.created_at}Z`).toISOString(),
            },
          });
          expect(upstream).not.toHaveBeenCalled();
          expect(
            await env.DB.prepare(
              "SELECT cache_status, requested_max_age, fallback_reason, cache_miss_reason FROM audit_events ORDER BY rowid DESC LIMIT 1",
            ).first(),
          ).toEqual({
            cache_status: "hit",
            requested_max_age: 0,
            fallback_reason: "immutable_live",
            cache_miss_reason: null,
          });
        }
      },
    );
  });

  it.each(immutable)("runs the public-repository guard for $path", async (fixture) => {
    await seed(fixture, "anonymous", false);
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(new Request(input, init).url).pathname).toBe(REPO);
      return jsonResponse({ private: true });
    });
    vi.stubGlobal("fetch", upstream);
    const result = await relay(fixture.path, undefined, {
      ...(fixture.query === undefined ? {} : { query: fixture.query }),
      headers: LIVE,
    });
    expect(result.status).toBe(424);
    expect(await result.json()).toMatchObject({
      error: { details: { reason: "repo_not_public" } },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: `${REPO}/actions/runs/42`, body: { status: "completed" } },
    { path: `${REPO}/actions/runs/42/attempts/2`, body: { status: "in_progress" } },
    {
      path: `${REPO}/actions/runs/42/attempts/2/jobs`,
      body: { jobs: [{ status: "in_progress" }] },
    },
    { path: `${REPO}/actions/runs/42/attempts/2/jobs`, body: { jobs: [{ status: "completed" }] } },
    { path: `${REPO}/actions/runs/42/jobs`, body: { jobs: [{ status: "completed" }] } },
    { path: `${REPO}/actions/jobs/7`, body: { status: "in_progress" } },
    { path: `${REPO}/commits/${SHA}/check-runs`, body: { check_runs: [{ status: "completed" }] } },
    {
      path: `${REPO}/commits/${SHA}/check-suites`,
      body: { check_suites: [{ status: "completed" }] },
    },
    { path: `${REPO}/commits/${SHA}/status`, body: { state: "success" } },
    { path: `${REPO}/commits/${SHA}/statuses`, body: [{ state: "success" }] },
    { path: `${REPO}/contents/file.txt`, query: { ref: "main" }, body: { sha: SHA } },
    { path: `${REPO}/commits/${SHA.slice(0, 7)}`, body: { sha: SHA } },
    { path: `${REPO}/compare/main...${SHA}`, body: { commits: [] } },
  ])("keeps $path with $body live", async (fixture) => {
    await seed(fixture);
    const upstream = vi.fn<typeof fetch>(async () =>
      jsonResponse(fixture.body, 200, rateHeaders({ remaining: 4_999 })),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      await (
        await relay(fixture.path, undefined, {
          ...(fixture.query === undefined ? {} : { query: fixture.query }),
          headers: LIVE,
        })
      ).json(),
    ).toMatchObject({ relay: { cache: "miss" } });
    expect(upstream).toHaveBeenCalled();
  });

  it.each(["if-none-match", "if-modified-since"])(
    "keeps %s requests on the conditional path",
    async (header) => {
      const fixture = immutable[0]!;
      await seed(fixture);
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === REPO) return jsonResponse({ private: false });
        expect(request.headers.get(header)).toBe("validator");
        return jsonResponse(fixture.body, 200, rateHeaders({ remaining: 4_999 }));
      });
      vi.stubGlobal("fetch", upstream);
      expect(
        await (
          await relay(fixture.path, undefined, {
            ...(fixture.query === undefined ? {} : { query: fixture.query }),
            headers: { ...LIVE, [header]: "validator" },
          })
        ).json(),
      ).toMatchObject({ relay: { cache: "bypass" } });
      expect(upstream).toHaveBeenCalled();
    },
  );

  it.each([
    { age: 120, ttl: 86_400, maxAge: 60 },
    { age: 86_500, ttl: 86_400, maxAge: 0 },
  ])("preserves expiry and positive max-age: $maxAge at age $age", async ({ age, ttl, maxAge }) => {
    const fixture = immutable[1]!;
    const { key } = await seed(fixture);
    await env.DB.prepare(
      "UPDATE github_cache_entries SET created_at = datetime('now', ?), expires_at = datetime('now', ?) WHERE cache_key = ?",
    )
      .bind(`-${age} seconds`, `${ttl - age} seconds`, key)
      .run();
    await deleteEdgeJSON("github-publication-v1", key);
    const upstream = vi.fn<typeof fetch>(async (input, init) =>
      jsonResponse(
        new URL(new Request(input, init).url).pathname === REPO ? { private: false } : fixture.body,
        200,
        rateHeaders({ remaining: 4_999 }),
      ),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      await (
        await relay(fixture.path, undefined, { headers: { "cache-control": `max-age=${maxAge}` } })
      ).json(),
    ).toMatchObject({ relay: { cache: "miss" } });
    expect(upstream).toHaveBeenCalled();
  });

  it("rejects a retired identity's immutable entry", async () => {
    const fixture = immutable[0]!;
    await seed(fixture, "identity");
    await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = 'primary'").run();
    const upstream = vi.fn<typeof fetch>(async () =>
      jsonResponse(fixture.body, 200, rateHeaders({ remaining: 4_999 })),
    );
    vi.stubGlobal("fetch", upstream);
    expect(
      await (
        await relay(fixture.path, undefined, {
          ...(fixture.query === undefined ? {} : { query: fixture.query }),
          headers: LIVE,
        })
      ).json(),
    ).toMatchObject({
      relay: { cache: "miss" },
    });
    expect(upstream).toHaveBeenCalled();
  });
});
