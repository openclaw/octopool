import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { authenticateCaller, hashToken } from "../../src/auth";
import { insertAudit } from "../../src/db";
import {
  loginClient,
  mockEnrollmentAccount,
  concurrentEnrollments,
  type Enrollment,
} from "./enrollment-support";
import { callWarmWorker, POOL, seedPool, seedWebSession, seedAudit, CALLER_TOKEN } from "./harness";

import { queries } from "../../src/generated/sql";
import { captureD1Baseline } from "./d1-baseline";
import { beforeClientNameUpgrade, applyClientNameUpgrade } from "./client-name-upgrade";

describe("client name login identity", () => {
  it.each(["Host.local.local", "Host.LoCaL.local.LOCAL"])(
    "keeps fresh %s login, authentication, original filters and rotation aligned",
    async (input) => {
      mockEnrollmentAccount();
      const response = await loginClient(input);
      expect(response.status).toBe(201);
      const first = await response.json<Enrollment>();
      const caller = await authenticateCaller(
        new Request("https://octopool.dev", {
          headers: { authorization: `Bearer ${first.token}` },
        }),
        env,
        POOL,
      );
      await insertAudit(env, {
        requestId: "compound-request",
        callerId: caller.id,
        callerTokenId: caller.caller_token_id,
        clientName: caller.client_name,
        pool: POOL,
        routeKey: "synthetic",
        routeKind: "repo_view",
        status: 200,
        durationMs: 1,
        cacheStatus: "miss",
        cacheable: true,
      });
      expect.soft(first.caller.client_name).toBe("Host");
      expect.soft(caller.client_name).toBe("Host");
      for (const filter of [undefined, input, first.caller.client_name, caller.client_name]) {
        const stats = await callWarmWorker(
          `/v1/pools/${POOL}/stats${filter ? `?client=${encodeURIComponent(filter)}` : ""}`,
          {
            headers: { authorization: `Bearer ${first.token}` },
          },
        );
        expect(stats.status).toBe(200);
        expect.soft(await stats.json()).toMatchObject({
          operator: { client_name: "Host" },
          client_usage: { requests: 1 },
          clients: [{ client_name: "Host", requests: 1 }],
        });
      }
      const rotatedResponse = await loginClient(caller.client_name);
      expect(rotatedResponse.status).toBe(201);
      const rotated = await rotatedResponse.json<Enrollment>();
      const health = (token: string) =>
        callWarmWorker(`/v1/pools/${POOL}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
      expect.soft((await health(first.token)).status).toBe(401);
      expect((await health(rotated.token)).status).toBe(200);
      expect
        .soft((await env.DB.prepare("SELECT id, client_name FROM caller_tokens").all()).results)
        .toEqual([{ id: caller.caller_token_id, client_name: "Host" }]);
    },
  );
});

describe("historical stats label projection", () => {
  it("groups aliases before the result limit while preserving case and reserved names", async () => {
    await seedPool();
    for (let index = 0; index < 45; index++) {
      let bit = 0;
      const suffix = ".local.local".replace(/[a-z]/g, (letter) =>
        index & (1 << bit++) ? letter.toUpperCase() : letter,
      );
      await seedAudit(`variant-${index}`, "caller", "repo_view", "hit", 200, {
        clientName: `Host${suffix}`,
      });
    }
    for (const name of ["host", "Host.locality", "Host.local-x", "legacy", "admin", "unknown"]) {
      await seedAudit(name, "caller", "issue_view", "miss", 200, { clientName: name });
    }
    const before = (await env.DB.prepare("SELECT * FROM audit_events ORDER BY request_id").all())
      .results;
    const response = await callWarmWorker(`/v1/pools/${POOL}/stats?client=Host.local.LOCAL`, {
      headers: { authorization: `Bearer ${CALLER_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const stats = await response.json<{
      clients: { client_name: string; requests: number }[];
      client_usage: { requests: number };
      client_routes: unknown[];
    }>();
    expect(stats.client_usage.requests).toBe(45);
    expect(stats.client_routes).toMatchObject([{ route_kind: "repo_view", requests: 45 }]);
    expect(stats.clients).toHaveLength(7);
    expect(stats.clients[0]).toMatchObject({ client_name: "Host", requests: 45 });
    expect(
      stats.clients
        .slice(1)
        .map(({ client_name }) => client_name)
        .sort(),
    ).toEqual(["host", "Host.locality", "Host.local-x", "legacy", "admin", "unknown"].sort());
    expect(
      (await env.DB.prepare("SELECT * FROM audit_events ORDER BY request_id").all()).results,
    ).toEqual(before);
  });
});

describe("verified client alias reconciliation", () => {
  it("rotates a historical singleton at cap without losing IDs, history or other clients", async () => {
    await historicalClients();
    const before = await preservedHistory();
    expect((await health(CALLER_TOKEN)).status).toBe(200);
    const response = await loginClient("Host.local.local");
    expect(response.status).toBe(201);
    const issued = await response.json<Enrollment>();
    expect.soft(issued.caller).toMatchObject({ id: "caller", client_name: "Host" });
    expect.soft((await health(CALLER_TOKEN)).status).toBe(401);
    expect((await health(issued.token)).status).toBe(200);
    expect.soft(await preservedHistory()).toEqual(before);
    expect
      .soft(
        await env.DB.prepare(
          "SELECT id, client_name FROM caller_tokens WHERE id = 'caller-client-token'",
        ).first(),
      )
      .toEqual({ id: "caller-client-token", client_name: "Host" });
    expect
      .soft(await env.DB.prepare("SELECT count(*) AS n FROM caller_tokens").first())
      .toEqual({ n: 16 });
    expect.soft((await health("other-0")).status).toBe(200);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    expect.soft((await health(CALLER_TOKEN)).status).toBe(401);
    expect((await health(issued.token)).status).toBe(200);
    for (const name of ["Host", "Host.local.local", "Host.LoCaL"]) {
      const response = await callWarmWorker(`/v1/pools/${POOL}/stats?client=${name}`, {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      expect.soft(await response.json()).toMatchObject({
        client_filter: "Host",
        client_usage: { requests: 2 },
        clients: [{ client_name: "Host", requests: 2 }],
      });
    }
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it.each(["Host", "Host.local.LOCAL"])(
    "refuses ambiguous family %s atomically, retaining all credentials",
    async (second) => {
      await historicalClients(second);
      const before = await captureD1Baseline(env.DB);
      const response = await loginClient("Host.local.local");
      expect.soft(response.status).toBe(409);
      const body = await response.json();
      expect.soft(body).toMatchObject({ error: { code: "client_name_ambiguous" } });
      expect.soft(body).not.toHaveProperty("token");
      expect.soft(await captureD1Baseline(env.DB)).toEqual(before);
      expect.soft((await health(CALLER_TOKEN)).status).toBe(200);
      expect.soft((await health("ambiguous-token")).status).toBe(200);
      expect.soft((await health("other-0")).status).toBe(200);
    },
  );

  it("blocks old raw writers before and after reconciliation without revoking existing rows", async () => {
    await historicalClients();
    const original = await captureD1Baseline(env.DB);
    await expect(oldWriter("Host")).rejects.toThrow("client_name_ambiguous");
    expect(await captureD1Baseline(env.DB)).toEqual(original);
    expect((await health(CALLER_TOKEN)).status).toBe(200);
    const response = await loginClient("Host");
    expect(response.status).toBe(201);
    const issued = await response.json<Enrollment>();
    const reconciled = await captureD1Baseline(env.DB);
    for (const raw of ["Host.local", "Host.LoCaL.local", " Host "]) {
      await expect(oldWriter(raw)).rejects.toThrow("client_name_noncanonical");
      expect(await captureD1Baseline(env.DB)).toEqual(reconciled);
    }
    await expect(
      env.DB.prepare(
        "UPDATE caller_tokens SET client_name = 'Host.local' WHERE id = 'caller-client-token'",
      ).run(),
    ).rejects.toThrow("client_name_noncanonical");
    expect(await captureD1Baseline(env.DB)).toEqual(reconciled);
    expect((await health(issued.token)).status).toBe(200);
    // Old exact canonical writes still work after reconciliation.
    await oldWriter("Host");
    expect(
      await env.DB.prepare("SELECT id FROM caller_tokens WHERE client_name = 'Host'").first(),
    ).toEqual({ id: "caller-client-token" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM caller_tokens").first()).toEqual({
      n: 16,
    });
  });

  it("rolls back a singleton rename and all enrollment writes on a later rotation failure", async () => {
    await historicalClients();
    await env.DB.prepare(
      "CREATE TRIGGER client_rotation_abort AFTER UPDATE OF token_hash ON caller_tokens BEGIN SELECT RAISE(ABORT, 'synthetic-rotation-failure'); END",
    ).run();
    const before = await captureD1Baseline(env.DB);
    const response = await loginClient("Host");
    expect.soft(response.status).toBe(500);
    expect.soft(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect.soft(await captureD1Baseline(env.DB)).toEqual(before);
    expect.soft((await health(CALLER_TOKEN)).status).toBe(200);
  });

  it("serializes concurrent alias/canonical rotations of a singleton", async () => {
    await historicalClients();
    const before = await preservedHistory();
    const responses = await concurrentEnrollments([
      () => loginClient("Host"),
      () => loginClient("Host.local.local"),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    const issued = await Promise.all(responses.map((response) => response.json<Enrollment>()));
    const auth = await Promise.all(issued.map(async ({ token }) => (await health(token)).status));
    expect.soft(auth.sort()).toEqual([200, 401]);
    expect.soft((await health(CALLER_TOKEN)).status).toBe(401);
    expect.soft(await preservedHistory()).toEqual(before);
    expect
      .soft(
        (
          await env.DB.prepare(
            "SELECT id, client_name FROM caller_tokens WHERE client_name LIKE 'Host%'",
          ).all()
        ).results,
      )
      .toEqual([{ id: "caller-client-token", client_name: "Host" }]);
  });
});

async function health(token: string) {
  return callWarmWorker(`/v1/pools/${POOL}/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function historicalClients(second?: string) {
  await beforeClientNameUpgrade();
  await seedPool();
  await seedWebSession();
  await env.DB.prepare(
    "INSERT INTO pools (id, name, policy_json) VALUES ('restricted', 'restricted', '{}')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO caller_pools (caller_id, pool_id) VALUES ('caller', 'restricted')",
  ).run();
  await env.DB.prepare(
    "UPDATE caller_tokens SET client_name = 'Host.LoCaL' WHERE id = 'caller-client-token'",
  ).run();
  for (let index = 0; index < (second ? 14 : 15); index++) {
    await env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name, updated_at) VALUES (?, 'caller', ?, ?, '2000-01-01')",
    )
      .bind(`other-${index}`, await hashToken(`other-${index}`), `other-${index}`)
      .run();
  }
  if (second)
    await env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES ('ambiguous', 'caller', ?, ?)",
    )
      .bind(await hashToken("ambiguous-token"), second)
      .run();
  await seedAudit("alias-history", "caller", "repo_view", "hit", 200, { clientName: "Host.LoCaL" });
  await seedAudit("compound-history", "caller", "repo_view", "miss", 200, {
    clientName: "Host.local.local",
  });
  const before = await preservedHistory();
  const tokens = (await env.DB.prepare("SELECT * FROM caller_tokens ORDER BY id").all()).results;
  await applyClientNameUpgrade();
  expect(await preservedHistory()).toEqual(before);
  expect((await env.DB.prepare("SELECT * FROM caller_tokens ORDER BY id").all()).results).toEqual(
    tokens,
  );
  mockEnrollmentAccount(42, "renamed-user");
}

async function preservedHistory() {
  return Promise.all([
    env.DB.prepare(
      "SELECT id, github_user_id, org_login, dashboard_role FROM callers ORDER BY id",
    ).all(),
    env.DB.prepare("SELECT * FROM caller_pools ORDER BY caller_id, pool_id").all(),
    env.DB.prepare("SELECT * FROM web_sessions ORDER BY session_hash").all(),
    env.DB.prepare("SELECT * FROM audit_events ORDER BY request_id").all(),
    env.DB.prepare("SELECT * FROM caller_tokens WHERE id LIKE 'other-%' ORDER BY id").all(),
    env.DB.prepare(
      "SELECT rowid, id, caller_id, created_at FROM caller_tokens WHERE id = 'caller-client-token'",
    ).all(),
  ]).then((rows) => rows.map(({ results }) => results));
}

// The unchanged pre-PR12 enrollment SQL, deliberately omitting reconciliation.
async function oldWriter(clientName: string) {
  const hash = await hashToken("old-writer-synthetic");
  return env.DB.batch([
    env.DB.prepare(queries.upsertCallerEnrollment).bind(
      "old-candidate",
      "old-writer",
      hash,
      "old-writer",
      42,
      "openclaw",
      "2099-01-01",
    ),
    env.DB.prepare(queries.insertCallerPool).bind(42, "openclaw", POOL),
    env.DB.prepare(queries.upsertCallerToken).bind(
      "old-token-candidate",
      42,
      "openclaw",
      hash,
      clientName,
    ),
    env.DB.prepare(queries.pruneCallerTokens).bind(42, "openclaw", clientName),
  ]);
}
