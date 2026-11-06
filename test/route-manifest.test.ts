import { describe, expect, it } from "vitest";
import { cachePolicyForRouteKind } from "../src/cache-policy";
import { isIssueEventRoute, isNativeReadRoute, ROUTES } from "../src/route-manifest";

describe("route manifest", () => {
  it("has unique route identities and patterns", () => {
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

  it("keeps permission-dependent issue events anonymous while preserving activity feeds", () => {
    const events = ROUTES.filter((route) => isIssueEventRoute(route.kind));
    expect(events.map((route) => route.template)).toEqual([
      "/repos/{owner}/{repo}/issues/{number}/events",
      "/repos/{owner}/{repo}/issues/events",
      "/repos/{owner}/{repo}/issues/events/{id}",
      "/repos/{owner}/{repo}/issues/{number}/timeline",
    ]);
    for (const route of events) {
      expect(route.capabilities).toEqual({
        publicApi: true,
        fallback: "local",
        anonymousRepoProof: true,
      });
    }
    for (const kind of ["repo_event_list", "network_event_list"]) {
      expect(ROUTES.find((route) => route.kind === kind)?.capabilities.fallback).toBe("pool");
    }
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
    expect(new Set(native.map((route) => route.kind))).toEqual(
      new Set(["branch_protection", "repo_ruleset_list", "repo_ruleset_view", "branch_rules"]),
    );
    for (const route of native) {
      expect(route.capabilities).toMatchObject({ publicApi: false, fallback: "local" });
      expect(route.cacheable).toBe(false);
    }
  });
});
