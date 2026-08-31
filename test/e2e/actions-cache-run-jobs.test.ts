import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

describe("Actions attempt job-list cache", () => {
  beforeEach(seedPool);

  it("shares bounded latest variants on an attempt-qualified complete page", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com") {
        return jsonResponse({ message: "public parser unavailable" }, 404);
      }
      expect(request.headers.get("authorization")).toBeNull();
      if (url.pathname.endsWith("/attempts/2")) {
        return jsonResponse({ id: 42, status: "completed", run_attempt: 2 });
      }
      return jsonResponse({
        total_count: 2,
        jobs: [
          { id: 1, status: "completed", conclusion: "success" },
          { id: 2, status: "completed", conclusion: "success" },
        ],
      });
    });
    vi.stubGlobal("fetch", upstream);
    const path = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";

    const first = await relay(path, undefined, {
      query: { per_page: "1" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      body: { total_count: 2, jobs: [{ id: 1 }] },
      relay: { cache: "miss", route_kind: "run_jobs" },
    });
    const second = await relay(path, undefined, {
      query: { filter: "latest", page: "1", per_page: "2" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      body: { total_count: 2, jobs: [{ id: 1 }, { id: 2 }] },
      relay: { cache: "hit", route_kind: "run_jobs" },
    });
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count,
                unixepoch(MAX(expires_at)) - unixepoch(MAX(created_at)) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
      ).first(),
    ).toEqual({ count: 1, ttl: 3600 });
  });

  it("keeps completed-looking jobs short-lived until the owning attempt is terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(new Request(input).url);
        if (url.hostname === "github.com") {
          return jsonResponse({ message: "public parser unavailable" }, 404);
        }
        if (url.pathname.endsWith("/attempts/2")) {
          return jsonResponse({ id: 42, status: "in_progress", run_attempt: 2 });
        }
        return jsonResponse({
          total_count: 1,
          jobs: [{ id: 1, status: "completed", conclusion: "success" }],
        });
      }),
    );
    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );

    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
      ).first(),
    ).toEqual({ ttl: 60 });
  });

  it("merges and caches all API pages for a 250-job run", async () => {
    const jobAPIRequests: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com") {
        return jsonResponse({ message: "public parser unavailable" }, 404);
      }
      expect(bearer(request)).toBeUndefined();
      if (url.pathname.endsWith("/attempts/2")) {
        return jsonResponse({ id: 42, status: "completed", run_attempt: 2 });
      }
      jobAPIRequests.push(url);
      const page = Number(url.searchParams.get("page"));
      const first = (page - 1) * 100 + 1;
      const count = page === 3 ? 50 : 100;
      return jsonResponse({
        total_count: 250,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: first + index,
          status: "completed",
          conclusion: "success",
        })),
      });
    });
    vi.stubGlobal("fetch", upstream);
    const path = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";

    const first = await relay(path, undefined, {
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      body: { total_count: 250 },
      relay: { cache: "miss", route_kind: "run_jobs" },
    });
    const second = await relay(path, undefined, {
      query: { per_page: "100" },
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    });
    expect((await second.json<RelayEnvelope>()).relay.cache).toBe("hit");
    expect(jobAPIRequests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    const cached = await env.DB.prepare(
      "SELECT body_json FROM github_cache_entries WHERE route_kind = 'run_jobs'",
    ).first<{ body_json: string }>();
    expect(JSON.parse(cached!.body_json)).toMatchObject({ total_count: 250 });
    expect((JSON.parse(cached!.body_json) as { jobs: unknown[] }).jobs).toHaveLength(250);
    expect(
      await env.DB.prepare(
        `SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl
         FROM github_cache_entries WHERE route_kind = 'run_jobs'`,
      ).first(),
    ).toEqual({ ttl: 3600 });
  });

  it("fails closed above the three-page API bound", async () => {
    const jobAPIRequests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(new Request(input).url);
        if (url.hostname === "github.com") {
          return jsonResponse({ message: "public parser unavailable" }, 404);
        }
        jobAPIRequests.push(url);
        return jsonResponse({
          total_count: 350,
          jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        });
      }),
    );
    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
    });
    expect(jobAPIRequests.map((url) => url.searchParams.get("page"))).toEqual(["1"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it.each(["rerun count mismatch", "next link with matching count", "next link at cap"])(
    "rejects %s without caching or inventing successful jobs",
    async (variant) => {
      const pages: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(new Request(input).url);
          if (url.hostname === "github.com") {
            return jsonResponse({ message: "public parser unavailable" }, 404);
          }
          expect(url.pathname).toBe("/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs");
          const page = Number(url.searchParams.get("page"));
          pages.push(String(page));
          const atCap = variant === "next link at cap";
          return jsonResponse(
            {
              total_count: atCap ? 300 : variant === "rerun count mismatch" ? 3 : 1,
              jobs: Array.from({ length: atCap ? 100 : 1 }, (_, index) => ({
                id: (page - 1) * 100 + index + 1,
                name: "Swift",
                run_attempt: 2,
                status: "completed",
                conclusion: "success",
              })),
            },
            200,
            variant === "rerun count mismatch"
              ? {}
              : {
                  Link: `<https://api.github.com${url.pathname}?page=${page + 1}>; rel="next"`,
                },
          );
        }),
      );
      const response = await relay(
        "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
        undefined,
        {
          query: { per_page: "100" },
          headers: { "x-octopool-public-shape": "actions-jobs-v1" },
        },
      );
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
      });
      expect(pages).toEqual(variant === "next link at cap" ? ["1", "2", "3"] : ["1"]);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
        ).first(),
      ).toEqual({ count: 0 });
    },
  );

  it.each([false, true])(
    "preserves the exact attempt job set (reused successes: %s)",
    async (includeReused) => {
      const jobs = [
        ...(includeReused
          ? [
              {
                id: 1,
                name: "actions",
                run_attempt: 1,
                status: "completed",
                conclusion: "success",
              },
              {
                id: 2,
                name: "JavaScript",
                run_attempt: 1,
                status: "completed",
                conclusion: "success",
              },
            ]
          : []),
        { id: 3, name: "Swift", run_attempt: 2, status: "completed", conclusion: "failure" },
      ];
      const apiPaths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(new Request(input).url);
          if (url.hostname === "github.com") {
            return jsonResponse({ message: "public parser unavailable" }, 404);
          }
          apiPaths.push(url.pathname);
          if (url.pathname.endsWith("/attempts/2")) {
            return jsonResponse({
              id: 42,
              run_attempt: 2,
              status: "completed",
              conclusion: "failure",
            });
          }
          return jsonResponse({ total_count: jobs.length, jobs });
        }),
      );
      const path = "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs";
      const response = await relay(path, undefined, {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      });
      expect(response.status).toBe(200);
      expect((await response.json<RelayEnvelope>()).body).toEqual({
        total_count: jobs.length,
        jobs,
      });
      expect(apiPaths).toEqual([path, path.replace(/\/jobs$/, "")]);
    },
  );

  it("keeps raw REST metadata exact even when the count includes absent rerun jobs", async () => {
    const body = { total_count: 3, jobs: [{ id: 3, name: "Swift", run_attempt: 2 }] };
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse(body));
    vi.stubGlobal("fetch", upstream);
    const response = await relay("/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs");
    expect(response.status).toBe(200);
    expect((await response.json<RelayEnvelope>()).body).toEqual(body);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("falls back without caching a partial merge when page two fails", async () => {
    const apiRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "github.com") {
          return jsonResponse({ message: "public parser unavailable" }, 404);
        }
        apiRequests.push(request);
        if (url.searchParams.get("page") === "2") {
          return jsonResponse({ message: "unavailable" }, 503);
        }
        return jsonResponse({
          total_count: 250,
          jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        });
      }),
    );

    const response = await relay(
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      undefined,
      {
        query: { per_page: "100" },
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
      },
    );

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
    });
    expect(apiRequests.map((request) => new URL(request.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
    expect(apiRequests.every((request) => bearer(request) === undefined)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
      ).first(),
    ).toEqual({ count: 0 });
  });
});
