import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import type { RecordResult } from "../../src/types";
import {
  bearer,
  CALLER_TOKEN,
  jsonResponse,
  POOL,
  relay,
  runWithContext,
  seedPool,
} from "./harness";
import { ownedWork } from "./owned-work";

const PATH = "/repos/openclaw/octopool";
const conditional = { headers: { "if-none-match": '"feedback"' } };
const headers = (remaining: number, reset: number) => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(reset),
  // The trusted route still owns the core bucket.
  "x-ratelimit-resource": "search",
});

describe("Worker feedback ownership", () => {
  it.each([
    { window: "same", status: 200 },
    { window: "older future", status: 304 },
    { window: "older expired", status: 200 },
  ])(
    "does not reopen exhaustion after overlapping $window $status feedback",
    async ({ window, status }) => {
      await seedPool();
      const reset = Math.floor(Date.now() / 1000) + 3600;
      const delayedReset =
        window === "same" ? reset : window === "older future" ? reset - 60 : reset - 3601;
      const started = ownedWork.gate();
      const delayed = ownedWork.gate();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          expect(bearer(request)).toBe("test-primary-token");
          expect(request.headers.get("if-none-match")).toBe('"feedback"');
          calls++;
          if (calls === 1) {
            started.release();
            await delayed.promise;
            return status === 304
              ? new Response(null, { status: 304, headers: headers(4999, delayedReset) })
              : jsonResponse({ id: "delayed" }, 200, headers(4999, delayedReset));
          }
          return jsonResponse({ id: "exhausted" }, 200, headers(0, reset));
        }),
      );
      const pending = relay(PATH, undefined, conditional);
      try {
        await started.promise;
        const exhausted = await relay(PATH, undefined, conditional);
        expect(exhausted.status).toBe(200);
        expect(await exhausted.json()).toMatchObject({
          body: { id: "exhausted" },
          identity: { id: "primary" },
          relay: { cache: "bypass" },
        });
        const stub = poolCoordinatorStub(env, POOL);
        expect((await stub.snapshot()).rates).toEqual([
          {
            identity_id: "primary",
            resource: "core",
            limit_count: 5000,
            remaining: 0,
            reset_at: reset * 1000,
          },
        ]);
        delayed.release();
        expect(await (await pending).json()).toMatchObject({ status, identity: { id: "primary" } });
        const next = await relay(PATH, undefined, conditional);
        expect(next.status).toBe(424);
        expect(await next.json()).toMatchObject({
          error: { code: "fallback_local", details: { reason: "identities_cooling_down" } },
        });
        expect(calls).toBe(2);
        expect((await stub.snapshot()).rates[0]).toMatchObject({
          resource: "core",
          remaining: 0,
          reset_at: reset * 1000,
        });
        expect(
          (
            await stub.selectIdentity({
              routeKey: "other",
              resource: "search",
              candidates: [{ id: "primary", weight: 200 }],
            })
          ).kind,
        ).toBe("selected");
      } finally {
        delayed.release();
        await Promise.allSettled([pending]);
      }
    },
  );

  it.each(["before", "after"])(
    "does not compensate or retry when feedback acknowledgement fails %s forwarding",
    async (phase) => {
      await seedPool({ secondary: true });
      const stub = poolCoordinatorStub(env, POOL);
      const reset = Math.floor(Date.now() / 1000) + 3600;
      await stub.recordResult({
        identityId: "primary",
        routeKey: "unrelated",
        resource: "core",
        status: 200,
        rate: { remaining: 6000, resetAt: reset },
      });
      let writes = 0;
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          expect(bearer(request)).toBe("test-primary-token");
          calls++;
          return jsonResponse({ message: "limited" }, 429, {
            ...headers(0, reset),
            "retry-after": "3600",
          });
        }),
      );
      const namespace = new Proxy(env.POOL_COORDINATOR, {
        get(target, key) {
          if (key === "get")
            return () =>
              new Proxy(stub, {
                get(real, method) {
                  if (method === "recordResult")
                    return async (result: RecordResult) => {
                      writes++;
                      if (phase === "after") await real.recordResult(result);
                      throw new Error("synthetic acknowledgement lost");
                    };
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
      const response = await runWithContext((ctx) =>
        worker.fetch(
          new Request("https://octopool.dev/v1/github/request", {
            method: "POST",
            headers: {
              authorization: `Bearer ${CALLER_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ pool: POOL, method: "GET", path: PATH, ...conditional }),
          }),
          { ...env, POOL_COORDINATOR: namespace },
          ctx,
        ),
      );
      expect(response.status).toBe(500);
      expect(writes).toBe(1);
      expect(calls).toBe(1);
      const snapshot = await stub.snapshot();
      expect(snapshot.rates).toEqual([
        {
          identity_id: "primary",
          resource: "core",
          limit_count: 5000,
          remaining: phase === "after" ? 0 : 6000,
          reset_at: reset * 1000,
        },
      ]);
      expect(snapshot.cooldowns).toHaveLength(phase === "after" ? 1 : 0);
      if (phase === "after") {
        expect(snapshot.cooldowns[0]).toMatchObject({ route_key: "*", status: 429 });
        expect(
          (
            await stub.selectIdentity({
              routeKey: "fresh",
              resource: "core",
              candidates: [{ id: "primary", weight: 200 }],
            })
          ).kind,
        ).toBe("unavailable");
      }
    },
  );

  it("keeps anonymous API feedback outside identity budgets", async () => {
    await seedPool();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(bearer(input, init)).toBeUndefined();
      return jsonResponse({ private: false }, 200, headers(0, reset));
    });
    vi.stubGlobal("fetch", upstream);
    expect((await relay(PATH)).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect((await poolCoordinatorStub(env, POOL).snapshot()).rates).toEqual([]);
    expect(await env.DB.prepare("SELECT remaining FROM github_public_api_rates").first()).toEqual({
      remaining: 0,
    });
  });

  it.each([201, 429])(
    "does not attribute App token-exchange %s rates to installation quota",
    async (status) => {
      await seedPool();
      await env.DB.prepare(
        "UPDATE identities SET kind = 'github_app', secret_ref = 'TEST_APP_KEY', installation_id = ? WHERE id = 'primary'",
      )
        .bind(987_000 + status)
        .run();
      const reset = Math.floor(Date.now() / 1000) + 3600;
      let exchanges = 0;
      let resourceCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          if (request.method === "POST") {
            exchanges++;
            return jsonResponse(
              {
                token: "synthetic-installation",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
              status,
              { ...headers(0, reset), "retry-after": "3600" },
            );
          }
          expect(bearer(request)).toBe("synthetic-installation");
          resourceCalls++;
          return jsonResponse({ private: false });
        }),
      );
      expect((await relay(PATH, undefined, conditional)).status).toBe(status === 201 ? 200 : 502);
      expect(exchanges).toBe(1);
      expect(resourceCalls).toBe(status === 201 ? 1 : 0);
      const snapshot = await poolCoordinatorStub(env, POOL).snapshot();
      expect(snapshot.rates).toEqual([]);
      expect(snapshot.cooldowns).toEqual([]);
    },
  );
});
