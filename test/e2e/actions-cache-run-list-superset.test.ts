import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { historicalHead, runCard } from "../fixtures/actions-ownership";
import { GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { queries } from "../../src/generated/sql";
import { observePublicationD1 } from "./publication-d1-observer";
import { requestWithEnv } from "./identity-routing-support";

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

const RUNS_PATH = "/repos/openclaw/octopool/actions/runs";

describe("Actions run-list superset", () => {
  beforeEach(seedPool);

  it("preserves capped totals through public fills and smaller unfiltered cache hits", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(new Request(input, init).url).hostname).toBe("github.com");
      return new Response(
        runListHTML(
          2500,
          Array.from(
            { length: 25 },
            (_, index) => [index + 1, "main", "completed successfully"] as [number, string, string],
          ),
        ).replace("2500 workflow runs", "2,500+ workflow runs"),
      );
    });
    vi.stubGlobal("fetch", upstream);
    const first = await shapedRunList({ limit: "2" });
    expect(first.body).toMatchObject({ total_count: 2500 });
    expect(runIDs(first.body)).toEqual([1, 2]);
    const cached = await shapedRunList({ limit: "1" });
    expect(cached.body).toMatchObject({ total_count: 2500 });
    expect(runIDs(cached.body)).toEqual([1]);
    expect(cached.relay.cache).toBe("hit");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each<{
    scenario: string;
    expected: "hit" | "miss" | "exact" | "denied";
    identity?: boolean;
    workflow?: boolean;
    filter?: "branch" | "status" | "late";
    page?: { size: number; total?: number | string; link?: string };
    expectedIDs?: number[];
    expectedTotal?: number;
    constraint?:
      | "expired"
      | "age"
      | "live"
      | "revoked"
      | "scope"
      | "media"
      | "version"
      | "raw"
      | "conditional"
      | "probe"
      | "visibility"
      | "identity-outage";
  }>([
    { scenario: "anonymous page", expected: "hit" },
    { scenario: "pooled page", identity: true, expected: "hit" },
    { scenario: "workflow page", workflow: true, expected: "hit" },
    { scenario: "branch prefix", filter: "branch", expected: "hit" },
    { scenario: "status prefix", filter: "status", expected: "hit" },
    { scenario: "matches beyond the prefix", filter: "late", expected: "exact" },
    { scenario: "expired source", constraint: "expired", expected: "miss" },
    { scenario: "explicit age limit", constraint: "age", expected: "miss" },
    { scenario: "forced live read", constraint: "live", expected: "miss" },
    {
      scenario: "revoked source identity",
      identity: true,
      constraint: "revoked",
      expected: "miss",
    },
    { scenario: "removed source scope", identity: true, constraint: "scope", expected: "miss" },
    { scenario: "different media", constraint: "media", expected: "miss" },
    { scenario: "different API version", constraint: "version", expected: "miss" },
    { scenario: "unshaped REST source", constraint: "raw", expected: "miss" },
    { scenario: "conditional read", constraint: "conditional", expected: "miss" },
    { scenario: "incomplete short page", page: { size: 20, total: 2000 }, expected: "miss" },
    {
      scenario: "complete short page",
      page: { size: 9, total: 9 },
      expected: "hit",
      expectedTotal: 9,
    },
    {
      scenario: "complete short workflow page",
      workflow: true,
      page: { size: 9, total: 9 },
      expected: "hit",
      expectedTotal: 9,
    },
    {
      scenario: "complete short pooled page",
      identity: true,
      page: { size: 9, total: 9 },
      expected: "hit",
      expectedTotal: 9,
    },
    {
      scenario: "complete empty page",
      page: { size: 0, total: 0 },
      expected: "hit",
      expectedIDs: [],
      expectedTotal: 0,
    },
    {
      scenario: "complete empty workflow page",
      workflow: true,
      page: { size: 0, total: 0 },
      expected: "hit",
      expectedIDs: [],
      expectedTotal: 0,
    },
    {
      scenario: "complete short filtered page",
      filter: "branch",
      page: { size: 9, total: 9 },
      expected: "hit",
      expectedTotal: 5,
    },
    {
      scenario: "complete empty filtered underfill",
      filter: "late",
      page: { size: 0, total: 0 },
      expected: "exact",
      expectedIDs: [],
      expectedTotal: 0,
    },
    {
      scenario: "short page with pagination link",
      page: { size: 9, total: 9, link: '<https://api.github.com/next>; rel="next"' },
      expected: "miss",
    },
    { scenario: "short page without total", page: { size: 9 }, expected: "miss" },
    { scenario: "short page with string total", page: { size: 9, total: "9" }, expected: "miss" },
    {
      scenario: "complete short page forced live",
      page: { size: 9, total: 9 },
      constraint: "live",
      expected: "miss",
    },
    { scenario: "optional probe failure", constraint: "probe", expected: "miss" },
    { scenario: "visibility denial", constraint: "visibility", expected: "denied" },
    {
      scenario: "anonymous hit during identity outage",
      constraint: "identity-outage",
      expected: "hit",
    },
  ])(
    "reuses a larger shaped page without changing the small-page contract: $scenario",
    async (test) => {
      const path = test.workflow
        ? "/repos/openclaw/octopool/actions/workflows/ci.yml/runs"
        : RUNS_PATH;
      const page = test.page ?? {
        size: 100,
        total: 2000,
        link: '<https://api.github.com/next>; rel="next"',
      };
      const runs = Array.from({ length: page.size }, (_, i) =>
        run(
          i + 1,
          i < 25 ? (i % 2 === 0 ? "main" : "other") : "late",
          "completed",
          i % 2 === 0 ? "success" : "failure",
        ),
      );
      let warming = true;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (bearer(request) === "test-org-token")
          return jsonResponse({ private: test.constraint === "visibility" && !warming });
        if (url.hostname === "github.com") return jsonResponse({}, 404);
        if (test.identity && warming && bearer(request) !== "test-primary-token")
          return jsonResponse({}, 503);
        const filtered = runs.filter(
          (item) =>
            (!url.searchParams.has("branch") ||
              item.head_branch === url.searchParams.get("branch")) &&
            (!url.searchParams.has("status") || item.conclusion === url.searchParams.get("status")),
        );
        return jsonResponse(
          {
            total_count: page.total,
            workflow_runs: filtered.slice(0, Number(url.searchParams.get("per_page") ?? 30)),
          },
          200,
          {
            etag: '"source-page"',
            ...(page.link === undefined ? {} : { Link: page.link }),
          },
        );
      });
      vi.stubGlobal("fetch", upstream);
      const shape = { "x-octopool-public-shape": "actions-summary-v1" };
      const warm = await relay(path, undefined, {
        query: { page: "1", per_page: "100" },
        headers: test.constraint === "raw" ? {} : shape,
      });
      expect(warm.status).toBe(200);
      const source = await env.DB.prepare("SELECT * FROM github_cache_entries").first<{
        cache_key: string;
        expires_at: string;
      }>();
      expect(source).not.toBeNull();
      const key = source!.cache_key;
      if (test.constraint === "expired" || test.constraint === "age") {
        await env.DB.prepare(
          `UPDATE github_cache_entries SET created_at = datetime('now', '-180 seconds'), expires_at = datetime('now', '${test.constraint === "expired" ? "-1 second" : "+30 seconds"}') WHERE cache_key = ?`,
        )
          .bind(key)
          .run();
      }
      if (test.constraint === "revoked")
        await env.DB.prepare(
          "UPDATE identities SET status = 'disabled' WHERE id = 'primary'",
        ).run();
      if (test.constraint === "scope")
        await env.DB.prepare("DELETE FROM identity_scopes WHERE identity_id = 'primary'").run();
      if (test.constraint === "identity-outage")
        await env.DB.prepare("ALTER TABLE identities RENAME TO unavailable_identities").run();
      if (test.constraint === "visibility") {
        await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
        await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
      }
      await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
      const before = await env.DB.prepare("SELECT * FROM github_cache_entries").all();
      warming = false;
      upstream.mockClear();
      const query = {
        limit: "2",
        ...(test.filter === "branch" ? { branch: "main" } : {}),
        ...(test.filter === "status" ? { status: "failure" } : {}),
        ...(test.filter === "late" ? { branch: "late" } : {}),
      };
      const options = {
        query,
        headers: {
          ...shape,
          ...(test.constraint === "age" ? { "cache-control": "max-age=30" } : {}),
          ...(test.constraint === "live" ? { "cache-control": "max-age=0" } : {}),
          ...(test.constraint === "media" ? { accept: "application/vnd.github.raw+json" } : {}),
          ...(test.constraint === "version" ? { "x-github-api-version": "2099-01-01" } : {}),
          ...(test.constraint === "conditional" ? { "if-none-match": '"other"' } : {}),
        },
      };
      let failedProbes = 0;
      const db = observePublicationD1(env.DB, {
        before: async (sql, values) => {
          if (sql === queries.readGitHubCache && values[0] === key) {
            failedProbes++;
            throw new Error("synthetic larger-page cache read failure");
          }
        },
      });
      const response =
        test.constraint === "probe"
          ? await requestWithEnv({ DB: db }, path, options)
          : await relay(path, undefined, options);
      if (test.constraint === "probe") expect(failedProbes).toBe(1);
      if (test.expected === "denied") {
        expect(response.status).toBe(424);
        expect(await response.json()).toMatchObject({
          error: { details: { reason: "repo_not_public" } },
        });
        expect(upstream).toHaveBeenCalledOnce();
        return;
      }
      expect(response.status).toBe(200);
      const result = await response.json<RelayEnvelope>();
      expect(result.relay.cache).toBe(
        test.constraint === "conditional" ? "bypass" : test.expected === "hit" ? "hit" : "miss",
      );
      expect(runIDs(result.body)).toEqual(
        test.expectedIDs ??
          (test.filter === "late"
            ? [26, 27]
            : test.filter === "branch"
              ? [1, 3]
              : test.filter === "status"
                ? [2, 4]
                : [1, 2]),
      );
      if (test.expected === "hit") {
        expect(result.body).toMatchObject({
          total_count:
            test.expectedTotal ??
            (test.filter === "branch" ? 13 : test.filter === "status" ? 12 : page.total),
        });
        expect(result.relay).toMatchObject({ cache_expires_at: source!.expires_at });
        expect(result.headers).not.toHaveProperty("etag");
        expect(result.headers).not.toHaveProperty("link");
        expect(upstream).not.toHaveBeenCalled();
        // A derived hit neither publishes an alias nor refreshes its source receipt or TTL.
        expect((await env.DB.prepare("SELECT * FROM github_cache_entries").all()).results).toEqual(
          before.results,
        );
      } else {
        expect(upstream).toHaveBeenCalled();
        if (test.expected === "exact") {
          expect(result.body).toMatchObject({ total_count: test.expectedTotal ?? 2000 });
          const urls = upstream.mock.calls.map(
            ([input, init]) => new URL(new Request(input, init).url),
          );
          expect(urls).toHaveLength(1);
          expect(urls[0]!.searchParams.get("branch")).toBe("late");
        }
        if (test.constraint === "probe") {
          expect((await relay(path, undefined, options)).status).toBe(200);
          const rows = await env.DB.prepare("SELECT query_json FROM github_cache_entries").all<{
            query_json: string;
          }>();
          expect(rows.results.some((row) => JSON.parse(row.query_json).per_page === "25")).toBe(
            true,
          );
        }
      }
    },
  );

  it.each<{
    scenario: string;
    identity?: boolean;
    missingCanonical?: boolean;
    exact: "fresh" | "stale" | "missing" | "revoked" | "short";
    statusFilter?: boolean;
    workflow?: boolean;
    maxAge?: number;
    backendAvailable?: boolean;
    identityUnavailable?: boolean;
    probeFailure?: "fresh" | "stale";
    privateRepo?: boolean;
    expected: "hit" | "stale" | "miss" | "denied";
  }>([
    { scenario: "fresh anonymous exact entry", exact: "fresh", expected: "hit" },
    {
      scenario: "identity outage with anonymous hit",
      exact: "fresh",
      identityUnavailable: true,
      expected: "hit",
    },
    {
      scenario: "identity outage with anonymous fill",
      exact: "missing",
      identityUnavailable: true,
      backendAvailable: true,
      expected: "miss",
    },
    {
      scenario: "optional fresh exact probe failure",
      exact: "fresh",
      probeFailure: "fresh",
      backendAvailable: true,
      expected: "hit",
    },
    {
      scenario: "optional stale exact probe failure",
      exact: "stale",
      probeFailure: "stale",
      expected: "denied",
    },
    {
      scenario: "visibility denial from exact proof",
      exact: "fresh",
      privateRepo: true,
      backendAvailable: true,
      expected: "denied",
    },
    {
      scenario: "fresh exact while upstream is healthy",
      exact: "fresh",
      backendAvailable: true,
      expected: "hit",
    },
    { scenario: "fresh pooled exact entry", identity: true, exact: "fresh", expected: "hit" },
    {
      scenario: "missing canonical entry",
      missingCanonical: true,
      exact: "fresh",
      expected: "hit",
    },
    { scenario: "status filter", statusFilter: true, exact: "fresh", expected: "hit" },
    { scenario: "legitimately short exact result", exact: "short", expected: "hit" },
    { scenario: "stale anonymous exact entry", exact: "stale", expected: "stale" },
    {
      scenario: "stale exact entry without canonical data",
      missingCanonical: true,
      exact: "stale",
      expected: "stale",
    },
    {
      scenario: "stale pooled workflow entry",
      identity: true,
      workflow: true,
      exact: "stale",
      expected: "stale",
    },
    { scenario: "missing exact entry", exact: "missing", expected: "denied" },
    { scenario: "revoked exact identity", identity: true, exact: "revoked", expected: "denied" },
    { scenario: "explicit live read", exact: "fresh", maxAge: 0, expected: "denied" },
    {
      scenario: "stale entry beyond requested age",
      exact: "stale",
      maxAge: 30,
      expected: "denied",
    },
  ])("selects complete filtered cache data: $scenario", async (test) => {
    const path = test.workflow
      ? "/repos/openclaw/octopool/actions/workflows/ci.yml/runs"
      : RUNS_PATH;
    const filter: Record<string, string> = test.statusFilter
      ? { status: "failure" }
      : { branch: "target" };
    const query = { ...filter, limit: "2" };
    const exactRuns = [run(101, "target", "completed", "failure")];
    if (test.exact !== "short") exactRuns.push(run(102, "target", "completed", "failure"));
    const total = test.exact === "short" ? 1 : 10;
    let outage = false;
    let privateNow = false;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const token = bearer(request);
      if (token === "test-org-token") return jsonResponse({ private: privateNow });
      if (url.hostname === "github.com") return jsonResponse({}, 404);
      expect(url.pathname).toBe(path);
      if (outage) {
        return token === "test-primary-token"
          ? jsonResponse({ message: "rate limited" }, 429, rateHeaders({ remaining: 0 }))
          : jsonResponse({ message: "unavailable" }, 503);
      }
      const filtered = url.searchParams.has("branch") || url.searchParams.has("status");
      if (!filtered) {
        return jsonResponse({
          total_count: 200,
          workflow_runs: Array.from({ length: 25 }, (_, i) => run(i + 1, "other", "queued", null)),
        });
      }
      if (test.identity && token !== "test-primary-token") return jsonResponse({}, 503);
      return jsonResponse({ total_count: total, workflow_runs: exactRuns });
    });
    vi.stubGlobal("fetch", upstream);
    const headers = { "x-octopool-public-shape": "actions-summary-v1" };
    const warm = await relay(path, undefined, { query, headers });
    expect(warm.status).toBe(200);
    expect(runIDs((await warm.json<RelayEnvelope>()).body)).toEqual(exactRuns.map((run) => run.id));

    const rows = await env.DB.prepare(
      "SELECT cache_key, query_json FROM github_cache_entries",
    ).all<{ cache_key: string; query_json: string }>();
    expect(rows.results).toHaveLength(2);
    let exactKey = "";
    for (const row of rows.results) {
      const savedQuery = JSON.parse(row.query_json) as Record<string, string>;
      const exact = savedQuery.branch !== undefined || savedQuery.status !== undefined;
      if (exact) exactKey = row.cache_key;
      if ((!exact && test.missingCanonical) || (exact && test.exact === "missing")) {
        await env.DB.prepare("DELETE FROM github_cache_entries WHERE cache_key = ?")
          .bind(row.cache_key)
          .run();
      } else if (!exact || ["stale", "revoked"].includes(test.exact)) {
        await env.DB.prepare(
          "UPDATE github_cache_entries SET created_at = datetime('now', '-180 seconds'), expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+5 minutes') WHERE cache_key = ?",
        )
          .bind(row.cache_key)
          .run();
      }
      await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row.cache_key);
    }
    if (test.exact === "revoked") {
      await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = 'primary'").run();
    }
    if (test.identityUnavailable) {
      await env.DB.prepare("ALTER TABLE identities RENAME TO unavailable_identities").run();
    }
    if (test.privateRepo) {
      await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
      await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
      privateNow = true;
    }
    outage = !test.backendAvailable;
    upstream.mockClear();
    const options = {
      query,
      headers: {
        ...headers,
        ...(test.maxAge === undefined ? {} : { "cache-control": `max-age=${test.maxAge}` }),
      },
    };
    let probeFailures = 0;
    const db = observePublicationD1(env.DB, {
      before: async (sql, values) => {
        const target =
          test.probeFailure === "fresh" ? queries.readGitHubCache : queries.readGitHubCacheAny;
        if (
          sql === target &&
          values[0] === exactKey &&
          (test.probeFailure === "stale" || probeFailures === 0)
        ) {
          probeFailures++;
          throw new Error("synthetic optional exact-cache read failure");
        }
      },
    });
    const response = test.probeFailure
      ? await requestWithEnv({ DB: db }, path, options)
      : await relay(path, undefined, options);
    if (test.probeFailure) expect(probeFailures).toBeGreaterThan(0);
    if (test.expected === "denied") {
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: {
          code: "fallback_local",
          ...(test.privateRepo
            ? { details: { reason: "repo_not_public" } }
            : test.probeFailure
              ? { details: { reason: "github_rate_limited" } }
              : {}),
        },
      });
      if (test.privateRepo) expect(upstream).toHaveBeenCalledOnce();
    } else {
      expect(response.status).toBe(200);
      const result = await response.json<RelayEnvelope>();
      expect(runIDs(result.body)).toEqual(exactRuns.map((run) => run.id));
      expect(result.body).toMatchObject({ total_count: total });
      expect(result.relay.cache).toBe(test.expected);
      if (test.expected === "hit" && !test.probeFailure) expect(upstream).not.toHaveBeenCalled();
    }
  });

  it("owns misleading metadata through canonical fill, filtering, hits, and active TTL", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        urls.push(request.url);
        if (new URL(request.url).hostname === "api.github.com") {
          return jsonResponse({
            total_count: 1,
            workflow_runs: [run(103, "main", "completed", "failure")],
          });
        }
        return new Response(
          `<strong>2 workflow runs</strong>${
            runCard(101, historicalHead, {
              state: "in progress",
              title: "Fix failed test: Handle pushed commits",
              workflow: "scheduled workflow dispatch",
              branch: "completed successfully pushed",
            }) + runCard(102, historicalHead, { state: "queued", title: "cancelled pull request" })
          }`.replaceAll("openclaw/Peekaboo", "openclaw/octopool"),
        );
      }),
    );
    const first = await shapedRunList({ limit: "2" });
    expect(first.body).toMatchObject({
      total_count: 2,
      workflow_runs: [
        {
          id: 101,
          status: "in_progress",
          conclusion: null,
          event: "pull_request",
          head_sha: historicalHead,
        },
        { id: 102, status: "queued", conclusion: null, event: "pull_request" },
      ],
    });
    expect(first.relay.cache).toBe("miss");
    expect(
      await env.DB.prepare(
        "SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl FROM github_cache_entries WHERE route_kind = 'run_list'",
      ).first(),
    ).toEqual({ ttl: 60 });
    const active = await shapedRunList({ status: "in_progress", limit: "1" });
    expect(runIDs(active.body)).toEqual([101]);
    expect(active.relay.cache).toBe("hit");
    const completed = await shapedRunList({ status: "completed", limit: "1" });
    expect(runIDs(completed.body)).toEqual([103]);
    expect(runIDs((await shapedRunList({ status: "completed", limit: "1" })).body)).toEqual([103]);
    expect(urls.map((url) => new URL(url).origin + new URL(url).pathname)).toEqual([
      "https://github.com/openclaw/octopool/actions",
      "https://api.github.com/repos/openclaw/octopool/actions/runs",
    ]);
    expect(Object.fromEntries(new URL(urls[1]!).searchParams)).toEqual({
      status: "completed",
      per_page: "1",
    });
    const repeated = await shapedRunList({ limit: "2" });
    expect(repeated.body).toEqual(first.body);
    expect(repeated.relay.cache).toBe("hit");
  });

  it.each([
    ["completed successfully", "success"],
    ["failed", "failure"],
    ["timed out", "timed_out"],
    ["startup failure", "startup_failure"],
  ])("keeps owned terminal %s metadata and the completed list TTL", async (state, conclusion) => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<strong>1 workflow run</strong>${runCard(101, historicalHead, {
            state,
            title: "queued cancelled failed pushed",
            workflow: "pending scheduled",
            branch: "in progress",
          })}`.replaceAll("openclaw/Peekaboo", "openclaw/octopool"),
        ),
    );
    vi.stubGlobal("fetch", upstream);
    const first = await shapedRunList({ limit: "1" });
    expect(first.body).toMatchObject({
      workflow_runs: [{ id: 101, status: "completed", conclusion, event: "pull_request" }],
    });
    expect(
      await env.DB.prepare(
        "SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl FROM github_cache_entries WHERE route_kind = 'run_list'",
      ).first(),
    ).toEqual({ ttl: 120 });
    expect((await shapedRunList({ status: "completed", limit: "1" })).relay.cache).toBe("hit");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown status", "not failed", "pull request"],
    ["conflicting status", "queued failed", "pull request"],
    ["missing trigger", "in progress", ""],
    ["conflicting trigger", "in progress", "pull request pushed"],
    ["unknown trigger", "in progress", "repository dispatch"],
    [
      "linked prose",
      "in progress",
      '<a href="/openclaw/octopool/tree/refs/heads/pull-request">pull request</a>',
    ],
  ])("uses exact REST and caches its metadata for %s", async (_name, state, trigger) => {
    const urls: string[] = [];
    const body = {
      total_count: 1,
      workflow_runs: [{ ...run(301, "main", "queued", null), event: "workflow_dispatch" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(bearer(request)).toBeUndefined();
        urls.push(request.url);
        return new URL(request.url).hostname === "github.com"
          ? new Response(
              `<strong>1 workflow run</strong>${runCard(101, historicalHead, { state, trigger, title: "completed successfully pushed" })}`.replaceAll(
                "openclaw/Peekaboo",
                "openclaw/octopool",
              ),
            )
          : jsonResponse(body);
      }),
    );
    expect((await shapedRunList({ limit: "1" })).body).toEqual(body);
    expect((await shapedRunList({ limit: "1" })).relay.cache).toBe("hit");
    expect(urls).toEqual([
      "https://github.com/openclaw/octopool/actions",
      "https://api.github.com/repos/openclaw/octopool/actions/runs?page=1&per_page=25",
    ]);
  });

  it("serves branch, status, and limit variants from one canonical fill", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(bearer(request)).toBeUndefined();
      const url = new URL(request.url);
      expect(url.hostname).toBe("github.com");
      expect(url.pathname).toBe("/openclaw/octopool/actions");
      expect(Object.fromEntries(url.searchParams)).toEqual({});
      return new Response(
        runListHTML(4, [
          [1, "main", "completed successfully"],
          [2, "main", "failed"],
          [3, "feature", "in progress"],
          [4, "main", "queued"],
        ]),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const branch = await shapedRunList({ branch: "main", per_page: "2" });
    expect(branch.body).toMatchObject({ total_count: 3 });
    expect(runIDs(branch.body)).toEqual([1, 2]);

    const status = await shapedRunList({ status: "failure", per_page: "1" });
    expect(status.body).toMatchObject({ total_count: 1 });
    expect(runIDs(status.body)).toEqual([2]);

    const limited = await shapedRunList({ limit: "1" });
    expect(limited.body).toMatchObject({ total_count: 4 });
    expect(runIDs(limited.body)).toEqual([1]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT backend FROM audit_events WHERE cache_status = 'miss' LIMIT 1",
      ).first(),
    ).toEqual({ backend: "github_web" });
  });

  it("normalizes and locally shapes a conditional shim request", async () => {
    let exactURL: URL | undefined;
    let conditionalHeader: string | null = null;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (bearer(request) === "test-primary-token") {
        exactURL = new URL(request.url);
        conditionalHeader = request.headers.get("if-none-match");
        return jsonResponse(
          {
            total_count: 100,
            workflow_runs: [
              run(1, "main", "completed", "success"),
              run(2, "main", "completed", "success"),
              run(3, "main", "completed", "success"),
            ],
          },
          200,
          {
            etag: '"upstream"',
            "last-modified": "Sat, 18 Jul 2026 08:00:00 GMT",
            link: '<https://api.github.com/repositories/1/actions/runs?page=2>; rel="next"',
          },
        );
      }
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { limit: "2" },
      headers: {
        "x-octopool-public-shape": "actions-summary-v1",
        "if-none-match": '"client"',
      },
    });
    expect(response.status).toBe(200);
    const envelope = await response.json<RelayEnvelope>();
    expect(runIDs(envelope.body)).toEqual([1, 2]);
    expect(envelope.body).toMatchObject({ total_count: 100 });
    expect(envelope.headers).not.toHaveProperty("etag");
    expect(envelope.headers).not.toHaveProperty("last-modified");
    expect(envelope.headers).not.toHaveProperty("link");
    expect(Object.fromEntries(exactURL!.searchParams)).toEqual({ per_page: "2" });
    expect(conditionalHeader).toBe('"client"');
  });

  it("falls back to an exact filtered request when the superset can underfill", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      if (url.hostname === "api.github.com") {
        return jsonResponse({
          total_count: 3,
          workflow_runs: [
            run(101, "target", "completed", "success"),
            run(102, "target", "completed", "success"),
            run(103, "target", "completed", "success"),
          ],
        });
      }
      return new Response(
        runListHTML(
          200,
          Array.from({ length: 25 }, (_, index) => [index + 1, "main", "completed successfully"]),
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await shapedRunList({ branch: "target", limit: "2" });
    expect(runIDs(response.body)).toEqual([101, 102]);
    expect(urls).toHaveLength(2);
    expect(urls.map((url) => url.hostname)).toEqual(["github.com", "api.github.com"]);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({});
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({
      branch: "target",
      per_page: "2",
    });
  });

  it("does not treat a page-sized total as proof that a filter is complete", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(new Request(input).url);
      urls.push(url);
      if (url.hostname === "api.github.com") {
        return jsonResponse({
          total_count: 20,
          workflow_runs: Array.from({ length: 20 }, (_, index) =>
            run(index + 100, "main", "completed", "failure"),
          ),
        });
      }
      return new Response(
        runListHTML(
          25,
          Array.from({ length: 25 }, (_, index) => [index + 1, "main", "completed successfully"]),
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await shapedRunList({ status: "failure", limit: "20" });
    expect(runIDs(response.body)).toHaveLength(20);
    expect(urls.map((url) => url.hostname)).toEqual(["github.com", "api.github.com"]);
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({
      per_page: "20",
      status: "failure",
    });
  });

  it("preserves GitHub validation for unsupported status values", async () => {
    const apiRequests: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (url.hostname === "github.com") {
        return new Response("not found", { status: 404 });
      }
      apiRequests.push(url);
      return jsonResponse({ message: "Validation Failed" }, 422);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { status: "not-a-github-status" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 422,
      body: { message: "Validation Failed" },
    });
    expect(apiRequests).toHaveLength(2);
    for (const url of apiRequests) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ status: "not-a-github-status" });
    }
  });

  it("shares workflow-scoped variants through one public page fill", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      expect(url.hostname).toBe("github.com");
      return new Response(
        runListHTML(2, [
          [9, "main", "completed successfully"],
          [10, "main", "completed successfully"],
        ]),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { branch: "main", limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect(response.status).toBe(200);
    const envelope = await response.json<RelayEnvelope>();
    expect(runIDs(envelope.body)).toEqual([9]);
    expect(envelope.body).toMatchObject({ total_count: 2 });
    const cached = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { status: "success", limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect((await cached.json<RelayEnvelope>()).relay.cache).toBe("hit");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe("/openclaw/octopool/actions/workflows/ci.yml");
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({});
  });

  it("leaves non-shim run-list requests on exact per-query caching", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      return jsonResponse({
        total_count: 1,
        workflow_runs: [run(7, "main", "completed", "success")],
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { branch: "main", per_page: "1" },
    });
    expect(response.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      branch: "main",
      per_page: "1",
    });
  });
});

async function shapedRunList(query: Record<string, string>): Promise<RelayEnvelope> {
  const response = await relay(RUNS_PATH, undefined, {
    query,
    headers: { "x-octopool-public-shape": "actions-summary-v1" },
  });
  expect(response.status).toBe(200);
  return response.json<RelayEnvelope>();
}

function run(
  id: number,
  headBranch: string,
  status: string,
  conclusion: string | null,
): Record<string, unknown> {
  return { id, head_branch: headBranch, status, conclusion };
}

function runIDs(body: unknown): number[] {
  if (typeof body !== "object" || body === null || !("workflow_runs" in body)) {
    return [];
  }
  const runs = body.workflow_runs;
  return Array.isArray(runs)
    ? runs.flatMap((item) =>
        typeof item === "object" && item !== null && "id" in item && typeof item.id === "number"
          ? [item.id]
          : [],
      )
    : [];
}

function runListHTML(total: number, runs: [id: number, branch: string, state: string][]): string {
  return `<strong>${total} workflow runs</strong>${runs
    .map(
      ([id, branch, state]) => `
        <div class="Box-row js-socket-channel js-updatable-content">
          <a href="/openclaw/octopool/actions/runs/${id}" aria-label="${state}: Run ${id} of CI. run ${id}">
            <span class="h4 markdown-title">run ${id}</span>
          </a>
          <span class="text-bold">CI</span> #${id}:
          Commit <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
          pushed
          <relative-time datetime="2026-06-11T06:38:49Z"></relative-time>
          <a class="branch-name" href="/openclaw/octopool/tree/refs/heads/${branch}">${branch}</a>
        </div>`,
    )
    .join("")}`;
}
