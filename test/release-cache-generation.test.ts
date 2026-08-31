import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { legacyReleaseKey } from "./fixtures/release-summary";

describe("release summary cache generation", () => {
  it.each(["latest", "tags/v0.8.0", "tags/release%2F1.0"])(
    "retires legacy shaped %s keys for existing clients",
    async (suffix) => {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: `/repos/openclaw/octopool/releases/${suffix}`,
        headers: { "x-octopool-public-shape": "release-summary-v1" },
      });
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      for (const identity of [undefined, { kind: "pat" as const, id: "primary" }]) {
        expect(await githubCacheKey(request.pool, request, route, identity)).not.toBe(
          await legacyReleaseKey(request, route, identity),
        );
      }
    },
  );

  it.each(["releases", "releases/latest", "releases/tags/v0.8.0", "releases/123", "pulls/5"])(
    "preserves raw REST %s keys",
    async (suffix) => {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: `/repos/openclaw/octopool/${suffix}`,
      });
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      expect(await githubCacheKey(request.pool, request, route)).toBe(
        await legacyReleaseKey(request, route),
      );
    },
  );
});
