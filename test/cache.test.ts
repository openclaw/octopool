import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheTTLSeconds,
  githubCacheRevalidationHeaders,
  githubCacheKey,
  pruneExpiredGitHubCache,
  readGitHubCache,
  readStaleGitHubCache,
  requestCacheMaxAgeSeconds,
  shouldUseGitHubCache,
  staleCacheSeconds,
  writeGitHubCache,
} from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import type { GitHubRelayResponse } from "../src/types";

describe("github cache policy", () => {
  const policy = defaultPolicy("openclaw");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys equivalent query and header order identically", async () => {
    const left = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      query: { b: "2", a: "1" },
      headers: { accept: "application/vnd.github+json" },
    });
    const right = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      query: { a: "1", b: "2" },
      headers: { accept: "application/vnd.github+json" },
    });
    const route = classifyRoute(left, policy);
    await expect(githubCacheKey("maintainers", left, route)).resolves.toBe(
      await githubCacheKey("maintainers", right, route),
    );
  });

  it("preserves duplicate query value order in cache keys", async () => {
    const left = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/issues",
      query: { state: ["open", "closed"] },
    });
    const right = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/issues",
      query: { state: ["closed", "open"] },
    });
    const route = classifyRoute(left, policy);
    await expect(githubCacheKey("maintainers", left, route)).resolves.not.toBe(
      await githubCacheKey("maintainers", right, route),
    );
  });

  it("normalizes default query and JSON accept variants in cache keys", async () => {
    const left = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/actions/runs",
      query: { page: "1", per_page: "30" },
      headers: { accept: "application/vnd.github+json" },
    });
    const right = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/actions/runs",
      headers: { accept: "application/json" },
    });
    const route = classifyRoute(left, policy);
    await expect(githubCacheKey("maintainers", left, route)).resolves.toBe(
      await githubCacheKey("maintainers", right, route),
    );
  });

  it("keeps non-default pagination and media accepts distinct", async () => {
    const left = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341/files",
      query: { per_page: "100" },
      headers: { accept: "application/vnd.github+json" },
    });
    const right = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341/files",
      headers: { accept: "application/vnd.github.diff" },
    });
    const route = classifyRoute(left, policy);
    await expect(githubCacheKey("maintainers", left, route)).resolves.not.toBe(
      await githubCacheKey("maintainers", right, route),
    );
  });

  it("keeps public summary shapes separate from exact REST cache entries", async () => {
    const summary = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/actions/runs",
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    const exact = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/actions/runs",
    });
    const route = classifyRoute(summary, policy);

    await expect(githubCacheKey("maintainers", summary, route)).resolves.not.toBe(
      await githubCacheKey("maintainers", exact, classifyRoute(exact, policy)),
    );
  });

  it("shares exact search cache entries across the token-free policy shape", async () => {
    const shaped = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/issues",
      query: { q: "repo:openclaw/openclaw type:issue cache", per_page: "10" },
      headers: { "x-octopool-public-shape": "issue-search-v1" },
    });
    const exact = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/issues",
      query: { q: "repo:openclaw/openclaw type:issue cache", per_page: "10" },
    });

    await expect(
      githubCacheKey("maintainers", shaped, classifyRoute(shaped, policy)),
    ).resolves.toBe(
      await githubCacheKey(
        "maintainers",
        exact,
        classifyRoute(exact, { ...policy, allow_search: true }),
      ),
    );
  });

  it("uses verified PR state hints as cache-key discriminators", async () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341/files",
    });
    const plain = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341/files",
    });
    const route = {
      ...classifyRoute(request, policy),
      state_hint: "pr-head:0123456789abcdef0123456789abcdef01234567",
      state_hint_source: "live" as const,
    };
    await expect(githubCacheKey("maintainers", request, route)).resolves.not.toBe(
      await githubCacheKey("maintainers", plain, classifyRoute(plain, policy)),
    );
  });

  it("ignores malformed PR state hints", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341/files",
      route_hint: {
        pr_head_sha: "not-a-sha",
        pr_state: "surprise",
      },
    });
    expect(classifyRoute(request, policy).state_hint).toBeUndefined();
  });

  it("separates authenticated cache entries by GitHub identity", async () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
    });
    const route = classifyRoute(request, policy);

    await expect(
      githubCacheKey("maintainers", request, route, { id: "primary", kind: "pat" }),
    ).resolves.not.toBe(
      await githubCacheKey("maintainers", request, route, { id: "secondary", kind: "pat" }),
    );
    await expect(githubCacheKey("maintainers", request, route)).resolves.not.toBe(
      await githubCacheKey("maintainers", request, route, { id: "primary", kind: "pat" }),
    );
  });

  it("keeps max-age requests cacheable with an unchanged cache key", async () => {
    const bounded = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      headers: { "cache-control": "max-age=20" },
    });
    const plain = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
    });
    const route = classifyRoute(bounded, policy);
    expect(shouldUseGitHubCache(bounded, route)).toBe(true);
    await expect(githubCacheKey("maintainers", bounded, route)).resolves.toBe(
      await githubCacheKey("maintainers", plain, classifyRoute(plain, policy)),
    );
  });

  it("parses the max-age request directive", () => {
    const request = (headers?: Record<string, string>) =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/85341",
        ...(headers === undefined ? {} : { headers }),
      });
    expect(requestCacheMaxAgeSeconds(request())).toBeUndefined();
    expect(requestCacheMaxAgeSeconds(request({ "cache-control": "max-age=20" }))).toBe(20);
    expect(requestCacheMaxAgeSeconds(request({ "cache-control": "public, max-age=0" }))).toBe(0);
    expect(requestCacheMaxAgeSeconds(request({ "cache-control": "no-cache" }))).toBeUndefined();
    expect(requestCacheMaxAgeSeconds(request({ "cache-control": "max-age=oops" }))).toBeUndefined();
  });

  it("treats fresh entries beyond the requested max-age as misses", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              status: 200,
              response_headers_json: "{}",
              body_json: '{"head":{"sha":"abc"}}',
              body_encoding: "json",
              identity_id: null,
              identity_kind: null,
              created_at: sqliteUTC(Date.now() - 30_000),
              expires_at: sqliteUTC(Date.now() + 60_000),
            }),
          }),
        }),
      },
    } as unknown as Env;

    await expect(readGitHubCache(env, "cache-key", undefined, 60)).resolves.toMatchObject({
      body: { head: { sha: "abc" } },
    });
    await expect(readGitHubCache(env, "cache-key", undefined, 15)).resolves.toBeUndefined();
  });

  it("falls through a too-old edge entry to a newer D1 fill without evicting it", async () => {
    const edgeEntry = {
      status: 200,
      headers: {},
      body: { head: { sha: "old" } },
      body_encoding: "json",
      created_at: sqliteUTC(Date.now() - 30_000),
      expires_at: sqliteUTC(Date.now() + 60_000),
    };
    const edgeDelete = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => Response.json(edgeEntry)),
        put: vi.fn(async () => undefined),
        delete: edgeDelete,
      },
    });
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              status: 200,
              response_headers_json: "{}",
              body_json: '{"head":{"sha":"new"}}',
              body_encoding: "json",
              identity_id: null,
              identity_kind: null,
              created_at: sqliteUTC(Date.now() - 1_000),
              expires_at: sqliteUTC(Date.now() + 90_000),
            }),
          }),
        }),
      },
    } as unknown as Env;

    await expect(readGitHubCache(env, "cache-key", undefined, 15)).resolves.toMatchObject({
      body: { head: { sha: "new" } },
    });
    expect(edgeDelete).not.toHaveBeenCalled();
  });

  it("bypasses conditional and rate-limit reads", () => {
    const pr = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/85341",
      headers: { "if-none-match": "abc" },
    });
    expect(shouldUseGitHubCache(pr, classifyRoute(pr, policy))).toBe(false);

    const rate = validateRelayRequest({ pool: "maintainers", method: "GET", path: "/rate_limit" });
    expect(shouldUseGitHubCache(rate, classifyRoute(rate, policy))).toBe(false);
  });

  it("revalidates identity and anonymous API entries but not web entries", () => {
    const base = {
      status: 200,
      body: { id: 1 },
      body_encoding: "json" as const,
      created_at: sqliteUTC(Date.now() - 120_000),
      expires_at: sqliteUTC(Date.now() - 60_000),
    };
    expect(
      githubCacheRevalidationHeaders({
        ...base,
        headers: { etag: '"identity"' },
        identity: { id: "primary", kind: "pat" },
      }),
    ).toEqual({ "if-none-match": '"identity"' });
    expect(
      githubCacheRevalidationHeaders({
        ...base,
        headers: {
          "last-modified": "Fri, 18 Jul 2026 06:00:00 GMT",
          "x-ratelimit-resource": "core",
        },
      }),
    ).toEqual({ "if-modified-since": "Fri, 18 Jul 2026 06:00:00 GMT" });
    expect(
      githubCacheRevalidationHeaders({
        ...base,
        headers: { etag: '"web"', "last-modified": "Fri, 18 Jul 2026 06:00:00 GMT" },
      }),
    ).toBeUndefined();
  });

  it("keeps mutable CI TTLs short and caches terminal CI for an hour", () => {
    const run = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123",
      }),
      policy,
    );
    expect(cacheTTLSeconds(run, response({ status: "completed" }))).toBe(60);
    expect(cacheTTLSeconds(run, response({ status: "in_progress" }))).toBe(60);

    const runAttempt = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123/attempts/2",
      }),
      policy,
    );
    expect(cacheTTLSeconds(runAttempt, response({ status: "in_progress" }))).toBe(60);
    expect(cacheTTLSeconds(runAttempt, response({ status: "completed" }))).toBe(3_600);

    const jobs = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123/jobs",
      }),
      policy,
    );
    const attemptJobs = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123/attempts/2/jobs",
      }),
      policy,
    );
    const completedJobs = response({ jobs: [{ status: "completed" }] });
    expect(cacheTTLSeconds(jobs, completedJobs)).toBe(60);
    expect(cacheTTLSeconds(attemptJobs, completedJobs)).toBe(60);
    expect(cacheTTLSeconds({ ...attemptJobs, run_attempt_completed: true }, completedJobs)).toBe(
      3_600,
    );

    const runList = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs",
      }),
      policy,
    );
    expect(cacheTTLSeconds(runList, response({ workflow_runs: [{ status: "completed" }] }))).toBe(
      120,
    );
    expect(cacheTTLSeconds(runList, response({ workflow_runs: [] }))).toBe(60);

    const checks = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/commits/abc1234/check-runs",
      }),
      policy,
    );
    expect(cacheTTLSeconds(checks, response({ check_runs: [{ status: "completed" }] }))).toBe(
      3_600,
    );
    expect(cacheTTLSeconds(checks, response({ check_runs: [] }))).toBe(60);
    const checkSuites = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/commits/abc1234/check-suites",
      }),
      policy,
    );
    expect(
      cacheTTLSeconds(checkSuites, response({ check_suites: [{ status: "completed" }] })),
    ).toBe(3_600);
    expect(cacheTTLSeconds(checkSuites, response({ check_suites: [] }))).toBe(60);
    const statuses = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/statuses/abc1234",
      }),
      policy,
    );
    expect(cacheTTLSeconds(statuses, response([{ state: "success" }]))).toBe(3_600);
    expect(cacheTTLSeconds(statuses, response([{ state: "pending" }]))).toBe(60);
    const job = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/jobs/123",
      }),
      policy,
    );
    expect(cacheTTLSeconds(job, response({ status: "completed" }))).toBe(3_600);
    expect(cacheTTLSeconds(job, response({ status: "in_progress" }))).toBe(60);

    const files = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42/files",
      }),
      policy,
    );
    expect(cacheTTLSeconds(files, response([]))).toBe(60);
    const commits = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42/commits",
      }),
      policy,
    );
    expect(cacheTTLSeconds(commits, response([]))).toBe(300);
    const commitPulls = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/commits/abc1234/pulls",
      }),
      policy,
    );
    expect(cacheTTLSeconds(commitPulls, response([]))).toBe(300);
    const commitBranches = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/commits/abc1234/branches-where-head",
      }),
      policy,
    );
    expect(cacheTTLSeconds(commitBranches, response([]))).toBe(300);
    const stateAwareFiles = {
      ...classifyRoute(
        validateRelayRequest({
          pool: "maintainers",
          method: "GET",
          path: "/repos/openclaw/openclaw/pulls/42/files",
        }),
        policy,
      ),
      state_hint: "pr-head:0123456789abcdef0123456789abcdef01234567",
      state_hint_source: "live" as const,
    };
    expect(cacheTTLSeconds(stateAwareFiles, response([]))).toBe(300);

    const pr = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42",
      }),
      policy,
    );
    expect(cacheTTLSeconds(pr, response({ state: "closed", merged_at: null }))).toBe(120);
    expect(
      cacheTTLSeconds(pr, response({ state: "closed", merged_at: "2026-08-08T00:00:00Z" })),
    ).toBe(3_600);
    expect(cacheTTLSeconds(pr, response({ state: "open" }))).toBe(120);

    const user = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/users/openperf",
      }),
      policy,
    );
    expect(cacheTTLSeconds(user, response({ login: "openperf" }))).toBe(3_600);

    const gitRef = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/git/ref/heads/main",
      }),
      policy,
    );
    expect(cacheTTLSeconds(gitRef, response({ ref: "refs/heads/main" }))).toBe(120);

    const gitTag = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/git/tags/0123456789abcdef0123456789abcdef01234567",
      }),
      policy,
    );
    expect(gitTag.kind).toBe("git_tag");
    expect(cacheTTLSeconds(gitTag, response({ tag: "v1.2.3" }))).toBe(86_400);
    expect(staleCacheSeconds(gitTag, 86_400)).toBe(86_400);
  });

  it("caps ref-named commit route TTLs because refs move", () => {
    const classify = (path: string) =>
      classifyRoute(validateRelayRequest({ pool: "maintainers", method: "GET", path }), policy);

    const view = classify("/repos/openclaw/openclaw/commits/main");
    expect(view.kind).toBe("commit_view_ref");
    expect(cacheTTLSeconds(view, response({ sha: "abc" }))).toBe(120);

    const shaView = classify(
      "/repos/openclaw/openclaw/commits/0123456789abcdef0123456789abcdef01234567",
    );
    expect(shaView.kind).toBe("commit_view");
    expect(cacheTTLSeconds(shaView, response({ sha: "abc" }))).toBe(86_400);

    const checks = classify("/repos/openclaw/openclaw/commits/main/check-runs");
    expect(cacheTTLSeconds(checks, response({ check_runs: [{ status: "completed" }] }))).toBe(120);
    expect(cacheTTLSeconds(checks, response({ check_runs: [] }))).toBe(60);

    const checkSuites = classify("/repos/openclaw/openclaw/commits/main/check-suites");
    expect(
      cacheTTLSeconds(checkSuites, response({ check_suites: [{ status: "completed" }] })),
    ).toBe(120);
    expect(cacheTTLSeconds(checkSuites, response({ check_suites: [] }))).toBe(60);

    const status = classify("/repos/openclaw/openclaw/commits/main/status");
    expect(cacheTTLSeconds(status, response({ statuses: [{ state: "success" }] }))).toBe(120);
    expect(cacheTTLSeconds(status, response({ statuses: [{ state: "pending" }] }))).toBe(60);

    const statuses = classify("/repos/openclaw/openclaw/commits/main/statuses");
    expect(cacheTTLSeconds(statuses, response([{ state: "success" }]))).toBe(120);
    expect(cacheTTLSeconds(statuses, response([{ state: "pending" }]))).toBe(60);

    // Capped fresh TTLs stay below the terminal-CI detection threshold, so the
    // long terminal stale window never applies to ref-named routes.
    expect(staleCacheSeconds(checks, 120)).toBe(300);
    expect(staleCacheSeconds(view, 120)).toBe(300);
  });

  it("keeps bounded stale windows per route family", () => {
    const run = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123",
      }),
      policy,
    );
    expect(staleCacheSeconds(run)).toBe(300);
    expect(staleCacheSeconds(run, 3_600)).toBe(86_400);

    const pr = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42",
      }),
      policy,
    );
    expect(staleCacheSeconds(pr)).toBe(3_600);

    const user = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/users/openperf",
      }),
      policy,
    );
    expect(staleCacheSeconds(user)).toBe(7_200);

    const gitRef = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/git/ref/heads/main",
      }),
      policy,
    );
    expect(staleCacheSeconds(gitRef)).toBe(300);
  });

  it("serves fresh edge entries without reading D1", async () => {
    const cached = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { number: 42 },
      body_encoding: "json",
      created_at: sqliteUTC(Date.now() - 1_000),
      expires_at: sqliteUTC(Date.now() + 60_000),
    };
    const match = vi.fn(async () => Response.json(cached));
    vi.stubGlobal("caches", {
      default: {
        match,
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const prepare = vi.fn(() => {
      throw new Error("D1 should not be read");
    });

    await expect(
      readGitHubCache({ DB: { prepare } } as unknown as Env, "cache-key"),
    ).resolves.toMatchObject({
      body: { number: 42 },
    });
    expect(match).toHaveBeenCalledOnce();
  });

  it("writes successful cache entries to D1 and the edge cache", async () => {
    const put = vi.fn(async () => undefined);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put,
        delete: vi.fn(async () => true),
      },
    });
    const run = vi.fn(async () => ({}));
    const bind = vi.fn((..._args: unknown[]) => ({ run }));
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/42",
    });
    const route = classifyRoute(request, policy);
    const env = {
      DB: {
        prepare: () => ({
          bind,
        }),
      },
    } as unknown as Env;

    await expect(
      writeGitHubCache(env, "cache-key", request, route, response({ number: 42 })),
    ).resolves.toBe("shared");

    expect(run).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    const args = bind.mock.calls[0] as unknown[];
    expect(Date.parse(`${String(args[15])}Z`) - Date.parse(`${String(args[14])}Z`)).toBe(3_600_000);
    const [, edgeResponse] = put.mock.calls[0] as unknown as [Request, Response];
    await expect(edgeResponse.json()).resolves.toMatchObject({
      status: 200,
      body: { number: 42 },
    });
  });

  it("keeps oversized bodies out of D1 while still writing the edge cache", async () => {
    const put = vi.fn(async () => undefined);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put,
        delete: vi.fn(async () => true),
      },
    });
    const run = vi.fn(async () => ({}));
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/42",
    });
    const route = classifyRoute(request, policy);
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ run }),
        }),
      },
    } as unknown as Env;

    await expect(
      writeGitHubCache(env, "cache-key", request, route, response({ blob: "x".repeat(300_000) })),
    ).resolves.toBe("edge_only");

    // 120k CJK chars pass a UTF-16 code-unit count but exceed the cap in UTF-8 bytes.
    await expect(
      writeGitHubCache(
        env,
        "cache-key-multibyte",
        request,
        route,
        response({ blob: "语".repeat(120_000) }),
      ),
    ).resolves.toBe("edge_only");

    expect(run).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("reports failed when an edge-only cache put rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => {
          throw new Error("cache put rejected");
        }),
        delete: vi.fn(async () => true),
      },
    });
    const run = vi.fn(async () => ({}));
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/42",
    });
    const route = classifyRoute(request, policy);
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run }) }) },
    } as unknown as Env;

    await expect(
      writeGitHubCache(env, "cache-key", request, route, response({ blob: "x".repeat(300_000) })),
    ).resolves.toBe("failed");
    expect(run).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "edge cache write failed",
      expect.objectContaining({ namespace: "github-v1" }),
    );
  });

  it("reports edge-only when D1 fails after a confirmed edge publication", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
      },
    });
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/pulls/42",
    });
    const route = classifyRoute(request, policy);
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error("D1 unavailable");
            },
          }),
        }),
      },
    } as unknown as Env;

    await expect(
      writeGitHubCache(env, "cache-key", request, route, response({ number: 42 })),
    ).resolves.toBe("edge_only");
    expect(consoleError).toHaveBeenCalledWith(
      "github shared cache write failed",
      expect.any(Error),
    );
  });

  it("serves only stale cache rows inside the route grace window", async () => {
    const route = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42",
      }),
      policy,
    );
    let expiresAt = sqliteUTC(Date.now() - 60_000);
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              status: 200,
              response_headers_json: "{}",
              body_json: '{"number":42}',
              body_encoding: "json",
              identity_id: null,
              identity_kind: null,
              created_at: sqliteUTC(Date.now() - 120_000),
              expires_at: expiresAt,
              stale_expires_at: sqliteUTC(Date.now() + 60_000),
            }),
          }),
        }),
      },
    } as unknown as Env;

    await expect(readStaleGitHubCache(env, "cache-key", route)).resolves.toMatchObject({
      status: 200,
      body: { number: 42 },
    });

    expiresAt = sqliteUTC(Date.now() - 7_200_000);
    await expect(readStaleGitHubCache(env, "cache-key", route)).resolves.toBeUndefined();
  });

  it("rejects rows past their persisted stale deadline", async () => {
    const route = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42",
      }),
      policy,
    );
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              status: 200,
              response_headers_json: "{}",
              body_json: '{"number":42}',
              body_encoding: "json",
              identity_id: null,
              identity_kind: null,
              created_at: sqliteUTC(Date.now() - 120_000),
              expires_at: sqliteUTC(Date.now() - 60_000),
              stale_expires_at: sqliteUTC(Date.now() - 1_000),
            }),
          }),
        }),
      },
    } as unknown as Env;

    await expect(readStaleGitHubCache(env, "cache-key", route)).resolves.toBeUndefined();
  });

  it("extends stale fallback only for terminal CI cache entries", async () => {
    const route = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123",
      }),
      policy,
    );
    let createdAt = sqliteUTC(Date.now() - 13 * 60 * 60 * 1000);
    let expiresAt = sqliteUTC(Date.now() - 12 * 60 * 60 * 1000);
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              status: 200,
              response_headers_json: "{}",
              body_json: '{"status":"completed"}',
              body_encoding: "json",
              identity_id: null,
              identity_kind: null,
              created_at: createdAt,
              expires_at: expiresAt,
            }),
          }),
        }),
      },
    } as unknown as Env;

    await expect(readStaleGitHubCache(env, "cache-key", route)).resolves.toMatchObject({
      body: { status: "completed" },
    });

    createdAt = sqliteUTC(Date.now() - 12 * 60 * 60 * 1000 - 15_000);
    expiresAt = sqliteUTC(Date.now() - 12 * 60 * 60 * 1000);
    await expect(readStaleGitHubCache(env, "cache-key", route)).resolves.toBeUndefined();
  });

  it("prunes expired cache entries in bounded batches", async () => {
    let boundLimit: unknown;
    const env = {
      DB: {
        prepare: () => ({
          bind: (limit: unknown) => {
            boundLimit = limit;
            return {
              run: async () => ({ meta: { changes: 37 } }),
            };
          },
        }),
      },
    } as unknown as Env;

    await expect(pruneExpiredGitHubCache(env, 100)).resolves.toBe(37);
    expect(boundLimit).toBe(100);
  });
});

function response(body: unknown): GitHubRelayResponse {
  return {
    status: 200,
    headers: {},
    body,
  };
}

function sqliteUTC(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
