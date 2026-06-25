import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheTTLSeconds,
  githubCacheKey,
  pruneExpiredGitHubCache,
  readGitHubCache,
  readStaleGitHubCache,
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

  it("keeps mutable CI TTLs short and caches terminal CI for an hour", () => {
    const run = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123",
      }),
      policy,
    );
    expect(cacheTTLSeconds(run, response({ status: "completed" }))).toBe(3_600);
    expect(cacheTTLSeconds(run, response({ status: "in_progress" }))).toBe(30);

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
    expect(cacheTTLSeconds(runList, response({ workflow_runs: [] }))).toBe(30);

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
    expect(cacheTTLSeconds(checks, response({ check_runs: [] }))).toBe(30);
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
    expect(cacheTTLSeconds(checkSuites, response({ check_suites: [] }))).toBe(30);
    const statuses = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/statuses/abc1234",
      }),
      policy,
    );
    expect(cacheTTLSeconds(statuses, response([{ state: "success" }]))).toBe(3_600);
    expect(cacheTTLSeconds(statuses, response([{ state: "pending" }]))).toBe(30);
    const job = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/jobs/123",
      }),
      policy,
    );
    expect(cacheTTLSeconds(job, response({ status: "completed" }))).toBe(3_600);
    expect(cacheTTLSeconds(job, response({ status: "in_progress" }))).toBe(30);

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
    expect(cacheTTLSeconds(pr, response({ state: "closed", merged_at: null }))).toBe(3_600);
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

    await writeGitHubCache(env, "cache-key", request, route, response({ number: 42 }));

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
