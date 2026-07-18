import { describe, expect, it } from "vitest";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { filterRunListSuperset, runListSupersetView } from "../src/run-list-superset";

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

  it("removes canonical representation headers from shaped responses", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { limit: "1" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    const view = runListSupersetView(request, classifyRoute(request, defaultPolicy("openclaw")));

    expect(
      filterRunListSuperset(
        {
          status: 200,
          headers: {
            etag: '"canonical"',
            "Last-Modified": "Sat, 18 Jul 2026 08:00:00 GMT",
            "content-length": "1234",
            link: '<https://api.github.com/repositories/1/actions/runs?page=2>; rel="next"',
            "content-type": "application/json",
          },
          body: {
            total_count: 2,
            workflow_runs: [
              { id: 1, head_branch: "main", status: "completed", conclusion: "success" },
              { id: 2, head_branch: "main", status: "completed", conclusion: "success" },
            ],
          },
          body_encoding: "json",
        },
        view,
      ).headers,
    ).toEqual({ "content-type": "application/json" });
  });

  it("preserves GitHub total_count while shaping an exact response", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs",
      query: { limit: "1" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    const view = runListSupersetView(request, classifyRoute(request, defaultPolicy("openclaw")));
    const response = filterRunListSuperset(
      {
        status: 200,
        headers: {},
        body: {
          total_count: 100,
          workflow_runs: [
            { id: 1, head_branch: "main", status: "completed", conclusion: "success" },
            { id: 2, head_branch: "main", status: "completed", conclusion: "success" },
          ],
        },
        body_encoding: "json",
      },
      view,
      { preserveTotalCount: true },
    );

    expect(response.body).toMatchObject({ total_count: 100, workflow_runs: [{ id: 1 }] });
  });
});
