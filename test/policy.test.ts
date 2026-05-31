import { describe, expect, it } from "vitest";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("route policy", () => {
  const policy = defaultPolicy("openclaw");

  it("allows priority OpenClaw PR and CI routes", () => {
    const routes = [
      "/repos/openclaw/openclaw",
      "/repos/openclaw/openclaw/contents/README.md",
      "/repos/openclaw/openclaw/compare/main...feature",
      "/repos/openclaw/openclaw/pulls?state=open",
      "/repos/openclaw/openclaw/issues?state=open",
      "/repos/openclaw/openclaw/pulls/85341",
      "/repos/openclaw/openclaw/pulls/85341/commits",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/check-runs",
      "/repos/openclaw/openclaw/actions/runs/26360397003/jobs",
      "/repos/openclaw/openclaw/actions/jobs/77594668516/logs",
      "/repos/openclaw/openclaw/issues/80490/comments",
      "/repos/openclaw/openclaw/issues/80490/events",
      "/repos/openclaw/openclaw/actions/workflows/ci.yml",
      "/repos/openclaw/openclaw/actions/workflows/ci.yml/runs",
    ];
    for (const path of routes) {
      const [requestPath, rawQuery] = path.split("?");
      const query =
        rawQuery === undefined ? undefined : Object.fromEntries(new URLSearchParams(rawQuery));
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: requestPath,
        query,
      });
      expect(classifyRoute(request, policy).owner).toBe("openclaw");
    }
  });

  it("allows non-OpenClaw public repo candidates by default", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/steipete/CodexBar/pulls/1",
    });
    expect(classifyRoute(request, policy)).toMatchObject({
      owner: "steipete",
      publicOnly: true,
    });
  });

  it("denies non-OpenClaw owners when public pooling is disabled", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/steipete/CodexBar/pulls/1",
    });
    expect(() => classifyRoute(request, { ...policy, allow_public_repos: false })).toThrow(
      /not allowed/,
    );
  });

  it("denies mutations", () => {
    expect(() =>
      validateRelayRequest({
        pool: "maintainers",
        method: "POST",
        path: "/repos/openclaw/openclaw/issues/1/comments",
      }),
    ).toThrow(/Only GET/);
  });

  it("denies paths that would be canonicalized before reaching GitHub", () => {
    expect(() =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/branches/%2e%2e",
      }),
    ).toThrow(/absolute GitHub API path/);
    expect(() =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/1?access_token=secret",
      }),
    ).toThrow(/absolute GitHub API path/);
    expect(() =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/1",
        query: { client_secret: "secret" },
      }),
    ).toThrow(/query key/);
    expect(() =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/branches/.",
      }),
    ).toThrow(/absolute GitHub API path/);
  });

  it("allows encoded slashes for branch names", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/branches/feature%2Ffoo",
    });
    expect(classifyRoute(request, policy).kind).toBe("branch_view");
  });

  it("allows release read routes", () => {
    for (const [path, kind] of [
      ["/repos/openclaw/octopool/releases", "release_list"],
      ["/repos/openclaw/octopool/releases/latest", "release_latest"],
      ["/repos/openclaw/octopool/releases/tags/v0.2.5", "release_view"],
      ["/repos/openclaw/octopool/releases/123", "release_view"],
    ]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
      });
      expect(classifyRoute(request, policy).kind).toBe(kind);
    }
  });

  it("gates search routes behind pool policy", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/issues",
      query: { q: "repo:openclaw/openclaw type:issue state:open cache" },
    });
    expect(() => classifyRoute(request, policy)).toThrow(/Search routes are disabled/);
    expect(classifyRoute(request, { ...policy, allow_search: true })).toMatchObject({
      kind: "search_issues",
      owner: "openclaw",
      repo: "openclaw",
      resource: "search",
    });
  });

  it("denies unscoped search routes even when search is enabled", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/issues",
      query: { q: "cache regression" },
    });
    expect(() => classifyRoute(request, { ...policy, allow_search: true })).toThrow(
      /repo qualifier/,
    );
  });

  it("denies broad search syntax outside the repo qualifier", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/issues",
      query: { q: "repo:openclaw/openclaw cache OR org:other" },
    });
    expect(() => classifyRoute(request, { ...policy, allow_search: true })).toThrow(
      /plain repo-scoped terms/,
    );
  });

  it("denies cross-repository compare refs", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/compare/main...steipete:feature",
    });
    expect(() => classifyRoute(request, policy)).toThrow(/Cross-repository compare/);
  });

  it("denies encoded cross-repository compare refs", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/compare/main...steipete%3Afeature",
    });
    expect(() => classifyRoute(request, policy)).toThrow(/Cross-repository compare/);
  });
});
