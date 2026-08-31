import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../../src/config-cache";
import { githubCacheKey, readGitHubCache, writeGitHubCache } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { terminalLogCacheKey } from "../../src/terminal-log-cache";
import { runJobsSupersetView } from "../../src/run-jobs-superset";
import type { CredentialFailureReason } from "../../src/github-auth";
import {
  bearer,
  CALLER_TOKEN,
  githubUpstream,
  jsonResponse,
  POOL,
  rateHeaders,
  seedPool,
} from "./harness";
import { appIdentity, PATH, requestWithEnv, requestWithWarmEnv } from "./identity-routing-support";
import { ownedWork } from "./owned-work";

const DIFF_PATH = "/repos/openclaw/octopool/pulls/42";
const diffOptions = { headers: { accept: "application/vnd.github.diff" } };
const coordinator = () => poolCoordinatorStub(env, POOL);

async function expireEntries(): Promise<void> {
  const rows = await env.DB.prepare("SELECT cache_key FROM github_cache_entries").all<{
    cache_key: string;
  }>();
  for (const row of rows.results) await deleteEdgeJSON("github-v1", row.cache_key);
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', '-1 second')",
  ).run();
}

function diffUpstream(serve: (token: string | undefined) => Promise<Response> | Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const token = bearer(input, init);
    if (token === "test-org-token") return jsonResponse({ private: false });
    if (token === undefined) return new Response("unavailable", { status: 503 });
    return serve(token);
  });
}
function diffResponse() {
  return new Response("diff --git a/a b/a\n", {
    headers: { "content-type": "text/plain", etag: '"identity-diff"' },
  });
}

function feedbackNamespace(
  observe: (
    result: { identityId: string; reason: CredentialFailureReason },
    forward: () => Promise<void>,
  ) => Promise<void>,
) {
  const stub = coordinator();
  return new Proxy(env.POOL_COORDINATOR, {
    get(target, key) {
      if (key === "get")
        return () =>
          new Proxy(stub, {
            get(real, method) {
              if (method === "recordCredentialFailure")
                return (result: { identityId: string; reason: CredentialFailureReason }) =>
                  observe(result, async () => {
                    await real.recordCredentialFailure(result);
                  });
              const value = Reflect.get(real, method, real);
              return typeof value === "function"
                ? (...args: unknown[]) => Reflect.apply(value, real, args)
                : value;
            },
          });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("identity routing lifecycle boundaries", () => {
  it("keeps the failed ID excluded across pooled revalidation, shared fill restoration and follower completion", async () => {
    await seedPool({ secondary: true });
    vi.stubGlobal(
      "fetch",
      diffUpstream(() => diffResponse()),
    );
    expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
    await expireEntries();
    const entered = ownedWork.gate();
    const release = ownedWork.gate();
    let feedback = 0;
    const namespace = feedbackNamespace(async (result, forward) => {
      expect(result.identityId).toBe("primary");
      feedback++;
      await forward();
    });
    const upstream = diffUpstream(async (token) => {
      expect(token).toBe("test-secondary-token");
      entered.release();
      await release.promise;
      return diffResponse();
    });
    vi.stubGlobal("fetch", upstream);
    const overrides = { TEST_PAT_PRIMARY: undefined, POOL_COORDINATOR: namespace };
    const pending = requestWithEnv(overrides, DIFF_PATH, diffOptions);
    let follower: Promise<Response> | undefined;
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Relay completed before the gated resource call");
        }),
      ]);
      follower = requestWithEnv(overrides, DIFF_PATH, diffOptions);
      // Observe registration without resolving Runner-owned gates inside the DO.
      await Promise.race([
        vi.waitFor(async () => {
          const waiting = await runInDurableObject(
            coordinator(),
            (instance) =>
              (instance as unknown as { cacheFillWaiters: Map<string, unknown> }).cacheFillWaiters
                .size,
          );
          expect(waiting).toBe(1);
        }),
        follower.then(() => {
          throw new Error("Follower completed before coordinator waiting");
        }),
      ]);
      release.release();
      const responses = await Promise.all([pending, follower]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          identity: { id: "secondary" },
          body: "diff --git a/a b/a\n",
        });
      }
      expect(feedback).toBe(1);
      expect(
        upstream.mock.calls.filter(
          ([input, init]) => bearer(input, init) === "test-secondary-token",
        ),
      ).toHaveLength(1);
      expect(
        await runInDurableObject(coordinator(), (_instance, state) =>
          state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
        ),
      ).toEqual([]);
    } finally {
      release.release();
      await Promise.allSettled(follower === undefined ? [pending] : [pending, follower]);
    }
  });

  it.each([
    ["before", "revalidation"],
    ["after", "revalidation"],
    ["before", "ordinary"],
    ["after", "ordinary"],
    ["before", "public"],
    ["after", "public"],
  ])(
    "treats credential feedback failure %s in %s as infrastructure without retry or clearing state",
    async (phase, boundary) => {
      await seedPool({ secondary: true });
      if (boundary === "revalidation") {
        vi.stubGlobal(
          "fetch",
          diffUpstream(() => diffResponse()),
        );
        expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
        await expireEntries();
      }
      let writes = 0;
      const namespace = feedbackNamespace(async (_result, forward) => {
        writes++;
        if (phase === "after") await forward();
        throw new Error("Synthetic feedback acknowledgement failed");
      });
      const logs = vi.spyOn(console, "error").mockImplementation(() => {});
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        if (bearer(input, init) === "test-org-token") return jsonResponse({ private: false });
        return jsonResponse({ message: "anonymous quota exhausted" }, 429);
      });
      vi.stubGlobal("fetch", upstream);
      const response = await requestWithEnv(
        { TEST_PAT_PRIMARY: undefined, POOL_COORDINATOR: namespace },
        boundary === "public" ? "/users/octocat" : DIFF_PATH,
        boundary === "public" ? {} : diffOptions,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
      expect(writes).toBe(1);
      expect(
        upstream.mock.calls.every(
          ([input, init]) => bearer(input, init) !== "test-secondary-token",
        ),
      ).toBe(true);
      expect((await coordinator().snapshot()).cooldowns).toHaveLength(phase === "after" ? 1 : 0);
      expect((await coordinator().snapshot()).rates).toEqual([]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("TEST_PAT_PRIMARY");
      expect(
        await runInDurableObject(coordinator(), (_instance, state) =>
          state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["revalidation", "http", 98101],
    ["revalidation", "transport", 98102],
    ["revalidation", "crypto", 98103],
    ["revalidation", "denial", 98104],
    ["public", "http", 98105],
    ["public", "transport", 98106],
    ["public", "crypto", 98107],
    ["public", "denial", 98108],
    ["public", "local", 98109],
  ] as const)(
    "preserves %s acquisition ownership for %s failure",
    async (boundary, failure, installation) => {
      await seedPool({ secondary: true });
      if (boundary === "revalidation") {
        vi.stubGlobal(
          "fetch",
          diffUpstream(() => diffResponse()),
        );
        expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
        await expireEntries();
      }
      await appIdentity(installation);
      if (failure === "denial")
        await env.DB.prepare("UPDATE string_rewrite_policy SET rules_json = ?")
          .bind(JSON.stringify([{ pattern: "access_tokens", replacement: "blocked" }]))
          .run();
      const cryptoFailure =
        failure === "crypto"
          ? vi
              .spyOn(crypto.subtle, "importKey")
              .mockRejectedValue(
                new DOMException("Synthetic crypto operation failure", "OperationError"),
              )
          : undefined;
      let posts = 0;
      const resourceTokens: string[] = [];
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const token = bearer(request);
        if (token === "test-org-token") return jsonResponse({ private: false });
        if (request.method === "POST") {
          posts++;
          if (failure === "transport") throw new Error("Synthetic exchange transport failure");
          return jsonResponse({ message: "synthetic exchange failure" }, 503);
        }
        if (token !== undefined) resourceTokens.push(token);
        return jsonResponse({ message: "anonymous quota exhausted" }, 429);
      });
      vi.stubGlobal("fetch", upstream);
      const response = await requestWithEnv(
        failure === "local" ? { TEST_APP_KEY: undefined, TEST_PAT_SECONDARY: undefined } : {},
        boundary === "public" ? "/users/octocat" : DIFF_PATH,
        boundary === "public" ? {} : diffOptions,
      );
      const code =
        failure === "denial"
          ? "string_rewrite_denied"
          : boundary === "public"
            ? "fallback_local"
            : failure === "http"
              ? "github_app_token_failed"
              : "internal_error";
      expect(response.status).toBe(
        failure === "denial" ? 403 : boundary === "public" ? 424 : failure === "http" ? 502 : 500,
      );
      expect(await response.json()).toMatchObject({
        error: {
          code,
          ...(boundary === "public" && failure !== "denial"
            ? { details: { reason: "github_rate_limited" } }
            : {}),
        },
      });
      expect(posts).toBe(failure === "http" || failure === "transport" ? 1 : 0);
      if (cryptoFailure !== undefined) expect(cryptoFailure).toHaveBeenCalledOnce();
      expect(resourceTokens).toEqual([]);
      const health = await coordinator().snapshot();
      expect(health.rates).toEqual([]);
      expect(health.cooldowns).toHaveLength(failure === "local" ? 2 : 0);
      expect(
        await runInDurableObject(coordinator(), (_instance, state) =>
          state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
        ),
      ).toEqual([]);
    },
  );

  it("treats credential feedback failure missing-method inside a native request as infrastructure", async () => {
    await seedPool({ secondary: true });
    vi.stubGlobal(
      "fetch",
      diffUpstream(() => diffResponse()),
    );
    expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
    await expireEntries();
    await runInDurableObject(coordinator(), (_instance, state) =>
      state.storage.put("protocol-marker", true),
    );
    clearConfigCache();
    const upstream = diffUpstream(() => {
      throw new Error("No resource request may follow failed feedback");
    });
    vi.stubGlobal("fetch", upstream);
    const response = await ownedWork.track(
      (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL.fetch(
        "https://octopool.dev/v1/github/request",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${CALLER_TOKEN}`,
            "content-type": "application/json",
            "x-test-identity-protocol": "missing-method",
          },
          body: JSON.stringify({ pool: POOL, method: "GET", path: DIFF_PATH, ...diffOptions }),
        },
      ),
    );
    const body = await ownedWork.track(response.text());
    expect(response.bodyUsed).toBe(true);
    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "internal_error" } });
    expect(response.headers.get("x-test-feedback-calls")).toBe("1");
    expect(Number(response.headers.get("x-test-background-registered"))).toBeGreaterThan(0);
    expect(response.headers.get("x-test-background-settled")).toBe(
      response.headers.get("x-test-background-registered"),
    );
    expect(
      upstream.mock.calls.every(([input, init]) => bearer(input, init) !== "test-secondary-token"),
    ).toBe(true);
    expect(await coordinator().snapshot()).toMatchObject({ cooldowns: [], rates: [] });
    expect(
      await runInDurableObject(coordinator(), (_instance, state) =>
        state.storage.get("protocol-marker"),
      ),
    ).toBe(true);
    expect(
      await runInDurableObject(coordinator(), (_instance, state) =>
        state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
      ),
    ).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT status, error_code FROM audit_events ORDER BY rowid DESC LIMIT 1",
      ).first(),
    ).toEqual({ status: 500, error_code: "internal_error" });
  });

  it("completes the real reset and control following native missing-method feedback", async () => {
    expect(
      await runInDurableObject(coordinator(), (_instance, state) =>
        state.storage.get("protocol-marker"),
      ),
    ).toBeUndefined();
    expect(await coordinator().snapshot()).toMatchObject({ cooldowns: [], rates: [], leases: [] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first()).toEqual({
      count: 0,
    });
    await seedPool();
    vi.stubGlobal(
      "fetch",
      diffUpstream(() => diffResponse()),
    );
    expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
  });

  it("serves eligible fresh cache with no credential and live cooldown but rejects revoked scope", async () => {
    await seedPool();
    const upstream = diffUpstream(() => diffResponse());
    vi.stubGlobal("fetch", upstream);
    expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
    const before = upstream.mock.calls.map(([input, init]) => ({
      url: new Request(input, init).url,
      token: bearer(input, init),
    }));
    await coordinator().recordCredentialFailure({
      identityId: "primary",
      reason: "identity_secret_missing",
    });
    expect(
      await (
        await requestWithWarmEnv({ TEST_PAT_PRIMARY: undefined }, DIFF_PATH, diffOptions)
      ).json(),
    ).toMatchObject({ relay: { cache: "hit" }, identity: { id: "primary" } });
    const following = upstream.mock.calls
      .slice(before.length)
      .map(([input, init]) => ({ url: new Request(input, init).url, token: bearer(input, init) }));
    expect(before).toEqual([
      { url: "https://github.com/openclaw/octopool/pull/42.diff", token: undefined },
      { url: "https://api.github.com/repos/openclaw/octopool", token: "test-org-token" },
      {
        url: "https://api.github.com/repos/openclaw/octopool/pulls/42",
        token: "test-primary-token",
      },
    ]);
    // Existing revalidation/public-proof and web phases precede the identity cache scan.
    expect(following).toEqual([
      { url: "https://api.github.com/repos/openclaw/octopool", token: "test-org-token" },
      { url: "https://github.com/openclaw/octopool/pull/42.diff", token: undefined },
      { url: "https://api.github.com/repos/openclaw/octopool", token: "test-org-token" },
    ]);
    await env.DB.prepare("DELETE FROM identity_scopes WHERE identity_id = 'primary'").run();
    const route = classifyRoute(
      { pool: POOL, method: "GET", path: DIFF_PATH },
      defaultPolicy("openclaw"),
    );
    expect(await loadIdentities(env, POOL, route)).toHaveLength(1);
    expect(await (await requestWithWarmEnv({}, DIFF_PATH, diffOptions)).json()).toMatchObject({
      error: { details: { reason: "no_identity" } },
    });
  });

  it("counts multiple broken IDs once across revalidation and fill and retains the first local error", async () => {
    await seedPool({ secondary: true });
    vi.stubGlobal(
      "fetch",
      diffUpstream(() => diffResponse()),
    );
    expect((await requestWithEnv({}, DIFF_PATH, diffOptions)).status).toBe(200);
    await expireEntries();
    await env.DB.prepare(
      "UPDATE identities SET kind = 'github_app', installation_id = NULL WHERE id = 'secondary'",
    ).run();
    const calls: string[] = [];
    const namespace = feedbackNamespace(async (result, forward) => {
      calls.push(result.identityId);
      await forward();
    });
    vi.stubGlobal(
      "fetch",
      diffUpstream(() => {
        throw new Error("Broken credentials cannot dispatch");
      }),
    );
    const response = await requestWithEnv(
      { TEST_PAT_PRIMARY: undefined, POOL_COORDINATOR: namespace },
      DIFF_PATH,
      diffOptions,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "identity_secret_missing" } });
    expect(calls).toEqual(["primary", "secondary"]);
    expect((await coordinator().snapshot()).cooldowns).toHaveLength(2);
    expect((await coordinator().snapshot()).rates).toEqual([]);
    expect(
      await runInDurableObject(coordinator(), (_instance, state) =>
        state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
      ),
    ).toEqual([]);
  });

  it("rescans a late shared publication after the last local failure feedback without filtering its cache", async () => {
    await seedPool();
    const request = { pool: POOL, method: "GET" as const, path: DIFF_PATH, ...diffOptions };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const identity = (await loadIdentities(env, POOL, route, { fresh: true }))[0]!;
    const key = await githubCacheKey(POOL, request, route, identity);
    let writes = 0;
    const namespace = feedbackNamespace(async (_result, forward) => {
      writes++;
      await forward();
      expect(
        await writeGitHubCache(
          env,
          key,
          request,
          route,
          { status: 200, headers: {}, body: "late shared diff", body_encoding: "text" },
          identity,
        ),
      ).toBe("shared");
    });
    vi.stubGlobal(
      "fetch",
      diffUpstream(() => {
        throw new Error("No usable resource credential");
      }),
    );
    const response = await requestWithEnv(
      { TEST_PAT_PRIMARY: undefined, POOL_COORDINATOR: namespace },
      DIFF_PATH,
      diffOptions,
    );
    expect(await response.json()).toMatchObject({
      body: "late shared diff",
      identity: { id: "primary" },
      relay: { cache: "hit" },
    });
    expect(writes).toBe(1);
    expect((await coordinator().snapshot()).cooldowns[0]).toMatchObject({
      identity_id: "primary",
      status: 503,
    });
    expect(
      await env.DB.prepare("SELECT identity_id FROM github_cache_entries WHERE cache_key = ?")
        .bind(key)
        .first(),
    ).toEqual({ identity_id: "primary" });
  });

  it("keeps metadata cached for exactly 30 seconds independently of live credential availability", async () => {
    await seedPool();
    clearConfigCache();
    const route = classifyRoute(
      { pool: POOL, method: "GET", path: PATH },
      defaultPolicy("openclaw"),
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const missingEnv = { ...env, TEST_PAT_PRIMARY: undefined } as Env;
    expect(await loadIdentities(missingEnv, POOL, route)).toHaveLength(1);
    await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
    clock.mockReturnValue(now + 29_999);
    expect(await loadIdentities(missingEnv, POOL, route)).toHaveLength(1);
    expect(await loadIdentities(missingEnv, POOL, route, { fresh: true })).toEqual([]);
    clock.mockReturnValue(now + 30_000);
    expect(await loadIdentities(missingEnv, POOL, route)).toEqual([]);
    clock.mockRestore();
  });

  it.each([302, 404, 503])(
    "retains terminal-log probe state across a missing credential for probe %s",
    async (probeStatus) => {
      await seedPool({ secondary: true });
      const path = "/repos/openclaw/octopool/actions/jobs/42/logs";
      const key = terminalLogCacheKey({ pool: POOL, method: "GET", path });
      const createdAt = new Date(Date.now() - 3_700_000).toISOString();
      await env.ACTIONS_LOGS.put(key, "old synthetic log", {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: { "created-at": createdAt, "body-encoding": "text" },
      });
      let probes = 0;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const token = bearer(input, init);
        if (token === "test-org-token") return jsonResponse({ private: false });
        if (token === undefined) return jsonResponse({ id: 42, status: "completed" });
        expect(token).toBe("test-secondary-token");
        probes++;
        if (probes > 1)
          return new Response("refetched synthetic log", {
            headers: { "content-type": "text/plain", ...rateHeaders({ remaining: 198 }) },
          });
        if (probeStatus === 302)
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://productionresultssa0.blob.core.windows.net/actions/log.txt",
              ...rateHeaders({ remaining: 199 }),
            },
          });
        return jsonResponse({ message: "deleted" }, probeStatus, rateHeaders({ remaining: 199 }));
      });
      vi.stubGlobal("fetch", upstream);
      const response = await requestWithEnv({ TEST_PAT_PRIMARY: undefined }, path, {});
      const body = await response.json<{ identity?: unknown }>();
      expect(response.status).toBe(200);
      expect(body).toMatchObject(
        probeStatus === 404
          ? { status: 404, identity: { id: "secondary" }, body: { message: "deleted" } }
          : {
              status: 200,
              body: probeStatus === 302 ? "old synthetic log" : "refetched synthetic log",
            },
      );
      if (probeStatus === 302) expect(body.identity).toBeUndefined();
      else expect(body.identity).toMatchObject({ id: "secondary" });
      const stored = await env.ACTIONS_LOGS.get(key);
      if (probeStatus === 404) expect(stored).toBeNull();
      else {
        expect(await stored!.text()).toBe(
          probeStatus === 302 ? "old synthetic log" : "refetched synthetic log",
        );
        expect(stored!.customMetadata?.["created-at"]).not.toBe(createdAt);
      }
      const dispatched = upstream.mock.calls.filter(
        ([input, init]) =>
          bearer(input, init) !== undefined && bearer(input, init) !== "test-org-token",
      );
      expect(
        dispatched.map(([input, init]) => ({
          token: bearer(input, init),
          url: new Request(input, init).url,
          redirect: init?.redirect,
        })),
      ).toEqual(
        Array.from({ length: probeStatus === 503 ? 2 : 1 }, () => ({
          token: "test-secondary-token",
          url: `https://api.github.com${path}`,
          redirect: "manual",
        })),
      );
      expect(
        await env.DB.prepare(
          "SELECT identity_id, status FROM audit_events ORDER BY rowid DESC LIMIT 1",
        ).first(),
      ).toEqual({
        identity_id: probeStatus === 302 ? null : "secondary",
        status: probeStatus === 404 ? 404 : 200,
      });
      expect((await coordinator().snapshot()).rates).toEqual([
        expect.objectContaining({
          identity_id: "secondary",
          remaining: probeStatus === 503 ? 198 : 199,
        }),
      ]);
      expect((await coordinator().snapshot()).cooldowns[0]?.reason).toBe("identity_secret_missing");
    },
  );

  it("never splices or publishes aggregate pages when a cached App token needs a missing key mid-aggregate", async () => {
    await seedPool({ secondary: true });
    await appIdentity(95001);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let posts = 0;
    let pages = 0;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const token = bearer(request);
      if (token === "test-org-token") return jsonResponse({ private: false });
      if (token === undefined) return jsonResponse({ message: "unavailable" }, 503);
      if (request.method === "POST") {
        posts++;
        return jsonResponse({
          token: "synthetic-aggregate-app",
          expires_at: new Date(now + 61_000).toISOString(),
        });
      }
      expect(token).toBe("synthetic-aggregate-app");
      if (new URL(request.url).pathname === PATH) return jsonResponse({ private: false });
      pages++;
      clock.mockReturnValue(now + 1_000);
      return jsonResponse({
        total_count: 101,
        jobs: Array.from({ length: 100 }, (_, id) => ({ id, status: "completed" })),
      });
    });
    vi.stubGlobal("fetch", upstream);
    expect((await requestWithEnv()).status).toBe(200);
    const response = await requestWithEnv(
      { TEST_APP_KEY: undefined },
      "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      { headers: { "x-octopool-public-shape": "actions-jobs-v1" } },
    );
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "pagination_exhausted" } },
    });
    expect(posts).toBe(1);
    expect(pages).toBe(1);
    expect(
      upstream.mock.calls.filter(([input, init]) => bearer(input, init) === "test-secondary-token"),
    ).toEqual([]);
    expect(await coordinator().snapshot()).toMatchObject({ cooldowns: [], rates: [] });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM github_cache_entries WHERE route_kind = 'run_jobs'",
      ).first(),
    ).toEqual({ count: 0 });
    const request = {
      pool: POOL,
      method: "GET" as const,
      path: "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs",
      headers: { "x-octopool-public-shape": "actions-jobs-v1" },
    };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const cacheRequest = runJobsSupersetView(request, route)!.cacheRequest;
    const identities = await loadIdentities(env, POOL, route, { fresh: true });
    for (const identity of [undefined, ...identities]) {
      expect(
        await readGitHubCache(env, await githubCacheKey(POOL, cacheRequest, route, identity)),
      ).toBeUndefined();
    }
    expect(
      await runInDurableObject(coordinator(), (_instance, state) =>
        state.storage.sql.exec("SELECT * FROM cache_fills").toArray(),
      ),
    ).toEqual([]);
    clock.mockRestore();
  });

  it("keeps installation exchange egress denial hard with a healthy alternate", async () => {
    await seedPool({ secondary: true });
    await appIdentity(96001);
    await env.DB.prepare("UPDATE string_rewrite_policy SET rules_json = ?")
      .bind(JSON.stringify([{ pattern: "access_tokens", replacement: "blocked" }]))
      .run();
    const upstream = githubUpstream({ primary: jsonResponse({ private: false }) });
    vi.stubGlobal("fetch", upstream);
    const response = await requestWithEnv();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
    expect(upstream).toHaveBeenCalledOnce();
    expect((await coordinator().snapshot()).cooldowns).toEqual([]);
  });
});
