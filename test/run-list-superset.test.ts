import { describe, expect, it } from "vitest";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { runListSupersetView } from "../src/run-list-superset";

describe("Actions run-list superset eligibility", () => {
  it("canonicalizes supported repo-level shim queries", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { branch: "main", status: "failure", per_page: "25", limit: "10" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(
      runListSupersetView(request, classifyRoute(request, defaultPolicy("openclaw"))),
    ).toMatchObject({
      cacheRequest: { query: { page: "1", per_page: "100" } },
      branch: "main",
      status: "failure",
      limit: 10,
    });
  });

  it.each([
    [{ page: "2" }],
    [{ per_page: "101" }],
    [{ event: "push" }],
    [{ status: "not-a-github-status" }],
  ])("leaves unsupported query %o exact", (query) => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query,
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(
      runListSupersetView(request, classifyRoute(request, defaultPolicy("openclaw"))),
    ).toBeUndefined();
  });

  it("uses a standalone limit without imposing the REST default page size", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { limit: "50" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(
      runListSupersetView(request, classifyRoute(request, defaultPolicy("openclaw"))),
    ).toMatchObject({ limit: 50 });
  });
});
