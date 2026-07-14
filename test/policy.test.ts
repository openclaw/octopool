import { describe, expect, it } from "vitest";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

describe("route policy", () => {
  const policy = defaultPolicy("openclaw");

  it("discards legacy advisory fields at the validation boundary", () => {
    expect(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/pulls/1/files",
        route_hint: {
          owner: "ignored",
          repo: "ignored",
          kind: "ignored",
          pr_head_sha: "0123456789ABCDEF0123456789ABCDEF01234567",
        },
        cache_key: "ignored",
        idempotency_key: "ignored",
      }),
    ).toEqual({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/1/files",
      route_hint: { pr_head_sha: "0123456789abcdef0123456789abcdef01234567" },
    });
  });

  it("keeps cache-control in the filtered request headers", () => {
    expect(
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/pulls/1",
        headers: {
          "Cache-Control": "max-age=20",
          "x-unexpected": "dropped",
        },
      }),
    ).toEqual({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/1",
      headers: { "cache-control": "max-age=20" },
    });
  });

  it("allows public user reads", () => {
    for (const path of [
      "/users/openperf",
      "/users/dependabot%5Bbot%5D",
      "/users/dependabot[bot]",
    ]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
      });
      expect(classifyRoute(request, policy)).toMatchObject({
        kind: "user_view",
        publicOnly: false,
        resource: "core",
        routeKey: "GET /users/:login",
      });
    }
  });

  it("allows public org, user collection, and gist reads", () => {
    for (const [path, kind] of [
      ["/orgs/openclaw/repos", "org_repo_list"],
      ["/orgs/openclaw/events", "org_event_list"],
      ["/orgs/openclaw/public_members", "org_public_member_list"],
      ["/orgs/openclaw/public_members/steipete", "org_public_member_view"],
      ["/users/openperf/repos", "user_repo_list"],
      ["/users/openperf/orgs", "user_org_list"],
      ["/users/openperf/gists", "user_gist_list"],
      ["/users/openperf/followers", "user_follower_list"],
      ["/users/openperf/following", "user_following_list"],
      ["/users/openperf/events", "user_event_list"],
      ["/users/openperf/received_events", "user_received_event_list"],
      ["/users/openperf/keys", "user_key_list"],
      ["/users/openperf/gpg_keys", "user_gpg_key_list"],
      ["/gists/abc123", "gist_view"],
      ["/emojis", "emoji_list"],
      ["/meta", "github_meta"],
      ["/licenses", "license_list"],
      ["/licenses/mit", "license_view"],
      ["/gitignore/templates", "gitignore_template_list"],
      ["/gitignore/templates/Go", "gitignore_template_view"],
      ["/gitignore/templates/C++", "gitignore_template_view"],
      ["/gitignore/templates/C%2B%2B", "gitignore_template_view"],
    ]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
      });
      expect(classifyRoute(request, policy).kind).toBe(kind);
    }
  });

  it("does not relay organization profiles with auth-only fields", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/orgs/openclaw",
    });
    expect(() => classifyRoute(request, policy)).toThrow(/Route is not enabled/);
  });

  it("does not normalize repo names that match top-level routes", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/users/pulls/1",
    });
    expect(classifyRoute(request, policy)).toMatchObject({
      kind: "pr_view",
      routeKey: "GET /repos/openclaw/users/pulls/:number",
    });
    const orgsRepo = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/orgs/labels",
    });
    expect(classifyRoute(orgsRepo, policy)).toMatchObject({
      kind: "label_list",
      routeKey: "GET /repos/openclaw/orgs/labels",
    });
  });

  it("allows priority OpenClaw PR and CI routes", () => {
    const routes = [
      "/repos/openclaw/openclaw",
      "/repos/openclaw/openclaw/comments/123",
      "/repos/openclaw/openclaw/contents/README.md",
      "/repos/openclaw/openclaw/readme",
      "/repos/openclaw/openclaw/readme/docs",
      "/repos/openclaw/openclaw/compare/main...feature",
      "/repos/openclaw/openclaw/pulls?state=open",
      "/repos/openclaw/openclaw/issues?state=open",
      "/repos/openclaw/openclaw/pulls/85341",
      "/repos/openclaw/openclaw/pulls/85341/commits",
      "/repos/openclaw/openclaw/pulls/85341/requested_reviewers",
      "/repos/openclaw/openclaw/pulls/85341/reviews/1",
      "/repos/openclaw/openclaw/pulls/85341/reviews/1/comments",
      "/repos/openclaw/openclaw/pulls/comments",
      "/repos/openclaw/openclaw/pulls/comments/123",
      "/repos/openclaw/openclaw/pulls/comments/123/reactions",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/comments",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/statuses",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/check-runs",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/check-suites",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/pulls",
      "/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351/branches-where-head",
      "/repos/openclaw/openclaw/commits/main",
      "/repos/openclaw/openclaw/commits/main/statuses",
      "/repos/openclaw/openclaw/commits/main/check-runs",
      "/repos/openclaw/openclaw/commits/main/check-suites",
      "/repos/openclaw/openclaw/commits/main/status",
      "/repos/openclaw/openclaw/commits/v1.2.3",
      "/repos/openclaw/openclaw/statuses/ac49d8e2295a093f168baa45312e1e29238c0351",
      "/repos/openclaw/openclaw/actions/runs/26360397003/jobs",
      "/repos/openclaw/openclaw/actions/runs/26360397003/attempts/2",
      "/repos/openclaw/openclaw/actions/jobs/77594668516/logs",
      "/repos/openclaw/openclaw/issues/80490/comments",
      "/repos/openclaw/openclaw/issues/comments",
      "/repos/openclaw/openclaw/issues/comments/123",
      "/repos/openclaw/openclaw/issues/comments/123/reactions",
      "/repos/openclaw/openclaw/issues/80490/events",
      "/repos/openclaw/openclaw/issues/events",
      "/repos/openclaw/openclaw/issues/events/123",
      "/repos/openclaw/openclaw/issues/80490/labels",
      "/repos/openclaw/openclaw/issues/80490/reactions",
      "/repos/openclaw/openclaw/assignees",
      "/repos/openclaw/openclaw/assignees/openperf",
      "/repos/openclaw/openclaw/labels",
      "/repos/openclaw/openclaw/labels/good%20first%20issue",
      "/repos/openclaw/openclaw/milestones",
      "/repos/openclaw/openclaw/milestones/1",
      "/repos/openclaw/openclaw/branches",
      "/repos/openclaw/openclaw/actions/workflows/ci.yml",
      "/repos/openclaw/openclaw/actions/workflows/ci.yml/runs",
      "/repos/openclaw/openclaw/tags",
      "/repos/openclaw/openclaw/languages",
      "/repos/openclaw/openclaw/contributors",
      "/repos/openclaw/openclaw/license",
      "/repos/openclaw/openclaw/topics",
      "/repos/openclaw/openclaw/community/profile",
      "/repos/openclaw/openclaw/forks",
      "/repos/openclaw/openclaw/stargazers",
      "/repos/openclaw/openclaw/subscribers",
      "/repos/openclaw/openclaw/deployments",
      "/repos/openclaw/openclaw/events",
      "/networks/openclaw/openclaw/events",
      "/repos/openclaw/openclaw/stats/contributors",
      "/repos/openclaw/openclaw/stats/commit_activity",
      "/repos/openclaw/openclaw/stats/code_frequency",
      "/repos/openclaw/openclaw/stats/participation",
      "/repos/openclaw/openclaw/stats/punch_card",
      "/repos/openclaw/openclaw/git/blobs/ac49d8e2295a093f168baa45312e1e29238c0351",
      "/repos/openclaw/openclaw/git/commits/ac49d8e2295a093f168baa45312e1e29238c0351",
      "/repos/openclaw/openclaw/git/trees/ac49d8e2295a093f168baa45312e1e29238c0351",
      "/repos/openclaw/openclaw/git/ref/heads/main",
      "/repos/openclaw/openclaw/git/matching-refs/heads",
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

  it("relays workflow run attempts as cacheable run views", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/openclaw/actions/runs/26360397003/attempts/2",
    });
    expect(classifyRoute(request, policy)).toMatchObject({
      kind: "run_view",
      cacheable: true,
      routeKey: "GET /repos/openclaw/openclaw/actions/runs/:id/attempts/:attempt",
    });
  });

  it("routes ref-named commit reads separately from SHA-named ones", () => {
    const classify = (path: string) =>
      classifyRoute(validateRelayRequest({ pool: "maintainers", method: "GET", path }), policy);
    expect(classify("/repos/openclaw/openclaw/commits/main")).toMatchObject({
      kind: "commit_view_ref",
      routeKey: "GET /repos/openclaw/openclaw/commits/:ref",
    });
    expect(
      classify("/repos/openclaw/openclaw/commits/ac49d8e2295a093f168baa45312e1e29238c0351"),
    ).toMatchObject({
      kind: "commit_view",
      routeKey: "GET /repos/openclaw/openclaw/commits/:sha",
    });
    expect(classify("/repos/openclaw/openclaw/commits/abc1234").kind).toBe("commit_view");
    expect(classify("/repos/openclaw/openclaw/commits/dead").kind).toBe("commit_view_ref");
    expect(classify("/repos/openclaw/openclaw/commits/main/check-runs")).toMatchObject({
      kind: "commit_check_runs_ref",
      routeKey: "GET /repos/openclaw/openclaw/commits/:ref/check-runs",
    });
  });

  it("uses the configured response cap for cacheable Actions run lists", () => {
    for (const path of [
      "/repos/openclaw/openclaw/actions/runs",
      "/repos/openclaw/openclaw/actions/workflows/ci.yml/runs",
    ]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
      });
      expect(classifyRoute(request, policy)).toMatchObject({
        cacheable: true,
        largePayload: false,
        fullResponseCap: true,
      });
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

  it("applies owner policy to user repository lists", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/steipete/repos",
    });
    expect(() => classifyRoute(request, { ...policy, allow_public_repos: false })).toThrow(
      /not allowed/,
    );
  });

  it("does not relay auth-dependent user repository collections", () => {
    for (const path of ["/users/openperf/starred", "/users/openperf/subscriptions"]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path,
      });
      expect(() => classifyRoute(request, policy)).toThrow(/Route is not enabled/);
    }
  });

  it("only allows owner repositories for user repository lists", () => {
    const ownerRequest = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/openclaw/repos",
      query: { type: "owner" },
    });
    expect(classifyRoute(ownerRequest, policy)).toMatchObject({ kind: "user_repo_list" });

    const memberRequest = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/users/openclaw/repos",
      query: { type: "member" },
    });
    expect(() => classifyRoute(memberRequest, policy)).toThrow(/owner repositories/);
  });

  it("only allows public repositories for organization repository lists", () => {
    const publicRequest = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/orgs/openclaw/repos",
      query: { type: "public" },
    });
    expect(classifyRoute(publicRequest, policy)).toMatchObject({ kind: "org_repo_list" });

    const privateRequest = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/orgs/openclaw/repos",
      query: { type: "private" },
    });
    expect(() => classifyRoute(privateRequest, policy)).toThrow(/public repositories/);
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
      ["/repos/openclaw/octopool/releases/123/assets", "release_assets"],
      ["/repos/openclaw/octopool/releases/assets/456", "release_asset"],
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

  it("allows shaped repo search only through token-free backends", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/issues",
      query: { q: "repo:openclaw/openclaw type:issue state:open cache" },
      headers: { "x-octopool-public-shape": "issue-search-v1" },
    });
    expect(classifyRoute(request, policy)).toMatchObject({
      kind: "search_issues",
      owner: "openclaw",
      repo: "openclaw",
      tokenFreeOnly: true,
    });
    expect(classifyRoute(request, { ...policy, allow_search: true })).not.toHaveProperty(
      "tokenFreeOnly",
    );

    for (const query of [
      { q: "repo:openclaw/openclaw cache" },
      { q: "repo:openclaw/openclaw type:issue cache", page: "2" },
      { q: "repo:openclaw/openclaw type:issue cache", per_page: "1e2" },
      { q: "repo:openclaw/openclaw type:issue cache", sort: "updated" },
      { q: "repo:openclaw/openclaw type:issue author:octocat cache" },
    ]) {
      const invalid = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/search/issues",
        query,
        headers: { "x-octopool-public-shape": "issue-search-v1" },
      });
      expect(() => classifyRoute(invalid, policy)).toThrow();
    }
  });

  it("allows plain repository search when search is enabled", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/search/repositories",
      query: { q: "octopool relay" },
    });
    expect(() => classifyRoute(request, policy)).toThrow(/Search routes are disabled/);
    expect(classifyRoute(request, { ...policy, allow_search: true })).toMatchObject({
      kind: "search_repositories",
      resource: "search",
    });
    expect(() =>
      classifyRoute(request, { ...policy, allow_search: true, allow_public_repos: false }),
    ).toThrow(/public repository pooling/);
  });

  it("denies advanced repository search syntax", () => {
    for (const q of ["octopool NOT relay", "octopool -relay"]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/search/repositories",
        query: { q },
      });
      expect(() => classifyRoute(request, { ...policy, allow_search: true })).toThrow(
        /plain terms/,
      );
    }
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
