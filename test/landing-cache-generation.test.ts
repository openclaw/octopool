import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

// Keys from phase one (20dd274), including pooled-identity variants.
const prior = [
  [
    "pr-ci-summary-v1",
    "U1NE_Y9qL1IkZZ7JrLArz6h_Do0QN_QXPpWO7bDzxks",
    "hRaQg0uP8AXn6Ccj7eV_W7851ABw6F1ur8icw41UwE0",
  ],
  [
    "pr-ci-rollup-v1",
    "RSFwIShL8xs9nY6yasn2Foxu3S_E30sOs0D8QRKRAoU",
    "aLuepi_yjkdEiC1a8qnAa5HHTbI78v6cvXxqlXAasEE",
  ],
  [
    "rest",
    "oAQdXPxQILjhZyWltefFwjs8R8uN2yigAilOVwozo-0",
    "zc-Q3-Ug12oKmF2i9-_4vj6zgx8wi4WLDyZHtaL32xU",
  ],
];

describe("landing cache representation cutover", () => {
  it.each(prior)("keeps unchanged %s representations warm", async (shape, shared, identity) => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/pulls/42",
      ...(shape === "rest" ? {} : { headers: { "x-octopool-public-shape": shape } }),
    });
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    expect(await githubCacheKey(request.pool, request, route)).toBe(shared);
    expect(await githubCacheKey(request.pool, request, route, { id: "primary", kind: "pat" })).toBe(
      identity,
    );
  });
});
