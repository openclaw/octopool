import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth";
import { captureD1Baseline, restoreD1Baseline } from "./d1-baseline";
import { loginClient, mockEnrollmentAccount, type Enrollment } from "./enrollment-support";
import { callWorker, POOL } from "./harness";

const UPGRADE = "0018_active_caller_enrollment.sql";
const LEGACY_PROOF = "2099-01-01T00:00:00.000Z";
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

describe("active caller enrollment migration", () => {
  it("preserves actual 0012 legacy tokens, singleton roles, grants, sessions and audit links", async () => {
    await oldSchema();
    const before = await history();
    await upgrade();
    expect(await history()).toEqual(before);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_schema WHERE name = 'idx_callers_active_github_org'",
    ).first<{ sql: string }>();
    expect(index!.sql).toContain("org_login COLLATE NOCASE");
    expect(index!.sql).toContain("status = 'active' AND github_user_id IS NOT NULL");

    mockEnrollmentAccount(101, "renamed-user");
    const response = await loginClient("legacy");
    expect(response.status).toBe(201);
    const issued = await response.json<Enrollment>();
    expect(issued.caller).toMatchObject({
      id: "singleton",
      github_login: "renamed-user",
      org_login: "OpenClaw",
    });
    expect(
      await env.DB.prepare("SELECT id FROM caller_tokens WHERE caller_id = 'singleton'").first(),
    ).toEqual({ id: "legacy_singleton" });
    expect(
      await env.DB.prepare(
        "SELECT dashboard_role, org_verified_at, org_identity_verified_at FROM callers WHERE id = 'singleton'",
      ).first(),
    ).toEqual({
      dashboard_role: "admin",
      org_verified_at: LEGACY_PROOF,
      org_identity_verified_at: expect.any(String),
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT pool_id FROM caller_pools WHERE caller_id = 'singleton' ORDER BY pool_id",
        ).all()
      ).results,
    ).toEqual([{ pool_id: POOL }, { pool_id: "restricted" }]);
    expect(await health("token-singleton", "restricted")).toBe(401);
    expect(await health(issued.token, "restricted")).toBe(200);
    const me = await browser("session-singleton");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ caller: { id: "singleton", dashboard_role: "admin" } });
    const after = await history();
    expect(after[2]).toEqual(before[2]); // audit token IDs survive rotation
    expect(after[3]!.results.map((row) => [row.session_hash, row.caller_id])).toEqual(
      before[3]!.results.map((row) => [row.session_hash, row.caller_id]),
    );
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it.each([
    ["same org, equal privileges", "OpenClaw", "admin", "restricted"],
    ["case variant, equal privileges", "OPENCLAW", "admin", "restricted"],
    ["same org, conflicting privileges", "OpenClaw", "none", POOL],
    ["case variant, conflicting privileges", "openclaw", "none", POOL],
  ])(
    "refuses ambiguous %s without changing history or migration bookkeeping",
    async (_case, org, role, pool) => {
      await oldSchema();
      await duplicate(org!, role!, pool!);
      const before = await captureD1Baseline(env.DB);
      await expect(upgrade()).rejects.toThrow(/UNIQUE constraint failed/);
      expect(await captureD1Baseline(env.DB)).toEqual(before);
      expect(
        await env.DB.prepare("SELECT name FROM d1_migrations WHERE name = ?").bind(UPGRADE).first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_callers_active_github_org'",
        ).first(),
      ).toBeNull();
      expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    },
  );

  it("permits upgrade only after an explicit synthetic retirement, preserving the retired history", async () => {
    await oldSchema();
    await duplicate("OPENCLAW", "none", POOL);
    await expect(upgrade()).rejects.toThrow(/UNIQUE constraint failed/);
    // Test-owned operator decision, deliberately separate from the migration.
    await env.DB.prepare("UPDATE callers SET status = 'disabled' WHERE id = 'duplicate'").run();
    const retired = await history();
    await upgrade();
    expect(await history()).toEqual(retired);
    mockEnrollmentAccount(101);
    const response = await loginClient("legacy");
    expect(response.status).toBe(201);
    expect((await response.json<Enrollment>()).caller.id).toBe("singleton");
    expect(await health("token-duplicate")).toBe(401);
    expect((await browser("session-duplicate")).status).toBe(401);
    expect(
      await env.DB.prepare(
        "SELECT status, dashboard_role FROM callers WHERE id = 'duplicate'",
      ).first(),
    ).toEqual({ status: "disabled", dashboard_role: "none" });
    expect(
      await env.DB.prepare(
        "SELECT caller_token_id FROM audit_events WHERE request_id = 'audit-duplicate'",
      ).first(),
    ).toEqual({ caller_token_id: "duplicate-token" });
  });

  it("leaves disabled, null-ID and other-org histories unclaimed by fresh enrollments", async () => {
    await oldSchema();
    await upgrade();
    const before = await history();
    for (const id of [202, 303, 404]) {
      mockEnrollmentAccount(id, "same-name");
      const response = await loginClient("legacy");
      expect(response.status).toBe(201);
      const issued = await response.json<Enrollment>();
      expect(issued.caller.id).toMatch(/^caller_/);
      expect(
        await env.DB.prepare("SELECT dashboard_role FROM callers WHERE id = ?")
          .bind(issued.caller.id)
          .first(),
      ).toEqual({ dashboard_role: "none" });
      expect(
        (
          await env.DB.prepare("SELECT pool_id FROM caller_pools WHERE caller_id = ?")
            .bind(issued.caller.id)
            .all()
        ).results,
      ).toEqual([{ pool_id: POOL }]);
      expect(await health(issued.token)).toBe(200);
      expect(await health(issued.token, "restricted")).toBe(401);
    }
    expect(await health("token-disabled-only", "restricted")).toBe(401);
    expect(await health("token-null-a", "restricted")).toBe(403);
    expect((await browser("session-disabled-only")).status).toBe(401);
    const after = await history();
    // Every preexisting row and credential stays attached to its original owner.
    for (let index = 0; index < before.length; index++) {
      expect(after[index]!.results).toEqual(expect.arrayContaining(before[index]!.results));
    }
    await expect(
      env.DB.prepare("UPDATE callers SET github_user_id = 101 WHERE id = 'null-a'").run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      env.DB.prepare("UPDATE callers SET status = 'active' WHERE id = 'disabled-same'").run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});

async function oldSchema(): Promise<void> {
  await restoreD1Baseline(env.DB, ["PRAGMA defer_foreign_keys=TRUE;"]);
  await applyD1Migrations(
    env.DB,
    migrations().filter(({ name }) => name < "0012_"),
  );
  await env.DB.batch(
    [POOL, "restricted"].map((pool) =>
      env.DB.prepare("INSERT INTO pools (id, name, policy_json) VALUES (?, ?, '{}')").bind(
        pool,
        pool,
      ),
    ),
  );
  for (const [id, uid, status, org] of [
    ["singleton", 101, "active", "OpenClaw"],
    ["disabled-same", 101, "disabled", "openclaw"],
    ["disabled-only", 202, "disabled", "OPENCLAW"],
    ["null-a", null, "active", "openclaw"],
    ["null-b", null, "active", "OpenClaw"],
    ["other-org", 404, "active", "other-org"],
  ] as const) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO callers (id, name, token_hash, github_login, github_user_id, org_login, org_verified_at, status, dashboard_role) VALUES (?, 'Historical', ?, 'same-name', ?, ?, ?, ?, 'admin')",
      ).bind(id, await hashToken(`token-${id}`), uid, org, LEGACY_PROOF, status),
      env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES (?, 'restricted')").bind(
        id,
      ),
      env.DB.prepare(
        "INSERT INTO web_sessions (session_hash, caller_id, expires_at) VALUES (?, ?, '2099-01-01')",
      ).bind(await hashToken(`session-${id}`), id),
      env.DB.prepare(
        "INSERT INTO audit_events (request_id, caller_id, pool_id, route_key, route_kind, status, duration_ms) VALUES (?, ?, 'restricted', 'synthetic', 'repo_view', 200, 1)",
      ).bind(`audit-${id}`, id),
    ]);
  }
  await applyD1Migrations(
    env.DB,
    migrations().filter(({ name }) => name >= "0012_" && name < "0018_"),
  );
  expect(
    (await env.DB.prepare("SELECT id, client_name FROM caller_tokens ORDER BY id").all()).results,
  ).toEqual(
    ["disabled-only", "disabled-same", "null-a", "null-b", "other-org", "singleton"].map((id) => ({
      id: `legacy_${id}`,
      client_name: "legacy",
    })),
  );
}

async function duplicate(org: string, role: string, pool: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO callers (id, name, token_hash, github_login, github_user_id, org_login, status, dashboard_role) VALUES ('duplicate', 'Duplicate', ?, 'same-name', 101, ?, 'active', ?)",
    ).bind(await hashToken("token-duplicate"), org, role),
    env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES ('duplicate', ?)").bind(
      pool,
    ),
    env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES ('duplicate-token', 'duplicate', ?, 'legacy')",
    ).bind(await hashToken("token-duplicate")),
    env.DB.prepare(
      "INSERT INTO web_sessions (session_hash, caller_id, expires_at) VALUES (?, 'duplicate', '2099-01-01')",
    ).bind(await hashToken("session-duplicate")),
    env.DB.prepare(
      "INSERT INTO audit_events (request_id, caller_id, pool_id, route_key, route_kind, status, duration_ms, caller_token_id, client_name) VALUES ('audit-duplicate', 'duplicate', ?, 'synthetic', 'repo_view', 200, 1, 'duplicate-token', 'legacy')",
    ).bind(pool),
  ]);
}

async function upgrade(): Promise<void> {
  const migration = migrations().find(({ name }) => name === UPGRADE);
  expect(migration).toBeDefined();
  await applyD1Migrations(env.DB, [migration!]);
}

async function history() {
  const results = await env.DB.batch<Record<string, unknown>>(
    [
      "SELECT * FROM callers ORDER BY id",
      "SELECT * FROM caller_tokens ORDER BY id",
      "SELECT * FROM audit_events ORDER BY request_id",
      "SELECT * FROM web_sessions ORDER BY session_hash",
      "SELECT * FROM caller_pools ORDER BY caller_id, pool_id",
    ].map((sql) => env.DB.prepare(sql)),
  );
  return results.map(({ results }) => ({ results }));
}

async function health(token: string, pool = POOL): Promise<number> {
  return (
    await callWorker(`/v1/pools/${pool}/health`, { headers: { authorization: `Bearer ${token}` } })
  ).status;
}
function browser(session: string): Promise<Response> {
  return callWorker("https://octopool.openclaw.ai/v1/me", {
    headers: { cookie: `octopool_session=${session}` },
  });
}
