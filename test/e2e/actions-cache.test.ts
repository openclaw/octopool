import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey, readGitHubCache, writeGitHubCache } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import {
  terminalLogCacheKey,
  terminalLogCacheProof,
  terminalLogRunCompleted,
} from "../../src/terminal-log-cache";
import type { RelayRequest } from "../../src/types";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

const LOG_PATH = "/repos/openclaw/octopool/actions/jobs/42/logs";
const RUNS_PATH = "/repos/openclaw/octopool/actions/runs";

describe("terminal Actions log cache", () => {
  beforeEach(seedPool);

  it("caches a fresh completed job and reuses its log after another fresh proof", async () => {
    const upstream = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", upstream);

    const first = await relay(LOG_PATH);
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      body_encoding: "text",
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    const second = await relay(LOG_PATH);
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      body_encoding: "text",
      relay: { cache: "hit", cacheable: true, route_kind: "job_logs" },
    });
    expect(jobMetadataCalls(upstream)).toBe(2);
    expect(logBackendCalls(upstream)).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT cache_status, cacheable FROM audit_events ORDER BY rowid ASC",
      ).all(),
    ).toMatchObject({
      results: [
        { cache_status: "miss", cacheable: 1 },
        { cache_status: "hit", cacheable: 1 },
      ],
    });
  });

  it("bypasses an active rerun job despite a cached completed run", async () => {
    const runRequest: RelayRequest = {
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/octopool/actions/runs/99",
    };
    const policy = defaultPolicy("openclaw");
    const runRoute = classifyRoute(runRequest, policy);
    const runKey = await githubCacheKey(runRequest.pool, runRequest, runRoute);
    await writeGitHubCache(env, runKey, runRequest, runRoute, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: 99, status: "completed", run_attempt: 1 },
      body_encoding: "json",
    });
    await expect(readGitHubCache(env, runKey)).resolves.toMatchObject({
      body: { status: "completed" },
    });

    const upstream = terminalLogUpstream("in_progress");
    vi.stubGlobal("fetch", upstream);
    const put = vi.spyOn(env.ACTIONS_LOGS, "put");

    const response = await relay(LOG_PATH);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      relay: { cache: "bypass", route_kind: "job_logs" },
    });
    expect(jobMetadataCalls(upstream)).toBe(1);
    expect(logBackendCalls(upstream)).toBe(1);
    expect(put).not.toHaveBeenCalled();
    expect(
      await env.ACTIONS_LOGS.get(
        terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH }),
      ),
    ).toBeNull();
    put.mockRestore();
  });

  it.each(["if-none-match", "if-modified-since"] as const)(
    "bypasses R2 reads and writes for %s requests",
    async (header) => {
      const upstream = terminalLogUpstream("completed");
      vi.stubGlobal("fetch", upstream);
      await relay(LOG_PATH);
      const get = vi.spyOn(env.ACTIONS_LOGS, "get");
      const put = vi.spyOn(env.ACTIONS_LOGS, "put");

      const response = await relay(LOG_PATH, undefined, {
        headers: { [header]: '"fixture"' },
      });

      expect(await response.json<RelayEnvelope>()).toMatchObject({
        status: 200,
        body: "build log\n",
        relay: { cache: "bypass", cacheable: true, route_kind: "job_logs" },
      });
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(logBackendCalls(upstream)).toBe(2);
      expect(
        upstream.mock.calls.some(([input, init]) => {
          const request = new Request(input, init);
          return (
            bearer(request) === "test-primary-token" && request.headers.get(header) === '"fixture"'
          );
        }),
      ).toBe(true);
      get.mockRestore();
      put.mockRestore();
    },
  );

  it("does not mint a public-repository proof from a 404 metadata response", async () => {
    const request: RelayRequest = { pool: "maintainers", method: "GET", path: LOG_PATH };
    const policy = defaultPolicy("openclaw");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ message: "Not Found" }, 404)),
    );

    await expect(
      terminalLogRunCompleted(
        env,
        createExecutionContext(),
        request,
        classifyRoute(request, policy),
        policy,
      ),
    ).resolves.toBe(false);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_public_repos").first(),
    ).toEqual({ count: 0 });
  });

  it.each([
    ["in_progress", 2, false],
    ["completed", undefined, false],
    ["completed", 2, true],
  ] as const)(
    "uses fresh whole-run status %s attempt %s instead of cached completion",
    async (status, runAttempt, cacheable) => {
      const policy = defaultPolicy("openclaw");
      const runRequest: RelayRequest = {
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/actions/runs/99",
      };
      const runRoute = classifyRoute(runRequest, policy);
      await writeGitHubCache(
        env,
        await githubCacheKey(runRequest.pool, runRequest, runRoute),
        runRequest,
        runRoute,
        {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { id: 99, status: "completed", run_attempt: 1 },
          body_encoding: "json",
        },
      );
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === runRequest.path) {
          return jsonResponse({
            id: 99,
            status,
            ...(runAttempt === undefined ? {} : { run_attempt: runAttempt }),
          });
        }
        return jsonResponse({ message: "unavailable" }, 503);
      });
      vi.stubGlobal("fetch", upstream);
      const logRequest: RelayRequest = {
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/octopool/actions/runs/99/logs",
      };
      const logRoute = classifyRoute(
        { pool: "maintainers", method: "GET", path: LOG_PATH },
        policy,
      );

      const proof = await terminalLogCacheProof(
        env,
        createExecutionContext(),
        logRequest,
        logRoute,
        policy,
      );
      expect(proof).toEqual(
        cacheable ? { key: terminalLogCacheKey(logRequest, runAttempt) } : undefined,
      );
      expect(
        upstream.mock.calls.filter(([input, init]) => {
          const request = new Request(input, init);
          return new URL(request.url).pathname === runRequest.path;
        }),
      ).toHaveLength(1);
    },
  );

  it("bypasses the log cache while the owning job is active", async () => {
    const upstream = terminalLogUpstream("in_progress");
    vi.stubGlobal("fetch", upstream);

    const first = await relay(LOG_PATH);
    const second = await relay(LOG_PATH);
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      relay: { cache: "bypass", cacheable: true, route_kind: "job_logs" },
    });
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      relay: { cache: "bypass", cacheable: true, route_kind: "job_logs" },
    });
    expect(logBackendCalls(upstream)).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT cache_status, cacheable FROM audit_events ORDER BY rowid ASC",
      ).all(),
    ).toMatchObject({
      results: [
        { cache_status: "bypass", cacheable: 0 },
        { cache_status: "bypass", cacheable: 0 },
      ],
    });
  });

  it("falls back to a backend fetch when the R2 read fails", async () => {
    const upstream = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", upstream);
    await relay(LOG_PATH);
    const get = vi
      .spyOn(env.ACTIONS_LOGS, "get")
      .mockRejectedValueOnce(new Error("R2 unavailable"));

    const response = await relay(LOG_PATH);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    expect(jobMetadataCalls(upstream)).toBe(2);
    expect(logBackendCalls(upstream)).toBe(2);
    get.mockRestore();
  });

  it("fails open to the unchanged bypass when the completion probe throws", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const token = bearer(request);
      if (token === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (token === "test-primary-token") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://results-receiver.actions.githubusercontent.com/logs/fixture",
          },
        });
      }
      if (url.hostname === "results-receiver.actions.githubusercontent.com") {
        return new Response("build log\n", { headers: { "content-type": "text/plain" } });
      }
      throw new Error("metadata backend unavailable");
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(LOG_PATH);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      relay: { cache: "bypass", cacheable: true, route_kind: "job_logs" },
    });
    expect(logBackendCalls(upstream)).toBe(1);
  });

  it("purges an hour-old cached log when the authenticated probe returns 404", async () => {
    let logRequests = 0;
    const base = terminalLogUpstream("completed");
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-primary-token") {
        logRequests++;
        if (logRequests === 2) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", upstream);
    await relay(LOG_PATH);
    const key = terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH });
    await ageTerminalLog(key, "-2 hours");

    const response = await relay(LOG_PATH);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 404,
      body: { message: "Not Found" },
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    expect(await env.ACTIONS_LOGS.get(key)).toBeNull();
    expect(logBackendCalls(upstream)).toBe(2);
  });

  it("refreshes the one-hour no-contact window after an existence probe", async () => {
    const upstream = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", upstream);
    await relay(LOG_PATH);
    const key = terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH });
    await ageTerminalLog(key, "-2 hours");

    expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
      body: "build log\n",
      relay: { cache: "hit" },
    });
    expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
      body: "build log\n",
      relay: { cache: "hit" },
    });
    expect(jobMetadataCalls(upstream)).toBe(3);
    expect(logBackendCalls(upstream)).toBe(2);
  });

  it("refetches an expired R2 log object", async () => {
    const upstream = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", upstream);
    await relay(LOG_PATH);
    const request: RelayRequest = {
      pool: "maintainers",
      method: "GET",
      path: LOG_PATH,
    };
    const key = terminalLogCacheKey(request);
    const object = await env.ACTIONS_LOGS.get(key);
    expect(object).not.toBeNull();
    await env.ACTIONS_LOGS.put(key, await object!.arrayBuffer(), {
      ...(object!.httpMetadata === undefined ? {} : { httpMetadata: object!.httpMetadata }),
      customMetadata: {
        ...object!.customMetadata,
        "created-at": "2000-01-01 00:00:00",
      },
    });

    const response = await relay(LOG_PATH);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: "build log\n",
      relay: { cache: "miss" },
    });
    expect(logBackendCalls(upstream)).toBe(2);
  });

  it("re-establishes fresh public proof before serving an R2 hit", async () => {
    const fill = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", fill);
    await relay(LOG_PATH);
    await env.DB.prepare("DELETE FROM github_public_repos").run();
    await deleteEdgeJSON("public-repo-v1", "openclaw/octopool");
    const guarded = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: true });
      }
      if (url.pathname === "/repos/openclaw/octopool/actions/jobs/42") {
        return jsonResponse({ id: 42, run_id: 99, status: "completed" });
      }
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", guarded);

    const response = await relay(LOG_PATH);
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      body: "build log\n",
      relay: { cache: "hit" },
    });
    expect(jobMetadataCalls(guarded)).toBe(1);
    expect(logBackendCalls(guarded)).toBe(0);
  });
});

describe("Actions run-list superset", () => {
  beforeEach(seedPool);

  it("serves branch, status, and limit variants from one canonical fill", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(bearer(request)).toBeUndefined();
      const url = new URL(request.url);
      expect(url.hostname).toBe("github.com");
      expect(url.pathname).toBe("/openclaw/octopool/actions");
      expect(Object.fromEntries(url.searchParams)).toEqual({});
      return new Response(
        runListHTML(4, [
          [1, "main", "completed successfully"],
          [2, "main", "failed"],
          [3, "feature", "in progress"],
          [4, "main", "queued"],
        ]),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const branch = await shapedRunList({ branch: "main", per_page: "2" });
    expect(branch.body).toMatchObject({ total_count: 3 });
    expect(runIDs(branch.body)).toEqual([1, 2]);

    const status = await shapedRunList({ status: "failure", per_page: "1" });
    expect(status.body).toMatchObject({ total_count: 1 });
    expect(runIDs(status.body)).toEqual([2]);

    const limited = await shapedRunList({ limit: "1" });
    expect(limited.body).toMatchObject({ total_count: 4 });
    expect(runIDs(limited.body)).toEqual([1]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT backend FROM audit_events WHERE cache_status = 'miss' LIMIT 1",
      ).first(),
    ).toEqual({ backend: "github_web" });
  });

  it("normalizes and locally shapes a conditional shim request", async () => {
    let exactURL: URL | undefined;
    let conditionalHeader: string | null = null;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (bearer(request) === "test-primary-token") {
        exactURL = new URL(request.url);
        conditionalHeader = request.headers.get("if-none-match");
        return jsonResponse(
          {
            total_count: 100,
            workflow_runs: [
              run(1, "main", "completed", "success"),
              run(2, "main", "completed", "success"),
              run(3, "main", "completed", "success"),
            ],
          },
          200,
          {
            etag: '"upstream"',
            "last-modified": "Sat, 18 Jul 2026 08:00:00 GMT",
            link: '<https://api.github.com/repositories/1/actions/runs?page=2>; rel="next"',
          },
        );
      }
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { limit: "2" },
      headers: {
        "x-octopool-public-shape": "actions-summary-v1",
        "if-none-match": '"client"',
      },
    });
    expect(response.status).toBe(200);
    const envelope = await response.json<RelayEnvelope>();
    expect(runIDs(envelope.body)).toEqual([1, 2]);
    expect(envelope.body).toMatchObject({ total_count: 100 });
    expect(envelope.headers).not.toHaveProperty("etag");
    expect(envelope.headers).not.toHaveProperty("last-modified");
    expect(envelope.headers).not.toHaveProperty("link");
    expect(Object.fromEntries(exactURL!.searchParams)).toEqual({ per_page: "2" });
    expect(conditionalHeader).toBe('"client"');
  });

  it("falls back to an exact filtered request when the superset can underfill", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      if (url.hostname === "api.github.com") {
        return jsonResponse({
          total_count: 3,
          workflow_runs: [
            run(101, "target", "completed", "success"),
            run(102, "target", "completed", "success"),
            run(103, "target", "completed", "success"),
          ],
        });
      }
      return new Response(
        runListHTML(
          200,
          Array.from({ length: 25 }, (_, index) => [index + 1, "main", "completed successfully"]),
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await shapedRunList({ branch: "target", limit: "2" });
    expect(runIDs(response.body)).toEqual([101, 102]);
    expect(urls).toHaveLength(2);
    expect(urls.map((url) => url.hostname)).toEqual(["github.com", "api.github.com"]);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({});
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({
      branch: "target",
      per_page: "2",
    });
  });

  it("does not treat a page-sized total as proof that a filter is complete", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(new Request(input).url);
      urls.push(url);
      if (url.hostname === "api.github.com") {
        return jsonResponse({
          total_count: 20,
          workflow_runs: Array.from({ length: 20 }, (_, index) =>
            run(index + 100, "main", "completed", "failure"),
          ),
        });
      }
      return new Response(
        runListHTML(
          25,
          Array.from({ length: 25 }, (_, index) => [index + 1, "main", "completed successfully"]),
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await shapedRunList({ status: "failure", limit: "20" });
    expect(runIDs(response.body)).toHaveLength(20);
    expect(urls.map((url) => url.hostname)).toEqual(["github.com", "api.github.com"]);
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({
      per_page: "20",
      status: "failure",
    });
  });

  it("preserves GitHub validation for unsupported status values", async () => {
    const apiRequests: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: false });
      }
      if (url.hostname === "github.com") {
        return new Response("not found", { status: 404 });
      }
      apiRequests.push(url);
      return jsonResponse({ message: "Validation Failed" }, 422);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { status: "not-a-github-status" },
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 422,
      body: { message: "Validation Failed" },
    });
    expect(apiRequests).toHaveLength(2);
    for (const url of apiRequests) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ status: "not-a-github-status" });
    }
  });

  it("shares workflow-scoped variants through one public page fill", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      expect(url.hostname).toBe("github.com");
      return new Response(
        runListHTML(2, [
          [9, "main", "completed successfully"],
          [10, "main", "completed successfully"],
        ]),
      );
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { branch: "main", limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect(response.status).toBe(200);
    const envelope = await response.json<RelayEnvelope>();
    expect(runIDs(envelope.body)).toEqual([9]);
    expect(envelope.body).toMatchObject({ total_count: 2 });
    const cached = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { status: "success", limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect((await cached.json<RelayEnvelope>()).relay.cache).toBe("hit");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe("/openclaw/octopool/actions/workflows/ci.yml");
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({});
  });

  it("leaves non-shim run-list requests on exact per-query caching", async () => {
    const urls: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      return jsonResponse({
        total_count: 1,
        workflow_runs: [run(7, "main", "completed", "success")],
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(RUNS_PATH, undefined, {
      query: { branch: "main", per_page: "1" },
    });
    expect(response.status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      branch: "main",
      per_page: "1",
    });
  });
});

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

function terminalLogUpstream(status: "completed" | "in_progress") {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const token = bearer(request);
    if (token === "test-org-token") {
      return jsonResponse({ private: false });
    }
    if (token === "test-primary-token") {
      expect(url.pathname).toBe(LOG_PATH);
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://results-receiver.actions.githubusercontent.com/logs/fixture",
          ...rateHeaders({ remaining: 4_998 }),
        },
      });
    }
    if (url.hostname === "results-receiver.actions.githubusercontent.com") {
      return new Response("build log\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/repos/openclaw/octopool/actions/jobs/42") {
      return jsonResponse({ id: 42, run_id: 99, status });
    }
    if (url.pathname === "/repos/openclaw/octopool/actions/runs/99") {
      return jsonResponse({ id: 99, status });
    }
    return jsonResponse({ message: "not found" }, 404);
  });
}

function logBackendCalls(upstream: ReturnType<typeof vi.fn<typeof fetch>>): number {
  return upstream.mock.calls.filter(([input, init]) => {
    const request = new Request(input, init);
    return bearer(request) === "test-primary-token" && new URL(request.url).pathname === LOG_PATH;
  }).length;
}

function jobMetadataCalls(upstream: ReturnType<typeof vi.fn<typeof fetch>>): number {
  return upstream.mock.calls.filter(([input, init]) => {
    const request = new Request(input, init);
    return (
      bearer(request) === undefined &&
      new URL(request.url).pathname === "/repos/openclaw/octopool/actions/jobs/42"
    );
  }).length;
}

async function ageTerminalLog(key: string, modifier: string): Promise<void> {
  const object = await env.ACTIONS_LOGS.get(key);
  expect(object).not.toBeNull();
  const row = await env.DB.prepare("SELECT datetime('now', ?) AS created_at")
    .bind(modifier)
    .first<{ created_at: string }>();
  await env.ACTIONS_LOGS.put(key, await object!.arrayBuffer(), {
    ...(object!.httpMetadata === undefined ? {} : { httpMetadata: object!.httpMetadata }),
    customMetadata: {
      ...object!.customMetadata,
      "created-at": row!.created_at,
    },
  });
}

async function shapedRunList(query: Record<string, string>): Promise<RelayEnvelope> {
  const response = await relay(RUNS_PATH, undefined, {
    query,
    headers: { "x-octopool-public-shape": "actions-summary-v1" },
  });
  expect(response.status).toBe(200);
  return response.json<RelayEnvelope>();
}

function run(
  id: number,
  headBranch: string,
  status: string,
  conclusion: string | null,
): Record<string, unknown> {
  return { id, head_branch: headBranch, status, conclusion };
}

function runIDs(body: unknown): number[] {
  if (typeof body !== "object" || body === null || !("workflow_runs" in body)) {
    return [];
  }
  const runs = body.workflow_runs;
  return Array.isArray(runs)
    ? runs.flatMap((item) =>
        typeof item === "object" && item !== null && "id" in item && typeof item.id === "number"
          ? [item.id]
          : [],
      )
    : [];
}

function runListHTML(total: number, runs: [id: number, branch: string, state: string][]): string {
  return `<strong>${total} workflow runs</strong>${runs
    .map(
      ([id, branch, state]) => `
        <div class="Box-row js-socket-channel js-updatable-content">
          <a href="/openclaw/octopool/actions/runs/${id}" aria-label="${state}: Run ${id} of CI. run ${id}">
            <span class="h4 markdown-title">run ${id}</span>
          </a>
          <span class="text-bold">CI</span> #${id}:
          Commit <a href="/openclaw/octopool/commit/1e6a563d13924ba423febe3a4cb47eeb9d594322">1e6a563</a>
          pushed
          <relative-time datetime="2026-06-11T06:38:49Z"></relative-time>
          <a class="branch-name" href="/openclaw/octopool/tree/refs/heads/${branch}">${branch}</a>
        </div>`,
    )
    .join("")}`;
}
