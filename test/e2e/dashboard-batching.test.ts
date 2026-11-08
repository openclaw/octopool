import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dashboardData } from "../../src/dashboard-data";
import { POOL, seedAudit, seedPool, seedWebSession } from "./harness";

async function request() {
  const session = await seedWebSession();
  return new Request(`https://octopool.openclaw.ai/v1/dashboard?pool=${POOL}`, {
    headers: { cookie: `octopool_session=${session}` },
  });
}

describe("dashboard database snapshot", () => {
  it.each([false, true])(
    "normalizes every panel in one batch (populated=%s)",
    async (populated) => {
      await seedPool({ secondary: true });
      await env.DB.prepare(
        "UPDATE identities SET status = 'disabled' WHERE id = 'secondary'",
      ).run();
      if (populated) {
        await seedAudit("hit", "caller", "repo_view", "hit", 200);
        await seedAudit("miss", "caller", "repo_view", "miss", 200);
        await seedAudit("error", "caller", "run_view", "bypass", 503, {
          errorCode: "upstream_error",
        });
        await env.DB.prepare(
          "INSERT INTO pools (id, name, policy_json) VALUES ('other', 'other', '{}')",
        ).run();
        await seedAudit("other-pool", "caller", "repo_view", "miss", 500);
        await env.DB.prepare(
          "UPDATE audit_events SET pool_id = 'other' WHERE request_id = 'other-pool'",
        ).run();
      }
      const batches: number[] = [];
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch")
            return (statements: D1PreparedStatement[]) => {
              batches.push(statements.length);
              return target.batch(statements);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const response = await dashboardData(await request(), { ...env, DB: db });
      const body = await response.json<any>();
      expect(batches).toEqual([12]);
      expect(body).toMatchObject({
        pool: POOL,
        identities: { total: 2, active: 1 },
        cache: { total_entries: 0, routes: [] },
        usage: { requests_24h: populated ? 3 : 0, errors_24h: populated ? 1 : 0 },
        public_repos: { total_entries: 0, fresh_entries: 0, newest_checked_at: null },
        coordinator: { rates: [], cooldowns: [], leases: [] },
      });
      expect(body.recent).toHaveLength(populated ? 3 : 0);
      expect(body.route_usage).toHaveLength(populated ? 2 : 0);
      expect(body.route_keys_7d).toHaveLength(populated ? 2 : 0);
      if (populated) {
        expect(body.users).toMatchObject([{ requests: 3, errors: 1 }]);
        expect(body.clients).toMatchObject([
          { requests: 3, cache_served_responses: 1, uncached_outcomes: 2 },
        ]);
        expect(body.identity_usage).toEqual([{ identity_id: "primary", requests: 3, errors: 1 }]);
        expect(body.error_codes_7d).toHaveLength(1);
      } else {
        for (const panel of ["users", "clients", "identity_usage", "error_codes_7d"])
          expect(body[panel]).toEqual([]);
      }
    },
  );

  it("does not issue panel reads before session authentication", async () => {
    await seedPool();
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return () => {
            batches++;
            throw new Error("unexpected panel read");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      dashboardData(new Request("https://octopool.openclaw.ai/v1/dashboard"), { ...env, DB: db }),
    ).rejects.toMatchObject({ status: 401, code: "missing_web_session" });
    expect(batches).toBe(0);
  });
});
