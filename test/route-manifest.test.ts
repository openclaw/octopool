import { describe, expect, it } from "vitest";
import { cachePolicyForRouteKind } from "../src/cache-policy";
import { isNativeReadRoute, ROUTES } from "../src/route-manifest";

describe("route manifest", () => {
  it("has unique route identities and patterns", () => {
    expect(ROUTES).toHaveLength(133);
    expect(new Set(ROUTES.map((route) => route.kind)).size).toBe(120);
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((route) => route.pattern.source)).size).toBe(ROUTES.length);
  });

  it("matches every representative path unambiguously", () => {
    for (const route of ROUTES) {
      const matches = ROUTES.filter((candidate) => candidate.pattern.test(route.example));
      expect(
        matches.map((candidate) => candidate.id),
        route.id,
      ).toEqual([route.id]);
    }
  });

  it("defines backend eligibility on every concrete route", () => {
    expect(ROUTES.filter((route) => route.capabilities.publicApi)).toHaveLength(116);
    expect(ROUTES.filter((route) => route.capabilities.fallback === "local")).toHaveLength(40);
    expect(ROUTES.filter((route) => route.capabilities.fallback === "github_public")).toHaveLength(
      1,
    );
    expect(
      ROUTES.filter(
        (route) => route.capabilities.publicApi || route.capabilities.fallback === "github_public",
      ),
    ).toHaveLength(117);
  });

  it("routes annotated tag objects through the immutable Git object policy", () => {
    const route = ROUTES.find((candidate) => candidate.kind === "git_tag");
    expect(route).toMatchObject({
      template: "/repos/{owner}/{repo}/git/tags/{sha}",
      routeKeyTemplate: "/repos/{owner}/{repo}/git/tags/:sha",
      cacheable: true,
      capabilities: {
        publicApi: true,
        fallback: "pool",
        anonymousRepoProof: true,
      },
    });
    expect(route?.pattern.test("/repos/openclaw/octopool/git/tags/0123456789abcdef")).toBe(true);
    expect(cachePolicyForRouteKind("git_tag")).toEqual({
      fresh: { kind: "static", seconds: 86_400 },
      staleSeconds: 86_400,
    });
  });

  it("splits SHA-shaped and ref-named commit paths onto distinct routes", () => {
    const kindFor = (path: string): string[] =>
      ROUTES.filter((route) => route.pattern.test(path)).map((route) => route.kind);
    expect(kindFor("/repos/openclaw/octopool/commits/0123456789abcdef0123456789abcdef01234567")) //
      .toEqual(["commit_view"]);
    expect(kindFor("/repos/openclaw/octopool/commits/abc1234")).toEqual(["commit_view"]);
    expect(kindFor("/repos/openclaw/octopool/commits/main")).toEqual(["commit_view_ref"]);
    expect(kindFor("/repos/openclaw/octopool/commits/dead")).toEqual(["commit_view_ref"]);
    expect(kindFor("/repos/openclaw/octopool/commits/v1.2.3")).toEqual(["commit_view_ref"]);
    expect(kindFor("/repos/openclaw/octopool/commits/feature%2Ffoo")).toEqual(["commit_view_ref"]);
    expect(kindFor("/repos/openclaw/octopool/commits/main/check-runs")).toEqual([
      "commit_check_runs_ref",
    ]);
    expect(kindFor("/repos/openclaw/octopool/commits/main/check-suites")).toEqual([
      "commit_check_suites_ref",
    ]);
    expect(kindFor("/repos/openclaw/octopool/commits/main/status")).toEqual(["commit_status_ref"]);
    expect(kindFor("/repos/openclaw/octopool/commits/main/statuses")).toEqual([
      "commit_statuses_ref",
    ]);
  });

  it("defines cache policy on every route kind", () => {
    for (const route of ROUTES) {
      const policy = cachePolicyForRouteKind(route.kind);
      if (isNativeReadRoute(route)) {
        expect(route.cacheable).toBe(false);
        expect(policy).toEqual({ fresh: { kind: "static", seconds: 0 }, staleSeconds: 0 });
      } else {
        expect(policy.staleSeconds).toBeGreaterThan(0);
      }
      expect(policy.fresh).toBeDefined();
    }
    expect(ROUTES.find((route) => route.kind === "rate_limit")?.cacheable).toBe(false);
  });

  it("keeps protection reads out of every public or pooled backend", () => {
    const native = ROUTES.filter(isNativeReadRoute);
    expect(native).toHaveLength(13);
    expect(new Set(native.map((route) => route.kind))).toEqual(
      new Set(["branch_protection", "repo_ruleset_list", "repo_ruleset_view", "branch_rules"]),
    );
    for (const route of native) {
      expect(route.capabilities).toMatchObject({ publicApi: false, fallback: "local" });
      expect(route.cacheable).toBe(false);
    }
  });
});
