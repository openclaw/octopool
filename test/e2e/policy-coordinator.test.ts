import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { queries } from "../../src/generated/sql";
import worker from "../../src/index";
import { POLICY_SNAPSHOT_MAX_AGE_MS, policyCoordinatorStub } from "../../src/policy-coordinator";
import { CALLER_TOKEN, callWorker, POOL, relay, runWithContext, seedPool } from "./harness";
import { observePolicyD1 } from "./policy-d1-observer";
import { ownedWork } from "./owned-work";

const adminPath = "/v1/admin/string-rewrites";
const headers = { authorization: "Bearer test-admin-token", "content-type": "application/json" };
const rules = [{ pattern: "cobalt-mint", replacement: "public" }];
const read = () => callWorker(adminPath, { headers });
const put = (expected_revision = 1, nextRules = rules) =>
  callWorker(adminPath, {
    method: "PUT",
    headers,
    body: JSON.stringify({ schema_version: 1, expected_revision, rules: nextRules }),
  });

async function unavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: {
      code: "string_rewrite_policy_unavailable",
      message: "String protection policy unavailable",
    },
  });
}

describe("global policy coordinator", () => {
  it("reloads an expired snapshot exactly once for concurrent GETs", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const release = ownedWork.gate();
    let reads = 0;
    await observePolicyD1({
      before: async (sql) => {
        if (sql === queries.getStringRewritePolicy && ++reads === 2) await release.promise;
      },
    });
    expect((await read()).status).toBe(200);
    clock.mockReturnValue(now + POLICY_SNAPSHOT_MAX_AGE_MS - 1);
    expect((await read()).status).toBe(200);
    expect(reads).toBe(1);
    clock.mockReturnValue(now + POLICY_SNAPSHOT_MAX_AGE_MS);
    let finished = 0;
    const readers = Array.from({ length: 12 }, () =>
      read().then(async (response) => {
        finished++;
        expect(response.status).toBe(200);
        return response.json();
      }),
    );
    await expect.poll(() => reads).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(0);
    release.release();
    for (const snapshot of await Promise.all(readers))
      expect(snapshot).toMatchObject({ revision: 1, rules: [] });
    expect(reads).toBe(2);
  });

  it("observes an out-of-band D1 revision bump after the snapshot expires", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await (await read()).json()).toMatchObject({ revision: 1, rules: [] });
    await env.DB.prepare("UPDATE string_rewrite_policy SET revision = revision + 1, rules_json = ?")
      .bind(JSON.stringify(rules))
      .run();
    clock.mockReturnValue(now + POLICY_SNAPSHOT_MAX_AGE_MS - 1);
    expect(await (await read()).json()).toMatchObject({ revision: 1, rules: [] });
    clock.mockReturnValue(now + POLICY_SNAPSHOT_MAX_AGE_MS);
    expect(await (await read()).json()).toMatchObject({ revision: 2, rules });
    expect((await put(2, [])).status).toBe(200);
    expect(await (await read()).json()).toMatchObject({ revision: 3, rules: [] });
  });

  it("fails closed on an expired snapshot reload failure without serving the old policy", async () => {
    await seedPool();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await (await read()).json()).toMatchObject({ revision: 1, rules: [] });
    let fail = true;
    await observePolicyD1({
      before: async (sql) => {
        if (fail && sql === queries.getStringRewritePolicy) throw new Error("primary unavailable");
      },
    });
    clock.mockReturnValue(now + POLICY_SNAPSHOT_MAX_AGE_MS);
    await unavailable(await read());
    await unavailable(
      await callWorker(`/v1/pools/${POOL}/string-rewrites`, {
        headers: { authorization: `Bearer ${CALLER_TOKEN}` },
      }),
    );
    await unavailable(await relay("/repos/example/demo"));
    fail = false;
    expect(await (await read()).json()).toMatchObject({ revision: 1, rules: [] });
  });

  it("fails closed when a previously warm coordinator becomes unavailable", async () => {
    await seedPool();
    expect((await read()).status).toBe(200);
    const unavailableNamespace = new Proxy(env.POLICY_COORDINATOR, {
      get(target, key) {
        if (key === "get")
          return () => {
            throw new Error("Durable Object is overloaded");
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (const request of [
      new Request(`https://octopool.dev${adminPath}`, { headers }),
      new Request("https://octopool.dev/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ pool: POOL, method: "GET", path: "/repos/example/demo" }),
      }),
    ]) {
      await unavailable(
        await runWithContext((ctx) =>
          worker.fetch(request, { ...env, POLICY_COORDINATOR: unavailableNamespace }, ctx),
        ),
      );
    }
  });

  it("publishes the acknowledged snapshot to caller/admin GETs and relay checks across Worker entrypoints", async () => {
    await seedPool();
    expect((await read()).status).toBe(200);
    const updated = await put();
    expect(updated.status).toBe(200);
    const acknowledgement = await updated.json<{ revision: number; updated_at: string }>();
    const native = (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL;
    for (const path of [adminPath, `/v1/pools/${POOL}/string-rewrites`]) {
      const response = await native.fetch(`https://octopool.dev${path}`, {
        headers: {
          authorization: path === adminPath ? headers.authorization : `Bearer ${CALLER_TOKEN}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        schema_version: 1,
        revision: acknowledgement.revision,
        updated_at: acknowledgement.updated_at,
        rules,
      });
    }
    const response = await native.fetch("https://octopool.dev/v1/github/request", {
      method: "POST",
      headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ pool: POOL, method: "GET", path: "/repos/example/cobalt-mint" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "string_rewrite_denied" } });
  });

  it("never exposes torn snapshots while a committed PUT waits for installation", async () => {
    const old = await (await read()).json();
    let committed = false;
    const release = ownedWork.gate();
    await observePolicyD1({
      after: async (sql) => {
        if (sql === queries.replaceStringRewritePolicy) {
          committed = true;
          await release.promise;
        }
      },
    });
    const writer = put();
    await expect.poll(() => committed).toBe(true);
    let finished = 0;
    const readers = Array.from({ length: 12 }, () =>
      read().then(async (response) => {
        finished++;
        expect(response.status).toBe(200);
        return response.json();
      }),
    );
    // Let the real DO receive overlapping requests while its update gate is held.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(0);
    release.release();
    const response = await writer;
    expect(response.status).toBe(200);
    const acknowledgement = await response.json<{ revision: number; updated_at: string }>();
    const next = {
      schema_version: 1,
      revision: acknowledgement.revision,
      updated_at: acknowledgement.updated_at,
      rules,
    };
    for (const snapshot of await Promise.all(readers)) expect([old, next]).toContainEqual(snapshot);
    expect(await (await read()).json()).toEqual(next);
  });

  it("reloads the committed revision from the primary after eviction", async () => {
    expect((await put()).status).toBe(200);
    await evictDurableObject(policyCoordinatorStub(env));
    let reads = 0;
    await observePolicyD1({
      before: async (sql) => {
        if (sql === queries.getStringRewritePolicy) reads++;
      },
    });
    expect(await (await read()).json()).toMatchObject({ revision: 2, rules });
    expect(reads).toBe(1);
  });

  it("fails closed on cold D1 failure and retries initialization without retaining a rejected promise", async () => {
    await seedPool();
    let fail = true;
    let reads = 0;
    await observePolicyD1({
      before: async (sql) => {
        if (sql === queries.getStringRewritePolicy) {
          reads++;
          if (fail) throw new Error("D1 DB is overloaded. Requests queued for too long.");
        }
      },
    });
    await unavailable(await read());
    await unavailable(await relay("/repos/example/demo"));
    fail = false;
    const responses = await Promise.all(Array.from({ length: 8 }, read));
    for (const response of responses)
      expect(await response.json()).toMatchObject({ revision: 1, rules: [] });
    expect(reads).toBe(3);
  });

  it("preserves D1 CAS conflicts even when the conditional SQL finds no matching revision", async () => {
    await observePolicyD1({
      before: async (sql) => {
        if (sql === queries.replaceStringRewritePolicy)
          await env.DB.prepare("UPDATE string_rewrite_policy SET revision = revision + 1").run();
      },
    });
    const response = await put();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "string_rewrite_revision_conflict" },
    });
    expect(await (await read()).json()).toMatchObject({ revision: 2, rules: [] });
  });

  it.each(["lost D1 acknowledgement", "snapshot installation"] as const)(
    "discards the old revision after commit followed by failed %s",
    async (failure) => {
      await seedPool();
      expect(await (await read()).json()).toMatchObject({ revision: 1 });
      let failReads = true;
      await observePolicyD1({
        before: async (sql) => {
          if (failReads && sql === queries.getStringRewritePolicy)
            throw new Error("primary unavailable");
        },
        after: async (sql) => {
          if (sql === queries.replaceStringRewritePolicy && failure === "lost D1 acknowledgement")
            throw new Error("committed but acknowledgement lost");
        },
      });
      if (failure === "snapshot installation") {
        await runInDurableObject(policyCoordinatorStub(env), (instance) => {
          const internal = instance as unknown as { snapshot: unknown };
          let snapshot = internal.snapshot;
          Object.defineProperty(internal, "snapshot", {
            configurable: true,
            get: () => snapshot,
            set(value: unknown) {
              if (value !== undefined) {
                Object.defineProperty(internal, "snapshot", {
                  configurable: true,
                  writable: true,
                  value: undefined,
                });
                throw new Error("synthetic install failure after commit");
              }
              snapshot = value;
            },
          });
        });
      }
      await unavailable(await put());
      expect(await env.DB.prepare("SELECT revision FROM string_rewrite_policy").first()).toEqual({
        revision: 2,
      });
      await unavailable(await read());
      await unavailable(await relay("/repos/example/demo"));
      failReads = false;
      expect(await (await read()).json()).toMatchObject({ revision: 2, rules });
      expect((await relay("/repos/example/cobalt-mint")).status).toBe(403);
      expect((await put()).status).toBe(409);
    },
  );

  it("retains committed policy when a caller discards the PUT response", async () => {
    const response = await put();
    await response.body?.cancel();
    expect(await (await read()).json()).toMatchObject({ revision: 2, rules });
    await evictDurableObject(policyCoordinatorStub(env));
    expect(await (await read()).json()).toMatchObject({ revision: 2, rules });
    expect((await put()).status).toBe(409);
  });

  it("serves 20 relay requests and policy GETs with one primary policy SELECT while warm", async () => {
    await seedPool();
    let reads = 0;
    await observePolicyD1({
      before: async (sql) => {
        if (sql === queries.getStringRewritePolicy) reads++;
      },
    });
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ private: false, full_name: "example/demo" }),
    );
    vi.stubGlobal("fetch", upstream);
    for (let i = 0; i < 20; i++) {
      expect((await relay("/repos/example/demo")).status).toBe(200);
      const response = await callWorker(`/v1/pools/${POOL}/string-rewrites`, {
        headers: { authorization: `Bearer ${CALLER_TOKEN}` },
      });
      expect(await response.json()).toMatchObject({ revision: 1, rules: [] });
    }
    expect(reads).toBe(1);
    console.log(
      `Policy warm-read proof: 20 relay requests + 20 caller GETs; D1 policy SELECTs=${reads}`,
    );
  });
});
