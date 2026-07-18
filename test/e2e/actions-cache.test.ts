import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { terminalLogCacheKey } from "../../src/terminal-log-cache";
import type { RelayRequest } from "../../src/types";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";

type RelayEnvelope = {
  status: number;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

const LOG_PATH = "/repos/openclaw/octopool/actions/jobs/42/logs";
const RUNS_PATH = "/repos/openclaw/octopool/actions/runs";

describe("terminal Actions log cache", () => {
  beforeEach(seedPool);

  it("caches a completed-run log and serves the next request without a backend fetch", async () => {
    const upstream = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", upstream);

    const first = await relay(LOG_PATH);
    expect(await first.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      body_encoding: "text",
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    const callsAfterFill = upstream.mock.calls.length;

    const second = await relay(LOG_PATH);
    expect(await second.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      body_encoding: "text",
      relay: { cache: "hit", cacheable: true, route_kind: "job_logs" },
    });
    expect(upstream).toHaveBeenCalledTimes(callsAfterFill);
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

  it("bypasses the log cache while the owning run is active", async () => {
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
    const callsAfterFill = upstream.mock.calls.length;
    const get = vi
      .spyOn(env.ACTIONS_LOGS, "get")
      .mockRejectedValueOnce(new Error("R2 unavailable"));

    const response = await relay(LOG_PATH);
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 200,
      body: "build log\n",
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    expect(upstream.mock.calls.length).toBe(callsAfterFill + 3);
    expect(logBackendCalls(upstream)).toBe(2);
    get.mockRestore();
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

  it("runs the public-repository guard before serving an R2 hit", async () => {
    const fill = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", fill);
    await relay(LOG_PATH);
    await env.DB.prepare("DELETE FROM github_public_repos").run();
    await deleteEdgeJSON("public-repo-v1", "openclaw/octopool");
    const guarded = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") {
        return jsonResponse({ private: true });
      }
      return jsonResponse({ message: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", guarded);

    const response = await relay(LOG_PATH);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "repo_not_public" } },
    });
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
      expect(url.pathname).toBe(RUNS_PATH);
      expect(Object.fromEntries(url.searchParams)).toEqual({ page: "1", per_page: "100" });
      return jsonResponse({
        total_count: 200,
        workflow_runs: [
          run(1, "main", "completed", "success"),
          run(2, "main", "completed", "failure"),
          run(3, "feature", "in_progress", null),
          run(4, "main", "queued", null),
        ],
      });
    });
    vi.stubGlobal("fetch", upstream);

    const branch = await shapedRunList({ branch: "main", per_page: "2" });
    expect(branch.body).toMatchObject({ total_count: 3 });
    expect(runIDs(branch.body)).toEqual([1, 2]);

    const status = await shapedRunList({ status: "failure", per_page: "100" });
    expect(status.body).toMatchObject({ total_count: 1 });
    expect(runIDs(status.body)).toEqual([2]);

    const limited = await shapedRunList({ limit: "1" });
    expect(limited.body).toMatchObject({ total_count: 4 });
    expect(runIDs(limited.body)).toEqual([1]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("leaves workflow-scoped shaped requests on their exact upstream path", async () => {
    const apiRequests: URL[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "github.com") {
        return new Response("not found", { status: 404 });
      }
      apiRequests.push(url);
      return jsonResponse({
        total_count: 1,
        workflow_runs: [run(9, "main", "completed", "success")],
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await relay(
      "/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
      undefined,
      {
        query: { branch: "main", per_page: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      },
    );
    expect(response.status).toBe(200);
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]?.pathname).toContain("/actions/workflows/ci.yml/runs");
    expect(Object.fromEntries(apiRequests[0]!.searchParams)).toEqual({
      branch: "main",
      per_page: "1",
    });
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
