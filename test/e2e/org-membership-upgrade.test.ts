import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { authenticateCaller, hashToken } from "../../src/auth";
import { requireDashboardAdmin } from "../../src/web-session";
import { restoreD1Baseline } from "./d1-baseline";
import {
  callWorker,
  CALLER_TOKEN,
  jsonResponse,
  orgMembershipResponse,
  POOL,
  seedPool,
  seedWebSession,
} from "./harness";

const LEGACY_PROOF = "2020-01-01T00:00:00.000Z";
const FUTURE_LEGACY_PROOF = "2099-01-01T00:00:00.000Z";

describe("immutable membership rolling upgrade", () => {
  it("isolates a legacy refresh after migration from new bearer and browser authentication", async () => {
    await seedOldSchema();
    const before = await env.DB.prepare("SELECT * FROM callers WHERE id = 'caller'").first();
    const session = await seedWebSession();
    await applyUpgrade();
    expect
      .soft(await env.DB.prepare("SELECT * FROM callers WHERE id = 'caller'").first())
      .toEqual({ ...before, org_identity_verified_at: null });

    // The old Worker's exact timestamp writer can still finish after migration.
    await legacyRefresh(FUTURE_LEGACY_PROOF);
    const upstream = vi.fn<typeof fetch>(async () => orgMembershipResponse(true, 202));
    vi.stubGlobal("fetch", upstream);
    for (const response of [await health(), await browserSession(session)]) {
      expect.soft(response.status).toBe(403);
      expect
        .soft(await response.json())
        .toMatchObject({ error: { code: "github_identity_mismatch" } });
    }
    expect.soft(upstream).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare("SELECT org_verified_at FROM callers WHERE id = 'caller'").first(),
    ).toEqual({ org_verified_at: FUTURE_LEGACY_PROOF });
    expect((await storedProof())!.org_identity_verified_at).toBeNull();
  });

  it.each(["fresh", "future"])(
    "does not extend an expired identity proof with a %s legacy write",
    async (freshness) => {
      await seedOldSchema();
      const session = await seedWebSession();
      await applyUpgrade();
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(orgMembershipResponse(true, 101))
        .mockImplementation(async () => orgMembershipResponse(true, 202));
      vi.stubGlobal("fetch", upstream);
      expect((await health()).status).toBe(200);
      const proof = await storedProof();
      expect(proof!.org_verified_at).toBe(LEGACY_PROOF);
      expect(Date.now() - Date.parse(proof!.org_identity_verified_at!)).toBeLessThan(60_000);

      // Age an actually successful proof; neither old writer timestamp may extend its TTL.
      await env.DB.prepare("UPDATE callers SET org_identity_verified_at = ? WHERE id = 'caller'")
        .bind(LEGACY_PROOF)
        .run();
      const oldTimestamp = freshness === "fresh" ? new Date().toISOString() : FUTURE_LEGACY_PROOF;
      await legacyRefresh(oldTimestamp);
      for (const response of [await health(), await browserSession(session)]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "github_identity_mismatch" },
        });
      }
      expect(upstream).toHaveBeenCalledTimes(3);
      expect(await storedProof()).toEqual({
        org_verified_at: oldTimestamp,
        org_identity_verified_at: LEGACY_PROOF,
      });
    },
  );

  it("preserves the public caller field as an alias of only the new proof", async () => {
    await seedOldSchema();
    const session = await seedWebSession();
    await applyUpgrade();
    await legacyRefresh(FUTURE_LEGACY_PROOF);
    const upstream = vi.fn<typeof fetch>(async () => orgMembershipResponse(true, 101));
    vi.stubGlobal("fetch", upstream);
    expect((await health()).status).toBe(200);
    // Cold auth re-reads the completed proof, then warm auth preserves its normal cache.
    expect((await health()).status).toBe(200);
    const caller = await authenticateCaller(
      new Request("https://octopool.dev/", {
        headers: { authorization: `Bearer ${CALLER_TOKEN}` },
      }),
      env,
      POOL,
    );
    const webSession = await requireDashboardAdmin(
      new Request("https://octopool.openclaw.ai/", {
        headers: { cookie: `octopool_session=${session}` },
      }),
      env,
      POOL,
    );
    const proof = await storedProof();
    expect(proof!.org_verified_at).toBe(FUTURE_LEGACY_PROOF);
    expect(proof!.org_identity_verified_at).not.toBe(FUTURE_LEGACY_PROOF);
    for (const authenticated of [caller, webSession]) {
      expect(authenticated.org_verified_at).toBe(proof!.org_identity_verified_at);
      expect(authenticated).not.toHaveProperty("org_identity_verified_at");
    }
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([null, 0, -1, 1.5])(
    "rejects enrolled ID %s before either fresh timestamp can authorize",
    async (id) => {
      await seedPool();
      const session = await seedWebSession();
      const fresh = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE callers SET github_user_id = ?, org_verified_at = ?, org_identity_verified_at = ? WHERE id = 'caller'",
      )
        .bind(id, FUTURE_LEGACY_PROOF, fresh)
        .run();
      const upstream = vi.fn<typeof fetch>(async () => orgMembershipResponse(true, 202));
      vi.stubGlobal("fetch", upstream);
      for (const response of [await health(), await browserSession(session)]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "github_identity_required" },
        });
      }
      expect(await storedProof()).toEqual({
        org_verified_at: FUTURE_LEGACY_PROOF,
        org_identity_verified_at: fresh,
      });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(["CLI", "admin"])(
    "stores only the new proof on an existing account's verified %s login",
    async (surface) => {
      await seedOldSchema();
      const session = await seedWebSession();
      await applyUpgrade();
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/graphql") return orgMembershipResponse(true, 101);
        if (path === "/user" || path === "/users/new-name")
          return jsonResponse({ id: 101, login: "new-name" });
        return jsonResponse({}, 500);
      });
      vi.stubGlobal("fetch", upstream);
      const response = await callWorker(
        surface === "CLI" ? "/v1/login/github-cli" : "/v1/admin/callers",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(surface === "admin" ? { authorization: "Bearer test-admin-token" } : {}),
          },
          body: JSON.stringify(
            surface === "CLI"
              ? { github_token: "synthetic-login-token", client_name: "new-client" }
              : { pool: POOL, github_login: "new-name" },
          ),
        },
      );
      expect(response.status).toBe(201);
      const body = await response.json<{
        caller: { id: string; github_login: string };
        token: string;
      }>();
      expect(body.caller).toMatchObject({ id: "caller", github_login: "new-name" });
      const proof = await storedProof();
      expect(proof!.org_verified_at).toBe(LEGACY_PROOF);
      expect(Date.now() - Date.parse(proof!.org_identity_verified_at!)).toBeLessThan(60_000);
      expect(
        (
          await callWorker(`/v1/pools/${POOL}/health`, {
            headers: { authorization: `Bearer ${body.token}` },
          })
        ).status,
      ).toBe(200);
      expect((await browserSession(session)).status).toBe(200);
      expect(await storedProof()).toEqual(proof);
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );

  it("stores the new proof on an existing account's verified OAuth login without refreshing again", async () => {
    await seedOldSchema();
    const session = await seedWebSession();
    await applyUpgrade();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/login/oauth/access_token")
        return jsonResponse({ access_token: "synthetic-oauth-token" });
      if (path === "/user") return jsonResponse({ id: 101, login: "new-name" });
      if (path === "/graphql") return orgMembershipResponse(true, 101);
      return jsonResponse({}, 500);
    });
    vi.stubGlobal("fetch", upstream);
    const start = await callWorker("https://octopool.openclaw.ai/login/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await callWorker(
      `https://octopool.openclaw.ai/login/github/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `octopool_oauth_state=${encodeURIComponent(state)}` },
      },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("set-cookie")).toContain("octopool_session=");
    const proof = await storedProof();
    expect(proof!.org_verified_at).toBe(LEGACY_PROOF);
    expect(Date.now() - Date.parse(proof!.org_identity_verified_at!)).toBeLessThan(60_000);
    const response = await browserSession(session);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      caller: { id: "caller", github_login: "new-name", dashboard_role: "admin" },
    });
    expect(await storedProof()).toEqual(proof);
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});

function storedProof() {
  return env.DB.prepare(
    "SELECT org_verified_at, org_identity_verified_at FROM callers WHERE id = 'caller'",
  ).first<{ org_verified_at: string | null; org_identity_verified_at: string | null }>();
}

async function seedOldSchema(): Promise<void> {
  // Rebuild from the actual pre-upgrade migrations, using the existing isolated D1 lifecycle.
  await restoreD1Baseline(env.DB, ["PRAGMA defer_foreign_keys=TRUE;"]);
  await applyD1Migrations(
    env.DB,
    migrations().filter(({ name }) => name < "0017_"),
  );
  const columns = await env.DB.prepare("PRAGMA table_info(callers)").all<{ name: string }>();
  expect(columns.results.map(({ name }) => name)).not.toContain("org_identity_verified_at");
  const tokenHash = await hashToken(CALLER_TOKEN);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pools (id, name, policy_json) VALUES (?, ?, '{}')").bind(
      POOL,
      POOL,
    ),
    env.DB.prepare(`INSERT INTO callers (
      id, name, token_hash, github_login, github_user_id, org_login, org_verified_at, status, dashboard_role
    ) VALUES ('caller', 'Legacy Caller', ?, 'old-name', 101, 'openclaw', ?, 'active', 'admin')`).bind(
      tokenHash,
      LEGACY_PROOF,
    ),
    env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES ('caller', ?)").bind(POOL),
    env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES ('legacy-token', 'caller', ?, 'legacy-mac')",
    ).bind(tokenHash),
  ]);
}

function migrations(): D1Migration[] {
  return (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
}

async function applyUpgrade(): Promise<void> {
  const upgrade = migrations().find(({ name }) => name === "0017_org_identity_verification.sql");
  expect(upgrade).toBeDefined();
  await applyD1Migrations(env.DB, [upgrade!]);
}

async function legacyRefresh(timestamp: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE callers SET org_verified_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(timestamp, "caller")
    .run();
}

function health(): Promise<Response> {
  return callWorker(`/v1/pools/${POOL}/health`, {
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
  });
}

function browserSession(session: string): Promise<Response> {
  return callWorker("https://octopool.openclaw.ai/v1/me", {
    headers: { cookie: `octopool_session=${session}` },
  });
}
