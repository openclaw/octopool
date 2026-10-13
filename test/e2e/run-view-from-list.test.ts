import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it, vi } from "vitest";
import { GITHUB_EDGE_CACHE_NAMESPACE, writeGitHubCache } from "../../src/cache";
import { bodyPublicationResource } from "../../src/cache-publication";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { PUBLIC_PROOF_EDGE_NAMESPACE } from "../../src/public-repos";
import { queries } from "../../src/generated/sql";
import { exactWorkflowRun } from "../fixtures/exact-workflow-run";
import { restoreD1Baseline } from "./d1-baseline";
import { CALLER_TOKEN, POOL, bearer, callWorker, jsonResponse, relay, seedPool } from "./harness";

const repo = "/repos/openclaw/run-view-fixture";
const list = `${repo}/actions/runs`;
const path = `${list}/42`;
const run = exactWorkflowRun();

async function setup(identity = false, runs: unknown[] = [run]) {
  await seedPool();
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === repo) return jsonResponse({ private: false });
    if (url.pathname.endsWith("/runs")) {
      if (identity && bearer(req) !== "test-primary-token") return jsonResponse({}, 503);
      return jsonResponse({ total_count: runs.length, workflow_runs: runs }, 200, {
        etag: '"list"',
        "x-ratelimit-resource": "core",
        link: "next",
      });
    }
    return jsonResponse({ ...run, display_title: "New view observation" });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

async function memberships() {
  return (await env.DB.prepare("SELECT * FROM github_run_list_items ORDER BY run_id").all())
    .results;
}

async function lastAudit() {
  return env.DB.prepare(
    "SELECT cache_status, fallback_reason, cache_miss_reason, identity_id FROM audit_events ORDER BY rowid DESC LIMIT 1",
  ).first();
}

describe("exact run views from indexed fresh REST lists", () => {
  it.each(
    [false, true].flatMap((identity) =>
      [list, `${repo}/actions/workflows/ci.yml/runs`].map((source) => ({ identity, source })),
    ),
  )(
    "reuses a complete $source item, identity=$identity, without publishing a view alias",
    async ({ identity, source }) => {
      const upstream = await setup(identity);
      const options = {
        query: { branch: "main", status: "in_progress", event: "push", head_sha: run.head_sha },
      };
      expect(await (await relay(source, undefined, options)).json()).toMatchObject({
        relay: { cache: "miss" },
      });
      expect(await memberships()).toHaveLength(1);
      const entries = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").all<{
        cache_key: string;
      }>();
      for (const entry of entries.results)
        await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, entry.cache_key);
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime('now', '-30 seconds')",
      ).run();
      const before = (await env.DB.prepare(
        "SELECT created_at, expires_at FROM github_cache_entries",
      ).first())!;
      upstream.mockClear();
      const response = await (
        await relay(path)
      ).json<{
        body: unknown;
        headers: Record<string, string>;
        relay: { cache: string; cache_expires_at: string; cache_created_at?: string };
      }>();
      expect(response.body).toEqual(run);
      expect(response.relay.cache).toBe("hit");
      expect(response.relay.cache_created_at).toBe(new Date(`${before.created_at}Z`).toISOString());
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers.link).toBeUndefined();
      expect(upstream).not.toHaveBeenCalled();
      expect(await lastAudit()).toMatchObject({
        cache_status: "hit",
        fallback_reason: "run_list_superset",
        cache_miss_reason: null,
        identity_id: identity ? "primary" : null,
      });
      expect(
        (await env.DB.prepare("SELECT created_at, expires_at FROM github_cache_entries").all())
          .results,
      ).toEqual([before]);
    },
  );

  it("tries the list only after an exact view expires past SWR", async () => {
    const upstream = await setup();
    await relay(path);
    await relay(list);
    upstream.mockClear();
    expect(await (await relay(path)).json()).toMatchObject({
      body: { display_title: "New view observation" },
      relay: { cache: "hit" },
    });
    expect(await lastAudit()).toMatchObject({ fallback_reason: null });
    const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries WHERE path = ?")
      .bind(path)
      .first<{ cache_key: string }>();
    await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, row!.cache_key);
    await env.DB.prepare(
      "UPDATE github_cache_entries SET expires_at = datetime('now', '-61 seconds') WHERE path = ?",
    )
      .bind(path)
      .run();
    expect(await (await relay(path)).json()).toMatchObject({ body: run, relay: { cache: "hit" } });
    expect(await lastAudit()).toMatchObject({ fallback_reason: "run_list_superset" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "expired",
    "age",
    "live",
    "epoch",
    "revoked",
    "scope",
    "version",
    "media",
    "shape",
    "attempt",
    "query",
    "incomplete",
    "wrong-url",
  ])("retains the normal path for %s", async (constraint) => {
    const identity = constraint === "revoked" || constraint === "scope";
    const upstream = await setup(identity);
    await relay(list);
    if (constraint === "expired")
      await env.DB.prepare(
        "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second')",
      ).run();
    if (constraint === "age")
      await env.DB.prepare(
        "UPDATE github_cache_entries SET created_at = datetime('now', '-30 seconds')",
      ).run();
    if (constraint === "epoch")
      await env.DB.prepare("UPDATE github_cache_entries SET publication_epoch = 'old'").run();
    if (constraint === "revoked")
      await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
    if (constraint === "scope") await env.DB.prepare("DELETE FROM identity_scopes").run();
    if (constraint === "incomplete" || constraint === "wrong-url") {
      const item: Record<string, unknown> = { ...run };
      if (constraint === "incomplete") delete item.referenced_workflows;
      else item.url = run.url.replace("run-view-fixture", "other");
      await env.DB.prepare("UPDATE github_cache_entries SET body_json = ?")
        .bind(JSON.stringify({ workflow_runs: [item] }))
        .run();
    }
    upstream.mockClear();
    const response = await relay(
      constraint === "attempt" ? `${path}/attempts/2` : path,
      undefined,
      {
        ...(constraint === "query" ? { query: { exclude_pull_requests: "true" } } : {}),
        headers: {
          ...(constraint === "live" ? { "cache-control": "max-age=0" } : {}),
          ...(constraint === "age" ? { "cache-control": "max-age=10" } : {}),
          ...(constraint === "version" ? { "x-github-api-version": "2099-01-01" } : {}),
          ...(constraint === "media" ? { accept: "application/vnd.github.raw" } : {}),
          ...(constraint === "shape" ? { "x-octopool-public-shape": "actions-summary-v1" } : {}),
        },
      },
    );
    expect(await response.json()).toMatchObject({ relay: { cache: "miss" } });
    expect(upstream).toHaveBeenCalled();
    expect(await lastAudit()).toMatchObject({ fallback_reason: null });
  });

  it("honors a positive maximum age that covers the fresh list", async () => {
    const upstream = await setup();
    await relay(list);
    upstream.mockClear();
    expect(
      await (await relay(path, undefined, { headers: { "cache-control": "max-age=10" } })).json(),
    ).toMatchObject({ body: run, relay: { cache: "hit" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["true", "false"])(
    "preserves list exclude_pull_requests=%s semantics",
    async (exclude) => {
      const upstream = await setup();
      await relay(list, undefined, { query: { exclude_pull_requests: exclude } });
      upstream.mockClear();
      expect(await (await relay(path)).json()).toMatchObject({
        relay: { cache: exclude === "false" ? "hit" : "miss" },
      });
      expect(upstream).toHaveBeenCalledTimes(exclude === "false" ? 0 : 1);
    },
  );

  it("applies migration 0024 without backfilling bodies and indexes their next publication", async () => {
    const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    await restoreD1Baseline(env.DB, []);
    await applyD1Migrations(
      env.DB,
      migrations.filter(({ name }) => name !== "0024_run_list_items.sql"),
    );
    await setup();
    await relay(list);
    const before = (await env.DB.prepare("SELECT * FROM github_cache_entries").all()).results;
    await applyD1Migrations(env.DB, migrations);
    expect((await env.DB.prepare("SELECT * FROM github_cache_entries").all()).results).toEqual(
      before,
    );
    expect(await memberships()).toHaveLength(0);
    await relay(list, undefined, { headers: { "cache-control": "max-age=0" } });
    expect(await memberships()).toHaveLength(1);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("does not index public summary projections or reuse a list for conditional views", async () => {
    await setup();
    await relay(list, undefined, {
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
      query: { limit: "1" },
    });
    expect(await memberships()).toHaveLength(0);
    await relay(list);
    expect(await memberships()).toHaveLength(1);
    expect(
      await (await relay(path, undefined, { headers: { "if-none-match": '"view"' } })).json(),
    ).toMatchObject({ relay: { cache: "bypass" } });
  });

  it("rejects membership updates from expired publication owners", async () => {
    await setup();
    await relay(list);
    const before = await memberships();
    const row = await env.DB.prepare("SELECT cache_key FROM github_cache_entries LIMIT 1").first<{
      cache_key: string;
    }>();
    const coordinator = poolCoordinatorStub(env, POOL);
    const owner = await coordinator.tryAcquirePublication(bodyPublicationResource(row!.cache_key));
    expect(owner).toBeDefined();
    await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?")
      .bind(owner!.id)
      .run();
    const request = { pool: POOL, method: "GET" as const, path: list };
    const outcome = await writeGitHubCache(
      env,
      row!.cache_key,
      request,
      classifyRoute(request, defaultPolicy("openclaw")),
      { status: 200, headers: {}, body: { workflow_runs: [exactWorkflowRun(99)] } },
      owner!,
    );
    expect(outcome).toBe("rejected");
    expect(await memberships()).toEqual(before);
  });

  it("preserves candidate filters, newest-first order, and the eight-page limit", async () => {
    await setup();
    await env.DB.prepare(
      "INSERT INTO pools (id, name, policy_json) VALUES ('other', 'other', '{}')",
    ).run();
    const candidate = (
      key: string,
      values: {
        pool?: string;
        path?: string;
        runId?: number;
        headers?: string;
        epoch?: string | null;
        created?: string;
        expires?: string;
        kind?: string;
      } = {},
    ) =>
      env.DB.prepare(
        `INSERT INTO github_cache_entries
          (cache_key, pool_id, method, path, query_json, headers_json, route_key, route_kind,
           status, response_headers_json, body_json, body_encoding, created_at, expires_at,
           publication_epoch)
         VALUES (?, ?, 'GET', ?, '{}', ?, 'run_list', ?, 200, '{}', ?, 'json', ?, ?, ?)`,
      ).bind(
        key,
        values.pool ?? POOL,
        values.path ?? list,
        values.headers ?? "{}",
        values.kind ?? "run_list",
        JSON.stringify({ source: key, workflow_runs: [{ id: values.runId ?? 42 }] }),
        values.created ?? "2001-01-01 00:00:59",
        values.expires ?? "2999-01-01 00:00:00",
        values.epoch === undefined ? "publication-v1" : values.epoch,
      );
    await env.DB.batch([
      ...Array.from({ length: 10 }, (_, index) =>
        candidate(`good-${index}`, {
          created: `2001-01-01 00:00:0${Math.floor(index / 2)}`,
          kind: index % 2 === 0 ? "run_list" : "workflow_run_list",
        }),
      ),
      candidate("expired", { expires: "2000-01-01 00:00:00" }),
      candidate("old-epoch", { epoch: "old" }),
      candidate("null-epoch", { epoch: null }),
      candidate("headers", { headers: '{"accept":"application/vnd.github.raw"}' }),
      candidate("pool", { pool: "other" }),
      candidate("repo", { path: "/repos/openclaw/other/actions/runs" }),
      candidate("run", { runId: 43 }),
      ...["method", "kind", "status", "encoding"].map((key) => candidate(key)),
    ]);
    await env.DB.batch([
      env.DB.prepare("UPDATE github_cache_entries SET method = 'HEAD' WHERE cache_key = 'method'"),
      env.DB.prepare(
        "UPDATE github_cache_entries SET route_kind = 'run_view' WHERE cache_key = 'kind'",
      ),
      env.DB.prepare("UPDATE github_cache_entries SET status = 404 WHERE cache_key = 'status'"),
      env.DB.prepare(
        "UPDATE github_cache_entries SET body_encoding = 'text' WHERE cache_key = 'encoding'",
      ),
    ]);
    const previousJoin = queries.readRunListCacheCandidates.replace(
      "\nCROSS JOIN github_cache_entries",
      "\nJOIN github_cache_entries",
    );
    for (const runId of [42, 404]) {
      const read = async (sql: string) =>
        (await env.DB.prepare(sql).bind(POOL, repo, runId, "publication-v1", "{}").all()).results;
      const rows = await read(queries.readRunListCacheCandidates);
      expect(rows).toEqual(await read(previousJoin));
      expect(rows.map((row) => JSON.parse(String(row.body_json)).source)).toEqual(
        runId === 42
          ? ["good-8", "good-9", "good-6", "good-7", "good-4", "good-5", "good-2", "good-3"]
          : [],
      );
    }
  });

  it.each([[], [exactWorkflowRun(43)], [run, run]].map((runs) => ({ runs })))(
    "does not reuse missing or duplicate ids: %j",
    async ({ runs }) => {
      const upstream = await setup(false, runs);
      await relay(list);
      upstream.mockClear();
      expect(await (await relay(path)).json()).toMatchObject({ relay: { cache: "miss" } });
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it.each(["pool", "repo"])("does not cross the %s boundary", async (boundary) => {
    const upstream = await setup();
    if (boundary === "pool") {
      await env.DB.prepare(
        "INSERT INTO pools (id, name, policy_json) SELECT 'other', 'other', policy_json FROM pools WHERE id = ?",
      )
        .bind(POOL)
        .run();
      await env.DB.prepare(
        "INSERT INTO caller_pools (caller_id, pool_id) VALUES ('caller', 'other')",
      ).run();
      await callWorker("/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ pool: "other", method: "GET", path: list }),
      });
    } else await relay(list.replace("run-view-fixture", "other"));
    upstream.mockClear();
    expect(await (await relay(path)).json()).toMatchObject({ relay: { cache: "miss" } });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["private", "proof-failure"])("refuses list reuse after %s", async (failure) => {
    const upstream = await setup();
    await relay(list);
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/run-view-fixture");
    upstream.mockImplementation(async () =>
      jsonResponse({ private: true }, failure === "private" ? 200 : 503),
    );
    const response = await relay(path);
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: {
        code: "fallback_local",
        details: { reason: failure === "private" ? "repo_not_public" : "repo_public_check_failed" },
      },
    });
    expect(await lastAudit()).not.toMatchObject({ fallback_reason: "run_list_superset" });
  });

  it("rechecks list expiry after a public-proof lookup", async () => {
    const upstream = await setup();
    await relay(list);
    await env.DB.prepare("DELETE FROM github_public_repo_proofs").run();
    await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/run-view-fixture");
    await env.DB.prepare(
      "UPDATE github_cache_entries SET expires_at = datetime('now', '+2 seconds')",
    ).run();
    upstream.mockImplementation(async (input, init) => {
      if (new URL(new Request(input, init).url).pathname === repo) {
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        return jsonResponse({ private: false });
      }
      return jsonResponse({ ...run, display_title: "New view observation" });
    });
    expect(await (await relay(path)).json()).toMatchObject({ relay: { cache: "miss" } });
  });

  it("bounds membership publication, replaces mappings, cascades deletes, and uses the lookup index", async () => {
    const upstream = await setup(
      false,
      Array.from({ length: 100 }, (_, id) => exactWorkflowRun(id + 1)),
    );
    await relay(list);
    expect(await memberships()).toHaveLength(100);
    await env.DB.prepare(
      `WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 1000)
       INSERT INTO github_cache_entries
         (cache_key, pool_id, method, path, query_json, headers_json, route_key, route_kind,
          status, response_headers_json, body_json, body_encoding, created_at, expires_at)
       SELECT 'unrelated-' || value, ?, 'GET', '/repos/openclaw/other', '{}', '{}', 'repo_view',
              'repo_view', 200, '{}', '{}', 'json', CURRENT_TIMESTAMP, '2999-01-01 00:00:00'
       FROM n`,
    )
      .bind(POOL)
      .run();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${queries.readRunListCacheCandidates}`)
      .bind(POOL, repo, 42, "publication-v1", "{}")
      .all<{ detail: string }>();
    const lookups = plan.results.filter(({ detail }) => /^(SEARCH|SCAN) [ic]\b/.test(detail));
    expect(lookups.map(({ detail }) => detail)).toEqual([
      expect.stringMatching(
        /^SEARCH i .*idx_github_run_list_item_lookup.*pool_id=\?.*repo_path=\?.*run_id=\?/,
      ),
      expect.stringMatching(/^SEARCH c .*cache_key=\?/),
    ]);
    upstream.mockImplementation(async () =>
      jsonResponse({
        workflow_runs: Array.from({ length: 101 }, (_, id) => exactWorkflowRun(id + 1)),
      }),
    );
    await relay(list, undefined, { headers: { "cache-control": "max-age=0" } });
    expect(await memberships()).toHaveLength(0);
    upstream.mockImplementation(async () =>
      jsonResponse({ workflow_runs: [exactWorkflowRun(99)] }),
    );
    await relay(list, undefined, { headers: { "cache-control": "max-age=0" } });
    expect(await memberships()).toEqual([expect.objectContaining({ run_id: 99 })]);
    await env.DB.prepare("DELETE FROM github_cache_entries").run();
    expect(await memberships()).toHaveLength(0);
  });
});
