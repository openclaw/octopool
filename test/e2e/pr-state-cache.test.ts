import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { jsonResponse, relay, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import {
  matchingPRMetadata,
  oversizedPRMetadata,
  oversizedPRStream,
  PR_METADATA_CAP,
  prMetadataStream,
} from "../fixtures/pr-state-metadata";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FORGED_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILES_PATH = "/repos/openclaw/octopool/pulls/42/files";

type RelayEnvelope = {
  body: unknown;
  relay: { backend?: string; cache: string; route_kind: string };
};

describe("Worker end-to-end PR-state cache", () => {
  describe.each(["proof miss", "forced live"])("bounded metadata: %s", (mode) => {
    it.each(oversizedPRMetadata)(
      "rejects $name and uses the unhinted files cache",
      async (definition) => {
        await seedPool();
        const oldBody = mode === "forced live" ? await primeStaleHintedBody() : null;
        const before = await proofRows();
        const fixture = oversizedPRStream(definition);
        const upstream = filesUpstream(() => fixture.response);
        vi.stubGlobal("fetch", upstream);

        const response = await cappedRelay();
        const wire = await response.json<RelayEnvelope>();
        const after = await proofRows();
        const rowsAfterHint = await fileCacheRows();
        const following = await requestWithEnv(
          { MAX_RESPONSE_BYTES: String(PR_METADATA_CAP) },
          FILES_PATH,
          {},
        );
        const unhinted = await following.json<RelayEnvelope>();
        const rowsAfterUnhinted = await fileCacheRows();
        const calls = outgoingCalls(upstream);
        console.info(
          "PR metadata cap observations",
          JSON.stringify({
            mode,
            case: definition.name,
            stream: fixture.observations,
            locked: fixture.stream.locked,
            responseStatus: response.status,
            wire,
            before,
            after,
            oldBody,
            rowsAfterHint,
            rowsAfterUnhinted,
            unhinted,
            calls,
          }),
        );

        expect.soft(response.status).toBe(200);
        expect.soft(wire).toMatchObject({
          body: [{ filename: "safe-unhinted.ts" }],
          relay: { cache: "miss", backend: "web" },
        });
        expect.soft(fixture.observations).toEqual({
          pulls: definition.pulled.length,
          chunkBytes: definition.pulled,
          cancellations: 1,
        });
        expect.soft(fixture.stream.locked).toBe(false);
        expect.soft(after).toEqual(before);
        expect.soft(unhinted).toMatchObject({
          body: [{ filename: "safe-unhinted.ts" }],
          relay: { cache: "hit", backend: "web" },
        });
        expect.soft(calls).toEqual([
          { path: "/repos/openclaw/octopool/pulls/42", authorization: null },
          { path: FILES_PATH, authorization: null },
        ]);
        expect.soft(rowsAfterHint).toHaveLength(mode === "forced live" ? 2 : 1);
        expect.soft(rowsAfterUnhinted).toEqual(rowsAfterHint);
        if (oldBody !== null) expect.soft(rowsAfterHint).toContainEqual(oldBody);
      },
    );

    it.each(["malformed JSON", "read failure", "non-2xx", "network", "mismatch"])(
      "leaves D1 proofs unchanged after %s",
      async (failure) => {
        await seedPool();
        if (mode === "forced live") await primeStaleHintedBody();
        const before = await proofRows();
        const fixture = prMetadataStream([matchingPRMetadata().slice(0, 128)], { failAtPull: 2 });
        const upstream = filesUpstream(() => {
          if (failure === "network") throw new Error("metadata unavailable");
          if (failure === "read failure") return fixture.response;
          if (failure === "non-2xx") return jsonResponse({ message: "unavailable" }, 503);
          if (failure === "mismatch") return jsonResponse({ head: { sha: FORGED_HEAD } });
          return new Response('{"head":');
        });
        vi.stubGlobal("fetch", upstream);
        const response = await cappedRelay();
        expect(response.status).toBe(200);
        expect(await response.json<RelayEnvelope>()).toMatchObject({
          body: [{ filename: "safe-unhinted.ts" }],
          relay: { cache: "miss" },
        });
        expect(await proofRows()).toEqual(before);
        const following = await requestWithEnv(
          { MAX_RESPONSE_BYTES: String(PR_METADATA_CAP) },
          FILES_PATH,
          {},
        );
        expect(await following.json<RelayEnvelope>()).toMatchObject({
          body: [{ filename: "safe-unhinted.ts" }],
          relay: { cache: "hit" },
        });
        expect(outgoingCalls(upstream)).toEqual([
          { path: "/repos/openclaw/octopool/pulls/42", authorization: null },
          { path: FILES_PATH, authorization: null },
        ]);
        if (failure === "read failure") {
          expect(fixture.observations).toEqual({ pulls: 2, chunkBytes: [128], cancellations: 0 });
        }
      },
    );
  });

  it("accepts exact-cap JSON into real D1 and reuses the proof plus keyed body", async () => {
    await seedPool();
    const bytes = matchingPRMetadata();
    const fixture = prMetadataStream([bytes.slice(0, 128), bytes.slice(128)], {
      contentLength: "1",
    });
    const upstream = filesUpstream(() => fixture.response);
    vi.stubGlobal("fetch", upstream);
    for (const cache of ["miss", "hit"]) {
      const response = await cappedRelay();
      expect(response.status).toBe(200);
      expect(await response.json<RelayEnvelope>()).toMatchObject({
        body: [{ filename: "safe-unhinted.ts" }],
        relay: { cache },
      });
    }
    expect(fixture.observations).toEqual({ pulls: 3, chunkBytes: [128, 128], cancellations: 0 });
    expect(outgoingCalls(upstream)).toEqual([
      { path: "/repos/openclaw/octopool/pulls/42", authorization: null },
      { path: FILES_PATH, authorization: null },
    ]);
    expect(
      await env.DB.prepare(`SELECT owner, repo, number, state_hint,
      unixepoch(expires_at) - unixepoch(checked_at) AS ttl FROM github_pr_state_proofs`).all(),
    ).toMatchObject({
      results: [
        {
          owner: "openclaw",
          repo: "octopool",
          number: 42,
          state_hint: `pr-head:${HEAD}`,
          ttl: 300,
        },
      ],
    });
    expect(await fileCacheRows()).toHaveLength(1);
    console.info(
      "PR exact-cap observations",
      JSON.stringify({
        stream: fixture.observations,
        locked: fixture.stream.locked,
        proofs: await proofRows(),
        calls: outgoingCalls(upstream),
      }),
    );
  });

  it("retains actual files-body overflow mapping after successful metadata verification", async () => {
    await seedPool();
    const metadata = prMetadataStream([matchingPRMetadata()]);
    const files: ReturnType<typeof prMetadataStream>[] = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === "/repos/openclaw/octopool/pulls/42") return metadata.response;
      if (path === "/repos/openclaw/octopool") return jsonResponse({ private: false });
      if (path === FILES_PATH) {
        const attempt = prMetadataStream([
          new TextEncoder().encode(" ".repeat(256)),
          new Uint8Array([32]),
          new Uint8Array([32]),
        ]);
        files.push(attempt);
        return attempt.response;
      }
      return jsonResponse({ message: "unexpected actual-body overflow request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);
    const response = await cappedRelay();
    const wire = await response.json();
    const calls = outgoingCalls(upstream);
    const proofs = await proofRows();
    const cacheRows = await fileCacheRows();
    console.info(
      "PR actual-body overflow observations",
      JSON.stringify({
        wire,
        calls,
        proofs,
        cacheRows,
        metadata: metadata.observations,
        files: files.map(({ observations, stream }) => ({
          ...observations,
          locked: stream.locked,
        })),
      }),
    );
    expect(response.status).toBe(424);
    expect(wire).toMatchObject({
      error: { code: "fallback_local", details: { reason: "github_response_too_large" } },
    });
    expect(metadata.observations).toEqual({ pulls: 2, chunkBytes: [256], cancellations: 0 });
    expect(proofs).toMatchObject([
      { owner: "openclaw", repo: "octopool", number: 42, state_hint: `pr-head:${HEAD}` },
    ]);
    expect(cacheRows).toEqual([]);
    expect(calls).toEqual([
      { path: "/repos/openclaw/octopool/pulls/42", authorization: null },
      { path: FILES_PATH, authorization: null },
      { path: "/repos/openclaw/octopool", authorization: "Bearer test-org-token" },
      { path: FILES_PATH, authorization: "Bearer test-primary-token" },
    ]);
    expect(files).toHaveLength(2);
    for (const attempt of files) {
      expect(attempt.observations).toEqual({ pulls: 2, chunkBytes: [256, 1], cancellations: 1 });
      expect(attempt.stream.locked).toBe(false);
    }
  });

  it("isolates verified state keys and revalidates stale or forged hints", async () => {
    await seedPool();
    const fileBodies = ["head.ts", "closed.ts", "unhinted.ts"];
    let fileRequest = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBeNull();
      if (url.pathname === "/repos/openclaw/octopool/pulls/42") {
        return jsonResponse({ state: "closed", merged_at: null, head: { sha: HEAD } });
      }
      if (url.pathname === FILES_PATH) {
        const filename = fileBodies[fileRequest++];
        return filename === undefined
          ? jsonResponse({ message: "unexpected files request" }, 500)
          : jsonResponse([{ filename }]);
      }
      return jsonResponse({ message: "unexpected PR-state request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const headMiss = await hintedRelay({ pr_head_sha: HEAD });
    expect(await headMiss.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "head.ts" }],
      relay: { backend: "web", cache: "miss", route_kind: "pr_files" },
    });
    const closedMiss = await hintedRelay({ pr_state: "closed" });
    expect(await closedMiss.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "closed.ts" }],
      relay: { backend: "web", cache: "miss", route_kind: "pr_files" },
    });
    expect(upstream).toHaveBeenCalledTimes(4);

    const headHit = await hintedRelay({ pr_head_sha: HEAD });
    expect(await headHit.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "head.ts" }],
      relay: { backend: "web", cache: "hit", route_kind: "pr_files" },
    });
    expect(upstream).toHaveBeenCalledTimes(4);

    await env.DB.prepare(
      "UPDATE github_pr_state_proofs SET expires_at = datetime('now', '-1 second') WHERE state_hint = ?",
    )
      .bind(`pr-head:${HEAD}`)
      .run();
    const revalidatedHead = await hintedRelay({ pr_head_sha: HEAD });
    expect(await revalidatedHead.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "head.ts" }],
      relay: { backend: "web", cache: "hit", route_kind: "pr_files" },
    });
    expect(upstream).toHaveBeenCalledTimes(5);

    const forgedMiss = await hintedRelay({ pr_head_sha: FORGED_HEAD });
    expect(await forgedMiss.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "unhinted.ts" }],
      relay: { backend: "web", cache: "miss", route_kind: "pr_files" },
    });
    const forgedHit = await hintedRelay({ pr_head_sha: FORGED_HEAD });
    expect(await forgedHit.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "unhinted.ts" }],
      relay: { backend: "web", cache: "hit", route_kind: "pr_files" },
    });
    expect(upstream).toHaveBeenCalledTimes(8);
    expect(fileRequest).toBe(3);

    const proofs = await env.DB.prepare(
      "SELECT state_hint FROM github_pr_state_proofs ORDER BY state_hint",
    ).all<{ state_hint: string }>();
    expect(proofs.results).toEqual([
      { state_hint: `pr-head:${HEAD}` },
      { state_hint: "pr-state:closed" },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(DISTINCT cache_key) AS count FROM github_cache_entries WHERE route_kind = 'pr_files'",
      ).first(),
    ).toEqual({ count: 3 });
    const audits = await env.DB.prepare(
      "SELECT cache_status FROM audit_events ORDER BY rowid",
    ).all<{ cache_status: string }>();
    expect(audits.results.map(({ cache_status }) => cache_status)).toEqual([
      "miss",
      "miss",
      "hit",
      "hit",
      "miss",
      "hit",
    ]);
  });

  it("live-revalidates a cached proof when its keyed response is absent", async () => {
    await seedPool();
    await env.DB.prepare(
      `INSERT INTO github_pr_state_proofs
       (owner, repo, number, state_hint, checked_at, expires_at)
       VALUES ('openclaw', 'octopool', 42, ?, CURRENT_TIMESTAMP, datetime('now', '+5 minutes'))`,
    )
      .bind(`pr-head:${FORGED_HEAD}`)
      .run();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBeNull();
      if (url.pathname === "/repos/openclaw/octopool/pulls/42") {
        return jsonResponse({ state: "open", merged_at: null, head: { sha: HEAD } });
      }
      if (url.pathname === FILES_PATH) {
        return jsonResponse([{ filename: "safe-unhinted.ts" }]);
      }
      return jsonResponse({ message: "unexpected PR-state request" }, 500);
    });
    vi.stubGlobal("fetch", upstream);

    const revalidated = await hintedRelay({ pr_head_sha: FORGED_HEAD });
    expect(await revalidated.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "safe-unhinted.ts" }],
      relay: { backend: "web", cache: "miss", route_kind: "pr_files" },
    });
    const unhinted = await relay(FILES_PATH);
    expect(await unhinted.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "safe-unhinted.ts" }],
      relay: { backend: "web", cache: "hit", route_kind: "pr_files" },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'pr_files'",
      ).first(),
    ).toEqual({ count: 1 });
    const audits = await env.DB.prepare(
      "SELECT cache_status FROM audit_events ORDER BY rowid",
    ).all<{ cache_status: string }>();
    expect(audits.results).toEqual([{ cache_status: "miss" }, { cache_status: "hit" }]);
  });

  it("does not serve stale data for a PR-state hint rejected by live revalidation", async () => {
    await seedPool();
    await env.DB.prepare(
      `INSERT INTO github_pr_state_proofs
       (owner, repo, number, state_hint, checked_at, expires_at)
       VALUES ('openclaw', 'octopool', 42, ?, CURRENT_TIMESTAMP, datetime('now', '+5 minutes'))`,
    )
      .bind(`pr-head:${FORGED_HEAD}`)
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("authorization")).toBeNull();
        const url = new URL(request.url);
        if (url.pathname === "/repos/openclaw/octopool/pulls/42") {
          return jsonResponse({ state: "open", merged_at: null, head: { sha: FORGED_HEAD } });
        }
        if (url.pathname === FILES_PATH) {
          return jsonResponse([{ filename: "forged-stale.ts" }]);
        }
        return jsonResponse({ message: "unexpected prime request" }, 500);
      }),
    );
    const primed = await hintedRelay({ pr_head_sha: FORGED_HEAD });
    expect(await primed.json<RelayEnvelope>()).toMatchObject({
      body: [{ filename: "forged-stale.ts" }],
      relay: { backend: "web", cache: "miss", route_kind: "pr_files" },
    });

    const cacheRow = await env.DB.prepare(
      "SELECT cache_key FROM github_cache_entries WHERE route_kind = 'pr_files' LIMIT 1",
    ).first<{ cache_key: string }>();
    expect(cacheRow).not.toBeNull();
    await env.DB.prepare(
      `UPDATE github_cache_entries
       SET expires_at = datetime('now', '-1 second'),
           stale_expires_at = datetime('now', '+1 hour')
       WHERE cache_key = ?`,
    )
      .bind(cacheRow!.cache_key)
      .run();
    await deleteEdgeJSON("github-publication-v1", cacheRow!.cache_key);

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const token = request.headers.get("authorization");
        const url = new URL(request.url);
        if (token === null && url.pathname === "/repos/openclaw/octopool/pulls/42") {
          return jsonResponse({ state: "open", merged_at: null, head: { sha: HEAD } });
        }
        if (token === null && url.pathname === "/repos/openclaw/octopool") {
          return jsonResponse({ private: false });
        }
        if (token === null && url.pathname === FILES_PATH) {
          return jsonResponse({ message: "public unavailable" }, 503);
        }
        return jsonResponse({ message: "rate limited" }, 429, {
          "retry-after": "60",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          "x-ratelimit-resource": "core",
        });
      }),
    );

    const response = await hintedRelay({ pr_head_sha: FORGED_HEAD });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "github_rate_limited" } },
    });
  });
});

function cappedRelay(): Promise<Response> {
  return requestWithEnv({ MAX_RESPONSE_BYTES: String(PR_METADATA_CAP) }, FILES_PATH, {
    route_hint: { pr_head_sha: HEAD },
  });
}

function filesUpstream(
  metadata: () => Response,
  files = () => jsonResponse([{ filename: "safe-unhinted.ts" }]),
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path === "/repos/openclaw/octopool/pulls/42") return metadata();
    if (path === FILES_PATH) return files();
    return jsonResponse({ message: "unexpected PR metadata request" }, 500);
  });
}

function outgoingCalls(upstream: ReturnType<typeof filesUpstream>) {
  return upstream.mock.calls.map(([input, init]) => {
    const request = new Request(input, init);
    return {
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
    };
  });
}

async function proofRows() {
  return (
    await env.DB.prepare(
      "SELECT owner, repo, number, state_hint, checked_at, expires_at FROM github_pr_state_proofs ORDER BY state_hint",
    ).all()
  ).results;
}

async function fileCacheRows() {
  return (
    await env.DB.prepare(
      "SELECT cache_key, body_json, expires_at, stale_expires_at FROM github_cache_entries WHERE route_kind = 'pr_files' ORDER BY cache_key",
    ).all<{ cache_key: string; body_json: string; expires_at: string; stale_expires_at: string }>()
  ).results;
}

async function primeStaleHintedBody() {
  const upstream = filesUpstream(
    () => jsonResponse({ head: { sha: HEAD } }),
    () => jsonResponse([{ filename: "old-hinted.ts" }]),
  );
  vi.stubGlobal("fetch", upstream);
  const response = await cappedRelay();
  expect(response.status).toBe(200);
  expect(await response.json<RelayEnvelope>()).toMatchObject({
    body: [{ filename: "old-hinted.ts" }],
    relay: { cache: "miss" },
  });
  expect(outgoingCalls(upstream)).toEqual([
    { path: "/repos/openclaw/octopool/pulls/42", authorization: null },
    { path: FILES_PATH, authorization: null },
  ]);
  await env.DB.prepare(
    `UPDATE github_pr_state_proofs SET checked_at = datetime('now', '-1 minute'), expires_at = datetime('now', '+4 minutes')`,
  ).run();
  const rows = await fileCacheRows();
  expect(rows).toHaveLength(1);
  await env.DB.prepare(
    `UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second'), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?`,
  )
    .bind(rows[0]!.cache_key)
    .run();
  await deleteEdgeJSON("github-publication-v1", rows[0]!.cache_key);
  return (await fileCacheRows())[0]!;
}

function hintedRelay(route_hint: { pr_head_sha?: string; pr_state?: string }): Promise<Response> {
  return relay(FILES_PATH, undefined, { route_hint });
}
