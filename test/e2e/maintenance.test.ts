import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { queries } from "../../src/generated/sql";
import { runScheduled, seedAudit, seedPool } from "./harness";

describe("Worker scheduled session maintenance", () => {
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
    expect((await env.DB.prepare("SELECT * FROM audit_events").all()).results).toEqual(audits.results);
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
    expect(
      plan.results.some(({ detail }) => detail.includes("idx_web_sessions_expires")),
    ).toBe(true);
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
    expect(
      (await env.DB.prepare("SELECT session_hash FROM web_sessions").all()).results,
    ).toEqual([{ session_hash: "future" }]);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
