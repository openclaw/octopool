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
      migrations.filter(({ name }) => name < "0024_run_list_items.sql"),
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

  it("returns at most eight candidate pages for a run", async () => {
    await setup();
    for (let pageSize = 1; pageSize <= 9; pageSize++)
      await relay(list, undefined, { query: { per_page: String(pageSize) } });
    expect(await memberships()).toHaveLength(9);
    const rows = await env.DB.prepare(queries.readRunListCacheCandidates)
      .bind(POOL, repo, 42, "publication-v1", "{}")
      .all();
    expect(rows.results).toHaveLength(8);
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
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${queries.readRunListCacheCandidates}`)
      .bind(POOL, repo, 42, "publication-v1", "{}")
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("idx_github_run_list_item_lookup"))).toBe(
      true,
    );
    expect(plan.results.some((row) => /SCAN c\b/.test(row.detail))).toBe(false);
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
