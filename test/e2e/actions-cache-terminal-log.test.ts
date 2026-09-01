import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { withGitHubEgress } from "../../src/github-egress";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey, readGitHubCache } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import {
  terminalLogCacheKey,
  terminalLogCacheProof,
  terminalLogRunCompleted,
} from "../../src/terminal-log-cache";
import type { RelayRequest } from "../../src/types";
import { bearer, jsonResponse, rateHeaders, relay, seedPool, runWithContext } from "./harness";
import { historicalHead, runCard } from "../fixtures/actions-ownership";

type RelayEnvelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; cacheable: boolean; route_kind: string };
};

const LOG_PATH = "/repos/openclaw/octopool/actions/jobs/42/logs";
describe("terminal Actions log cache", () => {
  beforeEach(seedPool);

  it.each(["in_progress", "unavailable"])(
    "keeps fresh %s job metadata authoritative over misleading summaries and stored logs",
    async (metadata) => {
      vi.stubGlobal("fetch", terminalLogUpstream("completed"));
      expect((await (await relay(LOG_PATH)).json<RelayEnvelope>()).relay.cache).toBe("miss");
      const download = terminalLogUpstream("in_progress");
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "github.com" && url.pathname === "/openclaw/octopool/actions") {
          return new Response(
            `<strong>1 workflow run</strong>${runCard(99, historicalHead, { state: "in progress", title: "Fix failed test Handle pushed commits" })}`.replaceAll(
              "openclaw/Peekaboo",
              "openclaw/octopool",
            ),
          );
        }
        if (url.pathname === "/repos/openclaw/octopool/actions/jobs/42") {
          expect(bearer(request)).toBeUndefined();
          expect(request.headers.has("x-octopool-public-shape")).toBe(false);
          expect(request.headers.has("if-none-match")).toBe(false);
          if (metadata === "unavailable") return jsonResponse({ message: "unavailable" }, 503);
        }
        return download(input, init);
      });
      vi.stubGlobal("fetch", upstream);
      const list = await relay("/repos/openclaw/octopool/actions/runs", undefined, {
        query: { limit: "1" },
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      });
      expect((await list.json<RelayEnvelope>()).relay.cache).toBe("miss");
      for (const suffix of ["runs/99", "jobs/42"]) {
        for (const shape of [undefined, "actions-summary-v1"]) {
          const request: RelayRequest = {
            pool: "maintainers",
            method: "GET",
            path: `/repos/openclaw/octopool/actions/${suffix}`,
            ...(shape === undefined ? {} : { headers: { "x-octopool-public-shape": shape } }),
          };
          const route = classifyRoute(request, defaultPolicy("openclaw"));
          const key = await githubCacheKey(request.pool, request, route);
          await writeGitHubCache(env, key, request, route, {
            status: 200,
            headers: {},
            body: { id: 42, run_id: 99, status: "completed", run_attempt: 1 },
            body_encoding: "json",
          });
          expect(await readGitHubCache(env, key)).toMatchObject({ body: { status: "completed" } });
        }
      }
      const get = vi.spyOn(env.ACTIONS_LOGS, "get");
      const put = vi.spyOn(env.ACTIONS_LOGS, "put");
      try {
        expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
          body: "build log\n",
          relay: { cache: "bypass" },
        });
        expect(jobMetadataCalls(upstream)).toBe(1);
        expect(logBackendCalls(upstream)).toBe(1);
        expect(get).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
      } finally {
        get.mockRestore();
        put.mockRestore();
      }
    },
  );

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
      runWithContext((ctx) =>
        terminalLogRunCompleted(
          withGitHubEgress(env, []),
          ctx,
          request,
          classifyRoute(request, policy),
          policy,
        ),
      ),
    ).resolves.toBe(false);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_public_repo_proofs").first(),
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

      const proof = await runWithContext((ctx) =>
        terminalLogCacheProof(withGitHubEgress(env, []), ctx, logRequest, logRoute, policy),
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
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON("public-repo-publication-v1", "openclaw/octopool");
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
