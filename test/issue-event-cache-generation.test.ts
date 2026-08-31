import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { issueEventCases, legacyIssueEventKey } from "./fixtures/issue-event-visibility";

describe("public issue-event cache generation", () => {
  it.each(issueEventCases)("retires every old $kind identity namespace", async ({ path }) => {
    const request = validateRelayRequest({ pool: "maintainers", method: "GET", path });
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    for (const identity of [
      undefined,
      { kind: "pat" as const, id: "primary" },
      { kind: "github_app" as const, id: "installation" },
    ]) {
      expect(await githubCacheKey(request.pool, request, route, identity)).not.toBe(
        await legacyIssueEventKey(request, route, identity),
      );
    }
    const defaults = {
      ...request,
      query: { page: "1", per_page: "30" },
      headers: { accept: "application/json" },
    };
    expect(await githubCacheKey(request.pool, defaults, route)).toBe(
      await githubCacheKey(request.pool, request, route),
    );
    for (const variant of [
      { ...request, query: { page: "2" } },
      { ...request, headers: { accept: "application/vnd.github.full+json" } },
    ]) {
      expect(await githubCacheKey(request.pool, variant, route)).not.toBe(
        await githubCacheKey(request.pool, request, route),
      );
    }
  });

  it.each([
    "/repos/openclaw/octopool/events",
    "/networks/openclaw/octopool/events",
    "/repos/openclaw/octopool/issues/42",
    "/repos/openclaw/octopool/issues/42/comments",
  ])("preserves neighboring %s cache keys", async (path) => {
    const request = validateRelayRequest({ pool: "maintainers", method: "GET", path });
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    expect(await githubCacheKey(request.pool, request, route)).toBe(
      await legacyIssueEventKey(request, route),
    );
  });
});
