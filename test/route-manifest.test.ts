import { describe, expect, it } from "vitest";
import { cachePolicyForRouteKind } from "../src/cache-policy";
import { ROUTES } from "../src/route-manifest";

describe("route manifest", () => {
  it("has unique route identities and patterns", () => {
    expect(ROUTES).toHaveLength(112);
    expect(new Set(ROUTES.map((route) => route.kind)).size).toBe(110);
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
    expect(ROUTES.filter((route) => route.capabilities.publicApi)).toHaveLength(104);
    expect(ROUTES.filter((route) => route.capabilities.fallback === "local")).toHaveLength(27);
    expect(ROUTES.filter((route) => route.capabilities.fallback === "github_public")).toHaveLength(
      1,
    );
    expect(
      ROUTES.filter(
        (route) => route.capabilities.publicApi || route.capabilities.fallback !== "pool",
      ),
    ).toHaveLength(109);
  });

  it("defines cache policy on every route kind", () => {
    for (const route of ROUTES) {
      const policy = cachePolicyForRouteKind(route.kind);
      expect(policy.staleSeconds).toBeGreaterThan(0);
      expect(policy.fresh).toBeDefined();
    }
    expect(ROUTES.find((route) => route.kind === "rate_limit")?.cacheable).toBe(false);
  });
});
