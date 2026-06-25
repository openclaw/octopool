import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { jsonResponse, relay, seedPool } from "./harness";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FORGED_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILES_PATH = "/repos/openclaw/octopool/pulls/42/files";

type RelayEnvelope = {
  body: unknown;
  relay: { backend?: string; cache: string; route_kind: string };
};

describe("Worker end-to-end PR-state cache", () => {
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
    await deleteEdgeJSON("github-v1", cacheRow!.cache_key);

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

function hintedRelay(route_hint: { pr_head_sha?: string; pr_state?: string }): Promise<Response> {
  return relay(FILES_PATH, undefined, { route_hint });
}
