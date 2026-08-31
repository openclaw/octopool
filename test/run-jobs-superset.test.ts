import { describe, expect, it } from "vitest";
import { githubCacheKey } from "../src/cache";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import {
  completeRunJobsSuperset,
  filterRunJobsSuperset,
  runJobsSupersetIncomplete,
  runJobsSupersetView,
} from "../src/run-jobs-superset";

describe("Actions job-list superset", () => {
  const policy = defaultPolicy("openclaw");

  it("canonicalizes equivalent bounded latest-attempt variants", async () => {
    const request = (query: Record<string, string>) =>
      validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
        query,
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      });
    const first = request({ per_page: "30" });
    const second = request({ filter: "latest", page: "1", per_page: "100" });
    const firstRoute = classifyRoute(first, policy);
    const secondRoute = classifyRoute(second, policy);
    const firstView = runJobsSupersetView(first, firstRoute);
    const secondView = runJobsSupersetView(second, secondRoute);

    expect(firstView).toMatchObject({
      cacheRequest: { query: { page: "1", per_page: "100" } },
      limit: 30,
    });
    expect(secondView).toMatchObject({ limit: 100 });
    await expect(githubCacheKey("maintainers", firstView!.cacheRequest, firstRoute)).resolves.toBe(
      await githubCacheKey("maintainers", secondView!.cacheRequest, secondRoute),
    );
  });

  it.each([[{ page: "2" }], [{ filter: "all" }], [{ per_page: "101" }]])(
    "keeps unsupported or potentially multi-attempt query %o exact",
    (query) => {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/actions/runs/42/jobs",
        query,
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      });
      expect(runJobsSupersetView(request, classifyRoute(request, policy))).toBeUndefined();
    },
  );

  it("refuses incomplete pagination and strips canonical representation headers", () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      query: { per_page: "1" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    const view = runJobsSupersetView(request, classifyRoute(request, policy));
    const response = {
      status: 200,
      headers: {
        etag: '"canonical"',
        link: '<https://api.github.com/jobs?page=1>; rel="prev"',
        "content-length": "123",
        "content-type": "application/json",
      },
      body: { total_count: 2, jobs: [{ id: 1 }, { id: 2 }] },
      body_encoding: "json" as const,
    };

    expect(runJobsSupersetIncomplete(response, view)).toBe(false);
    expect(filterRunJobsSuperset(response, view)).toEqual({
      ...response,
      headers: { "content-type": "application/json" },
      body: { total_count: 2, jobs: [{ id: 1 }] },
    });
    expect(
      runJobsSupersetIncomplete(
        { ...response, body: { total_count: 3, jobs: [{ id: 1 }, { id: 2 }] } },
        view,
      ),
    ).toBe(true);
  });

  it("merges bounded API pages in order while preserving GitHub's total", async () => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/42/jobs",
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    const view = runJobsSupersetView(request, classifyRoute(request, policy));
    const pages: string[] = [];
    const response = await completeRunJobsSuperset(
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://api.github.com/jobs?page=2>; rel="next"',
        },
        body: { total_count: 250, jobs: jobs(1, 100) },
        body_encoding: "json",
      },
      view,
      async (pageRequest) => {
        const page = String(pageRequest.query?.page);
        pages.push(page);
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: `<https://api.github.com/jobs?page=${page === "2" ? 3 : 2}>; rel="${page === "2" ? "next" : "prev"}"`,
          },
          body: {
            total_count: 250,
            jobs: page === "2" ? jobs(101, 100) : jobs(201, 50),
          },
          body_encoding: "json",
        };
      },
    );

    expect(pages).toEqual(["2", "3"]);
    expect(response.body).toMatchObject({ total_count: 250 });
    expect((response.body as { jobs: unknown[] }).jobs).toHaveLength(250);
    expect(response.headers).not.toHaveProperty("link");
  });

  it.each([
    { name: "partial rerun metadata", total: 3, jobs: jobs(3, 1), link: undefined },
    {
      name: "next link despite matching count",
      total: 1,
      jobs: jobs(3, 1),
      link: '<https://api.github.com/jobs?page=2>; rel="next"',
    },
    {
      name: "next link at the cap",
      total: 300,
      jobs: jobs(1, 100),
      link: '<https://api.github.com/jobs?page=2>; rel="next"',
    },
  ])("rejects $name without publishing a partial superset", async (test) => {
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    const view = runJobsSupersetView(request, classifyRoute(request, policy));
    const pages: string[] = [];
    const response = await completeRunJobsSuperset(
      {
        status: 200,
        headers: test.link ? { Link: test.link } : {},
        body: { total_count: test.total, jobs: test.jobs },
        body_encoding: "json",
      },
      view,
      async (pageRequest) => {
        const page = Number(pageRequest.query?.page);
        pages.push(String(page));
        return {
          status: 200,
          headers: { link: `<https://api.github.com/jobs?page=${page + 1}>; rel="next"` },
          body: { total_count: test.total, jobs: jobs((page - 1) * 100 + 1, 100) },
          body_encoding: "json",
        };
      },
    );
    expect(runJobsSupersetIncomplete(response, view)).toBe(true);
    expect(pages).toEqual(test.total === 300 ? ["2", "3"] : []);
  });
});

function jobs(first: number, count: number): { id: number }[] {
  return Array.from({ length: count }, (_, index) => ({ id: first + index }));
}
