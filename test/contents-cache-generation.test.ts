import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { contentsCacheKeys } from "./fixtures/contents-cache-keys";

describe("contents self-link cache generation", () => {
  it.each(contentsCacheKeys)("bounds shared and identity retirement for $name", async (fixture) => {
    const request = validateRelayRequest(fixture.request);
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const shared = await githubCacheKey(request.pool, request, route);
    const identity = await githubCacheKey(request.pool, request, route, {
      id: "primary",
      kind: "pat",
    });
    expect(shared === fixture.shared).toBe(!fixture.retire);
    expect(identity === fixture.identity).toBe(!fixture.retire);
    if (fixture.retire) {
      for (const accept of [
        "application/json",
        "application/vnd.github+json",
        "APPLICATION/VND.GITHUB.V3+JSON",
      ]) {
        const variant = { ...request, headers: { accept } };
        expect(await githubCacheKey(request.pool, variant, route)).toBe(shared);
        expect(
          await githubCacheKey(request.pool, variant, route, { id: "primary", kind: "pat" }),
        ).toBe(identity);
      }
    }
  });
});
