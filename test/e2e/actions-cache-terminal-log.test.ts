import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { withGitHubEgress } from "../../src/github-egress";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey, readGitHubCache } from "../../src/cache";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { terminalLogCacheKey, terminalLogCacheProof } from "../../src/terminal-log-cache";
import type { RelayRequest } from "../../src/types";
import { bearer, jsonResponse, rateHeaders, relay, seedPool, runWithContext } from "./harness";
import { historicalHead, runCard } from "../fixtures/actions-ownership";
import { envelopeBytes, opaqueBytes } from "../fixtures/opaque-bytes";

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

  it.each([opaqueBytes[0], opaqueBytes[2], opaqueBytes[5], opaqueBytes[6]])(
    "stores literal $name bytes in native R2 and reuses them after fresh completion",
    async (fixture) => {
      const upstream = terminalLogUpstream("completed", new Uint8Array(fixture.bytes));
      vi.stubGlobal("fetch", upstream);
      const key = terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH });
      for (const cache of ["miss", "hit"]) {
        const response = await relay(LOG_PATH);
        expect(response.status).toBe(200);
        const wire = await response.json<RelayEnvelope>();
        expect.soft(envelopeBytes(wire)).toEqual(fixture.bytes);
        expect.soft(wire).toMatchObject({
          status: 200,
          body_encoding: fixture.encoding,
          headers: { "content-type": "text/plain" },
          relay: { cache },
        });
        const object = await env.ACTIONS_LOGS.get(key);
        expect(object).not.toBeNull();
        expect.soft([...new Uint8Array(await object!.arrayBuffer())]).toEqual(fixture.bytes);
        expect.soft(object!.customMetadata).toMatchObject({
          "body-codec": "lossless-v1",
          "body-encoding": fixture.encoding,
          "created-at": expect.any(String),
        });
      }
      expect(jobMetadataCalls(upstream)).toBe(2);
      expect(logBackendCalls(upstream)).toBe(1);
      expect(downloadCalls(upstream)).toBe(1);
    },
  );

  it.each([
    { marker: undefined, age: "-10 minutes", encoding: "text", body: "�A" },
    { marker: undefined, age: "-2 hours", encoding: "text", body: "�A" },
    { marker: "lossless-v0", age: "-2 hours", encoding: "text", body: "�A" },
    { marker: "lossless-v1-extra", age: "-10 minutes", encoding: "text", body: "�A" },
    {
      marker: undefined,
      age: "-10 minutes",
      encoding: "base64",
      body: new Uint8Array([0xff, 0x41]),
    },
  ])(
    "redownloads legacy R2 $encoding / $marker / $age before serving or renewing",
    async (fixture) => {
      const original = [0xff, 0x41];
      const key = terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH });
      await seedLegacyLog(key, fixture);
      const rejected = await env.ACTIONS_LOGS.get(key);
      expect(rejected).not.toBeNull();
      const cancel = vi.spyOn(rejected!.body, "cancel");
      vi.spyOn(env.ACTIONS_LOGS, "get").mockResolvedValueOnce(rejected);
      const upstream = terminalLogUpstream("completed", new Uint8Array(original));
      vi.stubGlobal("fetch", upstream);
      const remove = vi.spyOn(env.ACTIONS_LOGS, "delete");
      const wire = await (await relay(LOG_PATH)).json<RelayEnvelope>();
      expect.soft(envelopeBytes(wire)).toEqual(original);
      expect.soft(wire.relay.cache).toBe("miss");
      expect.soft(downloadCalls(upstream)).toBe(1);
      expect(remove).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      const object = await env.ACTIONS_LOGS.get(key);
      expect.soft([...new Uint8Array(await object!.arrayBuffer())]).toEqual(original);
      expect
        .soft(object!.customMetadata)
        .toMatchObject({ "body-codec": "lossless-v1", "body-encoding": "base64" });
    },
  );

  it("keeps a rejected object's bytes until a download and replacement succeed, including a late old writer", async () => {
    const key = terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH });
    await seedLegacyLog(key, { age: "-2 hours", encoding: "text", body: "�A" });
    const before = await env.ACTIONS_LOGS.get(key);
    const oldBytes = [...new Uint8Array(await before!.arrayBuffer())];
    const base = terminalLogUpstream("completed", new Uint8Array([0xff, 0x41]));
    const failed = vi.fn<typeof fetch>(async (input, init) =>
      new URL(new Request(input, init).url).hostname ===
      "results-receiver.actions.githubusercontent.com"
        ? new Response("download unavailable", { status: 503 })
        : base(input, init),
    );
    vi.stubGlobal("fetch", failed);
    const remove = vi.spyOn(env.ACTIONS_LOGS, "delete");
    const failedWire = await (await relay(LOG_PATH)).json<RelayEnvelope>();
    expect.soft(failedWire.status).toBe(503);
    const retained = await env.ACTIONS_LOGS.get(key);
    expect.soft([...new Uint8Array(await retained!.arrayBuffer())]).toEqual(oldBytes);
    expect.soft(retained!.customMetadata).toEqual(before!.customMetadata);
    vi.stubGlobal("fetch", base);
    const put = vi
      .spyOn(env.ACTIONS_LOGS, "put")
      .mockRejectedValueOnce(new Error("synthetic replacement failure"));
    const goodWire = await (await relay(LOG_PATH)).json<RelayEnvelope>();
    expect.soft(envelopeBytes(goodWire)).toEqual([0xff, 0x41]);
    put.mockRestore();
    const afterFailure = await env.ACTIONS_LOGS.get(key);
    expect.soft([...new Uint8Array(await afterFailure!.arrayBuffer())]).toEqual(oldBytes);
    expect.soft(afterFailure!.customMetadata).toEqual(before!.customMetadata);
    expect.soft((await (await relay(LOG_PATH)).json<RelayEnvelope>()).relay.cache).toBe("miss");
    await seedLegacyLog(key, { age: "-10 minutes", encoding: "text", body: "�A" });
    const afterOldWriter = await (await relay(LOG_PATH)).json<RelayEnvelope>();
    expect.soft(envelopeBytes(afterOldWriter)).toEqual([0xff, 0x41]);
    expect.soft(afterOldWriter.relay.cache).toBe("miss");
    expect.soft(downloadCalls(base)).toBe(3);
    expect(remove).not.toHaveBeenCalled();
  });

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
        terminalLogCacheProof(
          withGitHubEgress(env, []),
          ctx,
          request,
          classifyRoute(request, policy),
          policy,
        ),
      ),
    ).resolves.toBeUndefined();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM github_public_repo_proofs").first(),
    ).toEqual({ count: 0 });
  });

  it.each(["/actions/runs/99/logs", "/actions/runs/99/attempts/2/logs"])(
    "denies whole-run %s at the Worker without upstream or R2 access",
    async (suffix) => {
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const get = vi.spyOn(env.ACTIONS_LOGS, "get");
      const put = vi.spyOn(env.ACTIONS_LOGS, "put");
      const remove = vi.spyOn(env.ACTIONS_LOGS, "delete");
      const response = await relay(`/repos/openclaw/octopool${suffix}`);
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "route_denied" } },
      });
      expect(upstream).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
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

function terminalLogUpstream(status: "completed" | "in_progress", bytes?: Uint8Array) {
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
      expect(request.headers.has("authorization")).toBe(false);
      return new Response(bytes === undefined ? "build log\n" : new Uint8Array(bytes), {
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

function downloadCalls(upstream: ReturnType<typeof vi.fn<typeof fetch>>): number {
  return upstream.mock.calls.filter(
    ([input, init]) =>
      new URL(new Request(input, init).url).hostname ===
      "results-receiver.actions.githubusercontent.com",
  ).length;
}

async function seedLegacyLog(
  key: string,
  fixture: {
    age: string;
    encoding: string;
    body: string | Uint8Array;
    marker?: string | undefined;
  },
) {
  const row = await env.DB.prepare("SELECT datetime('now', ?) AS created_at")
    .bind(fixture.age)
    .first<{ created_at: string }>();
  await env.ACTIONS_LOGS.put(
    key,
    typeof fixture.body === "string" ? fixture.body : new Uint8Array(fixture.body),
    {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: {
        "created-at": row!.created_at,
        "body-encoding": fixture.encoding,
        ...(fixture.marker === undefined ? {} : { "body-codec": fixture.marker }),
      },
    },
  );
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
