import { writeOwnedGitHubCache as writeGitHubCache } from "./cache-publication-fixture";
import { env } from "cloudflare:workers";
import { withGitHubEgress } from "../../src/github-egress";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubCacheKey, readGitHubCache } from "../../src/cache";
import { CACHE_PUBLICATION_EPOCH } from "../../src/cache-publication";
import { queries } from "../../src/generated/sql";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { terminalLogCacheKey, terminalLogCacheProof } from "../../src/terminal-log-cache";
import type { RelayRequest } from "../../src/types";
import { bearer, jsonResponse, rateHeaders, relay, seedPool, runWithContext } from "./harness";
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

  it("shares logs after a run_jobs-only collector read without any job metadata API call", async () => {
    const jobsPath = "/repos/openclaw/octopool/actions/runs/99/jobs";
    const pagePath = "/openclaw/octopool/runs/42";
    const base = terminalLogUpstream("completed");
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === jobsPath)
        return jsonResponse({ total_count: 1, jobs: [{ id: 42, status: "completed" }] });
      if (url.pathname === LOG_PATH.replace(/\/logs$/, ""))
        throw new Error("The collector never fetches job_view; proof must not spend API quota");
      if (url.hostname === "github.com" && url.pathname === pagePath) {
        expect(bearer(request)).toBeUndefined();
        return new Response(`<section aria-label="Check run summary" class="js-selected-check-run">
          <span data-url="/openclaw/octopool/runs/42/header">failed
            <relative-time datetime="2026-09-21T05:16:35Z">Sep 21, 2026</relative-time>
          </span><check-steps data-job-status="completed"></check-steps>
        </section>`);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", upstream);
    expect((await relay(jobsPath)).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM github_cache_entries WHERE route_kind = 'job_view'",
      ).first("n"),
    ).toBe(0);
    upstream.mockClear();
    const log = vi.spyOn(console, "log");
    for (const cache of ["miss", "hit"]) {
      expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
        body: "build log\n",
        relay: { cache },
      });
    }
    expect(jobMetadataCalls(upstream)).toBe(0);
    expect(logBackendCalls(upstream)).toBe(1);
    expect(downloadCalls(upstream)).toBe(1);
    expect(
      upstream.mock.calls.filter(
        ([input, init]) => new URL(new Request(input, init).url).pathname === pagePath,
      ),
    ).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "web_page" }));
  });

  it("uses the exact pool/path index for completion evidence", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${queries.readCompletedJobCacheProof}`)
      .bind("maintainers", LOG_PATH.replace(/\/logs$/, ""), CACHE_PUBLICATION_EPOCH, "42")
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join("\n")).toContain(
      "USING INDEX idx_github_cache_job_proof (pool_id=? AND path=?)",
    );
  });

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

  it.each(["fresh", "stale", "expired"])(
    "uses %s completed job evidence before anonymous metadata and serves the second log from R2",
    async (age) => {
      const key = await seedJobEvidence();
      if (age !== "fresh") {
        await env.DB.prepare(
          `UPDATE github_cache_entries SET created_at = datetime('now', '-30 days'),
           expires_at = datetime('now', '-29 days'),
           stale_expires_at = datetime('now', ?) WHERE cache_key = ?`,
        )
          .bind(age === "stale" ? "+1 day" : "-28 days", key)
          .run();
      }
      const upstream = terminalLogUpstream("in_progress");
      vi.stubGlobal("fetch", upstream);
      const log = vi.spyOn(console, "log");
      for (const cache of ["miss", "hit"]) {
        expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
          body: "build log\n",
          relay: { cache, cacheable: true },
        });
      }
      expect(jobMetadataCalls(upstream)).toBe(0);
      expect(logBackendCalls(upstream)).toBe(1);
      expect(downloadCalls(upstream)).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cached_job_view" }));
      expect(
        await env.DB.prepare("SELECT cache_status FROM audit_events ORDER BY rowid").all(),
      ).toMatchObject({
        results: [{ cache_status: "miss" }, { cache_status: "hit" }],
      });
    },
  );

  it("finds metadata obtained by the relay through a pooled identity and a different API version", async () => {
    const metadataPath = LOG_PATH.replace(/\/logs$/, "");
    const base = terminalLogUpstream("completed");
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === metadataPath) {
        return bearer(request) === "test-primary-token"
          ? jsonResponse({ id: 42, status: "completed" })
          : jsonResponse({ message: "API rate limit exceeded" }, 403);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", upstream);
    expect(
      await (
        await relay(metadataPath, undefined, {
          headers: { "x-github-api-version": "2022-11-28" },
        })
      ).json<RelayEnvelope>(),
    ).toMatchObject({ body: { id: 42, status: "completed" } });
    expect(
      await env.DB.prepare("SELECT identity_id FROM github_cache_entries WHERE path = ?")
        .bind(metadataPath)
        .first(),
    ).toEqual({ identity_id: "primary" });
    upstream.mockClear();
    for (const cache of ["miss", "hit"]) {
      expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
        relay: { cache },
      });
    }
    expect(jobMetadataCalls(upstream)).toBe(0);
    expect(logBackendCalls(upstream)).toBe(1);
    expect(
      upstream.mock.calls.filter(
        ([input, init]) => new URL(new Request(input, init).url).pathname === metadataPath,
      ),
    ).toHaveLength(0);
  });

  it.each([
    { name: "active job", body: { id: 42, status: "in_progress" } },
    { name: "different job body", body: { id: 43, status: "completed" } },
    { name: "missing job ID", body: { status: "completed" } },
    { name: "different job path", path: "/repos/openclaw/octopool/actions/jobs/43" },
    { name: "different repo", path: "/repos/openclaw/other/actions/jobs/42" },
    { name: "different owner", path: "/repos/other/octopool/actions/jobs/42" },
    { name: "completed run", path: "/repos/openclaw/octopool/actions/runs/42" },
    { name: "different pool", pool: "other" },
    { name: "failed response", status: 503 },
    { name: "non-JSON encoding", encoding: "text" },
    { name: "malformed JSON", malformed: true },
    { name: "retired publication epoch", epoch: "retired" },
  ])("rejects cached $name evidence and bypasses when anonymous proof fails", async (fixture) => {
    const key = await seedJobEvidence(fixture);
    if (fixture.status !== undefined)
      await env.DB.prepare("UPDATE github_cache_entries SET status = ? WHERE cache_key = ?")
        .bind(fixture.status, key)
        .run();
    if (fixture.encoding !== undefined)
      await env.DB.prepare("UPDATE github_cache_entries SET body_encoding = ? WHERE cache_key = ?")
        .bind(fixture.encoding, key)
        .run();
    if (fixture.malformed)
      await env.DB.prepare("UPDATE github_cache_entries SET body_json = '{' WHERE cache_key = ?")
        .bind(key)
        .run();
    if (fixture.epoch !== undefined)
      await env.DB.prepare(
        "UPDATE github_cache_entries SET publication_epoch = ? WHERE cache_key = ?",
      )
        .bind(fixture.epoch, key)
        .run();
    const base = terminalLogUpstream("completed");
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === LOG_PATH.replace(/\/logs$/, "")) {
        expect(bearer(request)).toBeUndefined();
        return jsonResponse({ message: "API rate limit exceeded" }, 403);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", upstream);
    const get = vi.spyOn(env.ACTIONS_LOGS, "get");
    const put = vi.spyOn(env.ACTIONS_LOGS, "put");
    const log = vi.spyOn(console, "log");
    expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
      body: "build log\n",
      relay: { cache: "bypass" },
    });
    expect(jobMetadataCalls(upstream)).toBe(1);
    expect(logBackendCalls(upstream)).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unproven" }));
  });

  it("uses anonymous completion when cached metadata is still in progress", async () => {
    await seedJobEvidence({ body: { id: 42, status: "in_progress" } });
    const upstream = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", upstream);
    expect(await (await relay(LOG_PATH)).json<RelayEnvelope>()).toMatchObject({
      relay: { cache: "miss" },
    });
    expect(jobMetadataCalls(upstream)).toBe(1);
    expect(logBackendCalls(upstream)).toBe(1);
  });

  it("does not use expired completion evidence as fresh public-repository proof", async () => {
    const key = await seedJobEvidence();
    await env.DB.prepare(
      "UPDATE github_cache_entries SET expires_at = '2000-01-01', stale_expires_at = '2000-01-01' WHERE cache_key = ?",
    )
      .bind(key)
      .run();
    vi.stubGlobal("fetch", terminalLogUpstream("completed"));
    await relay(LOG_PATH);
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON("public-repo-publication-v1", "openclaw/octopool");
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({ private: true }));
    vi.stubGlobal("fetch", upstream);
    const response = await relay(LOG_PATH);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "repo_not_public" } },
    });
    expect(logBackendCalls(upstream)).toBe(0);
    expect(jobMetadataCalls(upstream)).toBe(0);
  });

  it.each([undefined, "max-age=60"])(
    "reuses a fresh completed log within %s",
    async (cacheControl) => {
      const upstream = terminalLogUpstream("completed");
      vi.stubGlobal("fetch", upstream);

      const first = await relay(LOG_PATH);
      expect(await first.json<RelayEnvelope>()).toMatchObject({
        status: 200,
        body: "build log\n",
        body_encoding: "text",
        relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
      });
      const second = await relay(
        LOG_PATH,
        undefined,
        cacheControl === undefined ? {} : { headers: { "cache-control": cacheControl } },
      );
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
    },
  );

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

  it.each([
    { age: "-2 hours", cacheControl: undefined },
    { age: "-2 hours", cacheControl: "max-age=86400" },
    { age: "+0 seconds", cacheControl: "max-age=0" },
    { age: "-2 minutes", cacheControl: "max-age=60" },
  ])("honors log deletion for $age cache with $cacheControl", async ({ age, cacheControl }) => {
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
    await ageTerminalLog(key, age);

    const response = await relay(
      LOG_PATH,
      undefined,
      cacheControl === undefined ? {} : { headers: { "cache-control": cacheControl } },
    );
    expect(await response.json<RelayEnvelope>()).toMatchObject({
      status: 404,
      body: { message: "Not Found" },
      relay: { cache: "miss", cacheable: true, route_kind: "job_logs" },
    });
    expect(await env.ACTIONS_LOGS.get(key)).toBeNull();
    expect(logBackendCalls(upstream)).toBe(2);
  });

  it("does not immediately redownload a log after a secondary-limited existence probe", async () => {
    const base = terminalLogUpstream("completed");
    vi.stubGlobal("fetch", base);
    await relay(LOG_PATH);
    const key = terminalLogCacheKey({ pool: "maintainers", method: "GET", path: LOG_PATH });
    await ageTerminalLog(key, "-2 hours");
    let limitedRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (bearer(input, init) === "test-primary-token") {
          limitedRequests++;
          return jsonResponse(
            { message: "You have exceeded a secondary rate limit." },
            403,
            rateHeaders({ remaining: 4_998 }),
          );
        }
        return base(input, init);
      }),
    );
    expect((await relay(LOG_PATH)).status).toBe(424);
    expect(limitedRequests).toBe(1);
    expect((await poolCoordinatorStub(env, "maintainers").snapshot()).cooldowns).toEqual([
      expect.objectContaining({ identity_id: "primary", route_key: "*", status: 403 }),
    ]);
  });

  it("refreshes the one-hour no-contact window after an existence probe", async () => {
    const base = terminalLogUpstream("completed");
    let released = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const response = await base(input, init);
      if (response.status !== 302) return response;
      return new Response(
        new ReadableStream({
          cancel() {
            released++;
          },
        }),
        {
          status: response.status,
          headers: response.headers,
        },
      );
    });
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
    expect(released).toBe(2);
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

async function seedJobEvidence(options: { pool?: string; path?: string; body?: unknown } = {}) {
  const request: RelayRequest = {
    pool: options.pool ?? "maintainers",
    method: "GET",
    path: options.path ?? LOG_PATH.replace(/\/logs$/, ""),
  };
  if (request.pool !== "maintainers") {
    await env.DB.prepare("INSERT INTO pools (id, name, policy_json) VALUES (?, ?, '{}')")
      .bind(request.pool, request.pool)
      .run();
  }
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  const key = await githubCacheKey(request.pool, request, route);
  await writeGitHubCache(env, key, request, route, {
    status: 200,
    headers: {},
    body: options.body ?? { id: 42, status: "completed" },
    body_encoding: "json",
  });
  return key;
}
