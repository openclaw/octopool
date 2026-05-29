import { describe, expect, it } from "vitest";
import { cacheTTLSeconds, githubCacheKey, shouldUseGitHubCache } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import type { GitHubRelayResponse } from "../src/types";

describe("github cache policy", () => {
  const policy = defaultPolicy("openclaw");

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

  it("keeps mutable CI TTLs short and extends closed items", () => {
    const run = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs/123",
      }),
      policy,
    );
    expect(cacheTTLSeconds(run, response({ status: "completed" }))).toBe(15);
    expect(cacheTTLSeconds(run, response({ status: "in_progress" }))).toBe(15);

    const runList = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/actions/runs",
      }),
      policy,
    );
    expect(cacheTTLSeconds(runList, response({ workflow_runs: [{ status: "completed" }] }))).toBe(
      15,
    );

    const checks = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/commits/abc1234/check-runs",
      }),
      policy,
    );
    expect(cacheTTLSeconds(checks, response({ check_runs: [{ status: "completed" }] }))).toBe(15);

    const files = classifyRoute(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/42/files",
      }),
      policy,
    );
    expect(cacheTTLSeconds(files, response([]))).toBe(60);
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
  });
});

function response(body: unknown): GitHubRelayResponse {
  return {
    status: 200,
    headers: {},
    body,
  };
}
