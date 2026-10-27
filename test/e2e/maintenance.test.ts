import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { queries } from "../../src/generated/sql";
import { restoreD1Baseline } from "./d1-baseline";
import { callWorker, runScheduled, seedAudit, seedPool, seedWebSession } from "./harness";

describe("Worker scheduled session maintenance", () => {
  it("upgrades v0.9.10 session data before scheduled cleanup without changing valid access", async () => {
    const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    // v0.9.10 (78b159d4) has the same 25 migration blobs as this branch's base:
    // tree ed0eb5c7b2d4e75192a812146df86ab7d2d46648. Seed before applying 0026.
    const stable = migrations.filter(({ name }) => name < "0026_web_session_retention.sql");
    const retention = migrations.filter(({ name }) => name === "0026_web_session_retention.sql");
    expect(stable).toHaveLength(25);
    expect(stable.at(-1)?.name).toBe("0025_audit_timings.sql");
    expect(retention).toHaveLength(1);
    await restoreD1Baseline(env.DB, []);
    await applyD1Migrations(env.DB, stable);
    await seedPool();
    const session = await seedWebSession();
    await seedAudit("retained-upgrade-audit", "caller", "repo_view", "miss", 200);
    await env.DB.prepare(
      `INSERT INTO web_sessions (session_hash, caller_id, expires_at)
       VALUES ('expired-before-upgrade', 'caller', datetime('now', '-1 day'))`,
    ).run();
    await env.DB.prepare("UPDATE string_rewrite_policy SET revision = 7 WHERE id = 1").run();
    const protectedTables = [
      "callers",
      "caller_pools",
      "caller_tokens",
      "pools",
      "identities",
      "identity_scopes",
      "string_rewrite_policy",
      "audit_events",
    ];
    const protectedRows = () =>
      Promise.all(
        protectedTables.map(
          async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results,
        ),
      );
    const before = await protectedRows();
    const sessions = (
      await env.DB.prepare("SELECT * FROM web_sessions ORDER BY session_hash").all()
    ).results;
    expect(
      await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'idx_web_sessions_expires'",
      ).first(),
    ).toBeNull();

    await applyD1Migrations(env.DB, retention);

    expect(
      (await env.DB.prepare("SELECT * FROM web_sessions ORDER BY session_hash").all()).results,
    ).toEqual(sessions);
    expect(await protectedRows()).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'idx_web_sessions_expires'",
      ).first(),
    ).toEqual({ name: "idx_web_sessions_expires" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runScheduled();

    const valid = sessions.filter(({ session_hash }) => session_hash !== "expired-before-upgrade");
    expect(
      (await env.DB.prepare("SELECT * FROM web_sessions ORDER BY session_hash").all()).results,
    ).toEqual(valid);
    expect(await protectedRows()).toEqual(before);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const response = await callWorker("https://octopool.openclaw.ai/v1/me", {
      headers: { cookie: `octopool_session=${session}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      caller: { id: "caller" },
      expires_at: valid[0]?.expires_at,
    });
    expect(await env.DB.prepare("SELECT expires_at FROM web_sessions").first()).toEqual({
      expires_at: valid[0]?.expires_at,
    });
  });

  it("removes expired sessions without treating activity as renewed expiry", async () => {
    await seedPool();
    await seedAudit("retained-audit", "caller", "repo_view", "miss", 200);
    await env.DB.prepare(
      `INSERT INTO web_sessions (session_hash, caller_id, expires_at, last_seen_at) VALUES
       ('expired', 'caller', datetime('now', '-1 day'), datetime('now', '-2 days')),
       ('boundary', 'caller', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       ('touched-expired', 'caller', datetime('now', '-1 day'), datetime('now', '-2 days')),
       ('future', 'caller', datetime('now', '+1 day'), CURRENT_TIMESTAMP),
       ('future-old-activity', 'caller', datetime('now', '+1 day'), datetime('now', '-30 days'))`,
    ).run();
    await env.DB.prepare(queries.touchWebSession).bind("touched-expired").run();
    const callers = await env.DB.prepare("SELECT * FROM callers").all();
    const audits = await env.DB.prepare("SELECT * FROM audit_events").all();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runScheduled();

    expect(
      (await env.DB.prepare("SELECT session_hash FROM web_sessions ORDER BY session_hash").all())
        .results,
    ).toEqual([{ session_hash: "future" }, { session_hash: "future-old-activity" }]);
    expect((await env.DB.prepare("SELECT * FROM callers").all()).results).toEqual(callers.results);
    expect((await env.DB.prepare("SELECT * FROM audit_events").all()).results).toEqual(
      audits.results,
    );
    expect(log).toHaveBeenCalledWith({
      event: "octopool.maintenance",
      table: "web_sessions",
      deleted_rows: 3,
      batches: 1,
      budget_exhausted: false,
      failed: false,
      duration_ms: expect.any(Number),
    });

    await runScheduled();

    expect(log).toHaveBeenLastCalledWith({
      event: "octopool.maintenance",
      table: "web_sessions",
      deleted_rows: 0,
      batches: 1,
      budget_exhausted: false,
      failed: false,
      duration_ms: expect.any(Number),
    });
  });

  it("uses the expiry index and deletes at most 500 sessions per statement", async () => {
    await seedPool();
    await env.DB.prepare(
      `WITH RECURSIVE expired(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM expired WHERE n < 501)
       INSERT INTO web_sessions (session_hash, caller_id, expires_at)
       SELECT printf('expired-%03d', n), 'caller', datetime('2000-01-01', printf('+%d seconds', n))
       FROM expired`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO web_sessions (session_hash, caller_id, expires_at)
       VALUES ('future', 'caller', datetime('now', '+1 day'))`,
    ).run();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${queries.deleteExpiredWebSessions}`)
      .bind(500)
      .all<{ detail: string }>();
    expect(plan.results.some(({ detail }) => detail.includes("idx_web_sessions_expires"))).toBe(
      true,
    );
    expect(plan.results.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);

    const first = await env.DB.prepare(queries.deleteExpiredWebSessions).bind(500).run();
    expect(first.meta.changes).toBe(500);
    expect(
      (await env.DB.prepare("SELECT session_hash FROM web_sessions ORDER BY session_hash").all())
        .results,
    ).toEqual([{ session_hash: "expired-501" }, { session_hash: "future" }]);

    const second = await env.DB.prepare(queries.deleteExpiredWebSessions).bind(500).run();
    const drained = await env.DB.prepare(queries.deleteExpiredWebSessions).bind(500).run();
    expect(second.meta.changes).toBe(1);
    expect(drained.meta.changes).toBe(0);
    expect((await env.DB.prepare("SELECT session_hash FROM web_sessions").all()).results).toEqual([
      { session_hash: "future" },
    ]);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
