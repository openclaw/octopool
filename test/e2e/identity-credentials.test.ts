import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import type { CredentialFailureReason } from "../../src/github-auth";
import { HttpError } from "../../src/http";
import { bearer, githubUpstream, jsonResponse, POOL, seedPool } from "./harness";
import { appIdentity, requestWithEnv } from "./identity-routing-support";

const coordinator = () => poolCoordinatorStub(env, POOL);
const localCases: [string, "pat" | "app", Record<string, unknown>, string][] = [
  ["missing PAT", "pat", { TEST_PAT_PRIMARY: undefined }, "identity_secret_missing"],
  ["blank PAT", "pat", { TEST_PAT_PRIMARY: " \n " }, "identity_secret_missing"],
  ["wrong-type PAT", "pat", { TEST_PAT_PRIMARY: {} }, "identity_secret_missing"],
  ["missing App ID", "app", { OCTOPOOL_GITHUB_APP_ID: undefined }, "github_app_id_missing"],
  ["blank App ID", "app", { OCTOPOOL_GITHUB_APP_ID: " " }, "github_app_id_missing"],
  ["wrong-type App ID", "app", { OCTOPOOL_GITHUB_APP_ID: 777 }, "github_app_id_missing"],
  ["missing key", "app", { TEST_APP_KEY: undefined }, "identity_secret_missing"],
  ["blank key", "app", { TEST_APP_KEY: " " }, "identity_secret_missing"],
  ["wrong-type key", "app", { TEST_APP_KEY: {} }, "identity_secret_missing"],
  [
    "PKCS1",
    "app",
    { TEST_APP_KEY: "-----BEGIN RSA PRIVATE KEY-----\nsynthetic\n-----END RSA PRIVATE KEY-----" },
    "github_app_key_format",
  ],
  [
    "empty PEM",
    "app",
    { TEST_APP_KEY: "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----" },
    "github_app_key_format",
  ],
  [
    "base64",
    "app",
    { TEST_APP_KEY: "-----BEGIN PRIVATE KEY-----\n%%%\n-----END PRIVATE KEY-----" },
    "github_app_key_format",
  ],
  [
    "DER",
    "app",
    { TEST_APP_KEY: "-----BEGIN PRIVATE KEY-----\nYmFk\n-----END PRIVATE KEY-----" },
    "github_app_key_format",
  ],
];

describe("selected identity credential failures", () => {
  it.each(localCases)(
    "tries only the selected %s then serves and audits the healthy PAT",
    async (_label, kind, overrides, reason) => {
      await seedPool({ secondary: true });
      if (kind === "app") await appIdentity();
      const logs = vi.spyOn(console, "error").mockImplementation(() => {});
      const upstream = githubUpstream({ primary: jsonResponse({ private: false, id: 17 }) });
      vi.stubGlobal("fetch", upstream);
      const before = Date.now();
      const response = await requestWithEnv(overrides);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        identity: { id: "secondary" },
        body: { id: 17 },
      });
      expect(upstream.mock.calls.map(([input, init]) => bearer(input, init))).toEqual([
        "test-org-token",
        "test-secondary-token",
      ]);
      const snapshot = await coordinator().snapshot();
      expect(snapshot.rates).toEqual([]);
      expect(snapshot.cooldowns).toEqual([
        expect.objectContaining({ identity_id: "primary", route_key: "*", status: 503, reason }),
      ]);
      expect(snapshot.cooldowns[0]!.expires_at).toBeGreaterThanOrEqual(before + 120_000);
      expect(snapshot.cooldowns[0]!.expires_at).toBeLessThanOrEqual(Date.now() + 120_000);
      expect(
        await env.DB.prepare("SELECT identity_id, status, error_code FROM audit_events").all(),
      ).toMatchObject({ results: [{ identity_id: "secondary", status: 200, error_code: null }] });
      expect(logs).not.toHaveBeenCalled();
    },
  );

  it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects installation %s before exchange",
    async (installation) => {
      await seedPool({ secondary: true });
      await appIdentity(installation);
      const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
      vi.stubGlobal("fetch", upstream);
      expect(await (await requestWithEnv()).json()).toMatchObject({
        identity: { id: "secondary" },
      });
      expect(upstream).toHaveBeenCalledTimes(2);
      expect((await coordinator().snapshot()).cooldowns[0]?.reason).toBe(
        "github_app_installation_missing",
      );
    },
  );

  it("visits every broken ID once, returns the first generic error, and later reports cooling", async () => {
    await seedPool({ secondary: true });
    await appIdentity(null);
    const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
    vi.stubGlobal("fetch", upstream);
    const response = await requestWithEnv({ TEST_PAT_SECONDARY: undefined });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "github_app_installation_missing" } });
    expect(text).not.toMatch(/TEST_|secret_ref|token|PRIVATE KEY/);
    const snapshot = await coordinator().snapshot();
    expect(snapshot.cooldowns).toHaveLength(2);
    expect(snapshot.rates).toEqual([]);
    expect(await (await requestWithEnv()).json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "identities_cooling_down" } },
    });
    expect((await coordinator().snapshot()).cooldowns).toEqual(snapshot.cooldowns);
    expect(
      upstream.mock.calls.every(([input, init]) => bearer(input, init) === "test-org-token"),
    ).toBe(true);
  });

  it.each([401, 403, 429])(
    "keeps real HTTP %s feedback after a missing credential and returns the first local error",
    async (status) => {
      await seedPool({ secondary: true });
      vi.stubGlobal(
        "fetch",
        githubUpstream({ primary: jsonResponse({ message: "synthetic failure" }, status) }),
      );
      const response = await requestWithEnv({ TEST_PAT_PRIMARY: undefined });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: "identity_secret_missing",
          message: "Identity credential is not configured",
        },
      });
      expect((await coordinator().snapshot()).cooldowns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity_id: "primary",
            status: 503,
            route_key: "*",
            reason: "identity_secret_missing",
          }),
          expect.objectContaining({ identity_id: "secondary", status, reason: "github_error" }),
        ]),
      );
      expect((await coordinator().snapshot()).rates).toEqual([]);
    },
  );

  it("recovers at exactly 120 seconds, persists across eviction and never shortens a longer cooldown", async () => {
    await seedPool();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", githubUpstream({ primary: jsonResponse({ private: false }) }));
    expect((await requestWithEnv({ TEST_PAT_PRIMARY: undefined })).status).toBe(503);
    await evictDurableObject(coordinator());
    clock.mockReturnValue(now + 119_999);
    expect(await (await requestWithEnv()).json()).toMatchObject({
      error: { details: { reason: "identities_cooling_down" } },
    });
    clock.mockReturnValue(now + 120_000);
    expect(await (await requestWithEnv()).json()).toMatchObject({ identity: { id: "primary" } });
    const rows = await runInDurableObject(coordinator(), (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM cooldowns").toArray(),
    );
    expect(rows).toEqual([
      {
        identity_id: "primary",
        route_key: "*",
        status: 503,
        reason: "identity_secret_missing",
        expires_at: now + 120_000,
      },
    ]);
    await coordinator().recordResult({
      identityId: "primary",
      routeKey: "other",
      resource: "core",
      status: 401,
      rate: { retryAfter: 500 },
    });
    await coordinator().recordCredentialFailure({
      identityId: "primary",
      reason: "github_app_key_format",
    });
    expect((await coordinator().snapshot()).cooldowns[0]).toMatchObject({
      status: 401,
      reason: "github_error",
      expires_at: now + 620_000,
    });
    clock.mockRestore();
  });

  it("retains a cached App token without a key, then fails over at refresh", async () => {
    await seedPool({ secondary: true });
    await appIdentity(92001);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let exchanges = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (bearer(input, init) === "test-org-token") return jsonResponse({ private: false });
        if (new Request(input, init).method === "POST") {
          exchanges++;
          return jsonResponse({
            token: "synthetic-app",
            expires_at: new Date(now + 3_600_000).toISOString(),
          });
        }
        return jsonResponse({ private: false });
      }),
    );
    expect(await (await requestWithEnv()).json()).toMatchObject({ identity: { id: "primary" } });
    expect(await (await requestWithEnv({ TEST_APP_KEY: undefined })).json()).toMatchObject({
      identity: { id: "primary" },
    });
    clock.mockReturnValue(now + 3_540_000);
    expect(await (await requestWithEnv({ TEST_APP_KEY: undefined })).json()).toMatchObject({
      identity: { id: "secondary" },
    });
    expect(exchanges).toBe(1);
    clock.mockRestore();
  });

  it.each([
    ["missing App ID", 98001, undefined, undefined, "github_app_id_missing"],
    ["blank App ID", 98002, " ", undefined, "github_app_id_missing"],
    ["wrong-type App ID", 98003, 777, undefined, "github_app_id_missing"],
    ["missing installation", 98004, undefined, null, "github_app_installation_missing"],
    ["zero installation", 98005, undefined, 0, "github_app_installation_missing"],
    ["negative installation", 98006, undefined, -1, "github_app_installation_missing"],
    ["fractional installation", 98007, undefined, 1.5, "github_app_installation_missing"],
    [
      "unsafe installation",
      98008,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
      "github_app_installation_missing",
    ],
  ] as const)(
    "checks %s even with a valid cached App token",
    async (_label, installation, appId, invalidInstallation, reason) => {
      await seedPool({ secondary: true });
      await appIdentity(installation);
      let exchanges = 0;
      const resources: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const token = bearer(request);
          if (token === "test-org-token") return jsonResponse({ private: false });
          if (request.method === "POST") {
            exchanges++;
            expect(new URL(request.url).pathname).toBe(
              `/app/installations/${installation}/access_tokens`,
            );
            return jsonResponse({
              token: "synthetic-prerequisite-app",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            });
          }
          resources.push(token!);
          return jsonResponse({ private: false });
        }),
      );
      expect(await (await requestWithEnv()).json()).toMatchObject({ identity: { id: "primary" } });
      // A keyless request proves the real mint populated a still-valid token entry.
      expect(await (await requestWithEnv({ TEST_APP_KEY: undefined })).json()).toMatchObject({
        identity: { id: "primary" },
      });
      if (invalidInstallation !== undefined) await appIdentity(invalidInstallation);
      const response = await requestWithEnv({
        TEST_APP_KEY: undefined,
        OCTOPOOL_GITHUB_APP_ID: appId,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ identity: { id: "secondary" } });
      expect(exchanges).toBe(1);
      expect(resources).toEqual([
        "synthetic-prerequisite-app",
        "synthetic-prerequisite-app",
        "test-secondary-token",
      ]);
      expect(await coordinator().snapshot()).toMatchObject({
        rates: [],
        cooldowns: [expect.objectContaining({ identity_id: "primary", reason, status: 503 })],
      });
    },
  );

  it.each(["http", "transport", "arbitrary503"])(
    "does not retry an installation POST on %s failure",
    async (mode) => {
      await seedPool({ secondary: true });
      await appIdentity(93001);
      let posts = 0;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        if (bearer(input, init) === "test-org-token") return jsonResponse({ private: false });
        expect(new Request(input, init).method).toBe("POST");
        posts++;
        if (mode === "transport") throw new Error("synthetic transport fault");
        if (mode === "arbitrary503")
          throw new HttpError(503, "synthetic_infrastructure", "Synthetic infrastructure failure");
        return jsonResponse({ message: "synthetic private upstream" }, 503);
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal("fetch", upstream);
      const response = await requestWithEnv();
      expect(response.status).toBe(mode === "http" ? 502 : mode === "transport" ? 500 : 503);
      expect(posts).toBe(1);
      expect((await coordinator().snapshot()).cooldowns).toEqual([]);
      expect((await coordinator().snapshot()).rates).toEqual([]);
      expect(await response.text()).not.toContain("synthetic private upstream");
    },
  );

  it("rejects nonallowlisted credential reasons in the real DO without persistence", async () => {
    await runInDurableObject(coordinator(), (instance) => {
      expect(() =>
        instance.recordCredentialFailure({
          identityId: "primary",
          reason: "SYNTHETIC_BINDING" as CredentialFailureReason,
        }),
      ).toThrow("Invalid credential failure observation");
    });
    expect((await coordinator().snapshot()).cooldowns).toEqual([]);
  });
});
