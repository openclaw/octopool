import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { runListSupersetView } from "../src/run-list-superset";
import { legacyActionsKey } from "./fixtures/actions-legacy-cache";

describe("Actions summary cache generation", () => {
  it.each([
    ["actions/runs/33167365292", {}],
    ["actions/runs/33167365221/attempts/1", {}],
    ["actions/runs", { limit: "20", branch: "main" }],
    ["actions/runs", { limit: "100" }],
    ["actions/workflows/ci.yml/runs", { limit: "20", status: "failure" }],
  ])("retires legacy %s keys including canonical supersets", async (suffix, query) => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: `/repos/openclaw/Peekaboo/${suffix}`,
      query,
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    for (const candidate of [
      request,
      runListSupersetView(request, route)?.cacheRequest ?? request,
    ]) {
      for (const identity of [undefined, { kind: "pat" as const, id: "primary" }]) {
        expect(await githubCacheKey(request.pool, candidate, route, identity)).not.toBe(
          await legacyActionsKey(candidate, route, identity),
        );
      }
    }
  });

  it.each([
    ["actions/runs/33167365292", undefined],
    ["actions/runs", undefined],
    ["actions/workflows/ci.yml/runs", undefined],
    ["actions/runs/33167365292/attempts/1/jobs", "actions-jobs-v1"],
    ["pulls/651", "pr-summary-v1"],
  ])("preserves unrelated %s (%s) keys", async (suffix, shape) => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: `/repos/openclaw/Peekaboo/${suffix}`,
      headers: shape === undefined ? {} : { "x-octopool-public-shape": shape },
    });
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    expect(await githubCacheKey(request.pool, request, route)).toBe(
      await legacyActionsKey(request, route),
    );
  });
});
