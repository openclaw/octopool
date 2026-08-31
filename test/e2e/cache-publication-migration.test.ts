import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { githubCacheKey, readGitHubCache, readStaleGitHubCache } from "../../src/cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { restoreD1Baseline } from "./d1-baseline";
import { seedPool, POOL } from "./harness";
import { legacyActionsKey } from "../fixtures/actions-legacy-cache";

// Frozen canonical pre-0020 SQL from PR102. These real bound statements may
// execute after migration; neither gains the new epoch or proof conflict target.
const LEGACY_BODY_WRITE =
  "INSERT INTO github_cache_entries\n  (cache_key, pool_id, method, path, query_json, headers_json, route_key, route_kind,\n   status, response_headers_json, body_json, body_encoding, identity_id, identity_kind,\n   expires_at, stale_expires_at)\nVALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)\nON CONFLICT(cache_key) DO UPDATE SET\n  status = excluded.status,\n  response_headers_json = excluded.response_headers_json,\n  body_json = excluded.body_json,\n  body_encoding = excluded.body_encoding,\n  identity_id = excluded.identity_id,\n  identity_kind = excluded.identity_kind,\n  created_at = CURRENT_TIMESTAMP,\n  expires_at = excluded.expires_at,\n  stale_expires_at = excluded.stale_expires_at";
const LEGACY_PROOF_WRITE =
  "INSERT INTO github_public_repos (owner, repo, is_public, checked_at, expires_at)\nVALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, ?4))\nON CONFLICT(owner, repo) DO UPDATE SET\n  is_public = excluded.is_public,\n  checked_at = excluded.checked_at,\n  expires_at = excluded.expires_at";

it("applies additive 0020 to actual 0019 storage and isolates delayed legacy body/proof statements", async () => {
  const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
  // No requests or owners exist in this migration fixture; ordinary teardown
  // still owns the following test's reset. Never do this within an owner proof.
  await restoreD1Baseline(env.DB, []);
  await applyD1Migrations(
    env.DB,
    migrations.filter(({ name }) => name < "0020_cache_publication.sql"),
  );
  await seedPool();
  const request = {
    pool: POOL,
    method: "GET" as const,
    path: "/repos/openclaw/octopool/issues/42",
  };
  const route = classifyRoute(request, defaultPolicy("openclaw"));
  const oldKey = await legacyActionsKey(request, route);
  const oldBody = env.DB.prepare(LEGACY_BODY_WRITE).bind(
    oldKey,
    POOL,
    "GET",
    request.path,
    "{}",
    "{}",
    route.routeKey,
    route.kind,
    200,
    '{"etag":"legacy"}',
    '"legacy"',
    "json",
    null,
    null,
    "2099-01-01 00:00:00",
    "2099-01-02 00:00:00",
  );
  const oldProof = env.DB.prepare(LEGACY_PROOF_WRITE).bind("openclaw", "octopool", 1, "+1 hour");
  await oldBody.run();
  await oldProof.run();
  const history = await env.DB.prepare("SELECT * FROM github_public_repos").all();
  await applyD1Migrations(env.DB, migrations);
  expect((await env.DB.prepare("SELECT * FROM github_public_repos").all()).results).toEqual(
    history.results,
  );
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM github_public_repo_proofs").first("n"),
  ).toBe(0);
  // Dispatch bound old mutations after the additive migration, including an
  // old 304-style body replacement. New readers still refuse them.
  await oldBody.run();
  await oldProof.run();
  const key = await githubCacheKey(POOL, request, route);
  expect(key).not.toBe(oldKey);
  expect(await readGitHubCache(env, key)).toBeUndefined();
  expect(await readStaleGitHubCache(env, key, route)).toBeUndefined();
  expect(await readGitHubCache(env, oldKey)).toBeUndefined();
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  const schema = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE name = 'cache_publication_owners'",
  ).first<string>("sql");
  expect(schema).toContain("AUTOINCREMENT");
  expect(schema).toContain("owner_fence_safe_integer");
  expect(
    (
      await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'caller_tokens_%' AND type = 'trigger'",
      ).all()
    ).results.length,
  ).toBeGreaterThan(0);
});
