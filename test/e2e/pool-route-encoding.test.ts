import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CALLER_TOKEN, POOL, callWorker, seedPool } from "./harness";

const headers = { authorization: `Bearer ${CALLER_TOKEN}` };

async function grantPool(pool: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pools (id, name, policy_json) SELECT ?, ?, policy_json FROM pools WHERE id = ?",
    ).bind(pool, pool, POOL),
    env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES ('caller', ?)").bind(pool),
  ]);
}

describe("encoded pool routes", () => {
  it.each(["team/ci", "team?ci#logs%", "猫", "%2F", "/"])(
    "resolves the exact pool %s for caller routes",
    async (pool) => {
      await seedPool();
      await grantPool(pool);
      for (const route of ["health", "stats", "string-rewrites"]) {
        const response = await callWorker(`/v1/pools/${encodeURIComponent(pool)}/${route}`, {
          headers,
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        if (route !== "string-rewrites") expect(body).toMatchObject({ pool });
      }
    },
  );

  it("does not use a decoded pool's grant for a literal percent-encoded name", async () => {
    await seedPool();
    await grantPool("/");
    for (const route of ["health", "stats", "string-rewrites"]) {
      const response = await callWorker(`/v1/pools/%252F/${route}`, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_auth" } });
    }
  });

  it("provisions identities under the decoded pool name", async () => {
    const pool = "team/ci?logs#%";
    const response = await callWorker(`/v1/admin/pools/${encodeURIComponent(pool)}/identities`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: "encoded-pool-identity",
        login: "test-user",
        secret_ref: "TEST_PAT_PRIMARY",
        scopes: [{ owner: "openclaw", allow_private: false }],
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ identity: { pool } });
    expect(
      await env.DB.prepare("SELECT pool_id FROM identities WHERE id = ?")
        .bind("encoded-pool-identity")
        .first(),
    ).toEqual({ pool_id: pool });
  });

  it.each(["health", "stats", "string-rewrites"])(
    "rejects malformed encoding in %s without an internal error",
    async (route) => {
      const response = await callWorker(`/v1/pools/%FF/${route}`, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_path" } });
    },
  );
});
