import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { hashToken } from "../../src/auth";
import { backendAdmissionStub } from "../../src/backend-admission";
import worker from "../../src/index";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import {
  CALLER_TOKEN,
  POOL,
  bearer,
  callWorker,
  githubUpstream,
  jsonResponse,
  relay,
  runWithContext,
  seedPool,
} from "./harness";
import { ownedWork } from "./owned-work";
import { requestWithEnv } from "./identity-routing-support";

const path = (id: number) => `/repos/openclaw/octopool/check-runs/${id}/annotations`;
const admission = () => backendAdmissionStub(env, POOL);
const client = JSON.stringify(["caller", "test-mac"]);
afterEach(() => vi.useRealTimers());

async function permitRows() {
  return runInDurableObject(admission(), (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM backend_permits").toArray(),
  );
}

async function addToken(id: string, name: string) {
  await env.DB.prepare(
    "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES (?, 'caller', ?, ?)",
  )
    .bind(id, await hashToken(id), name)
    .run();
}

it.each(["anonymous", "identity"])(
  "admits six %s misses, denies exactly one, and exempts warm hits and a second client",
  async (backend) => {
    await seedPool();
    await addToken("other-token", "other-mac");
    const gate = ownedWork.gate();
    let entered = 0;
    const normal = githubUpstream({ primary: jsonResponse([]) });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const match = /check-runs\/(\d+)\/annotations$/.exec(request.url);
        const serves = backend === "anonymous" || bearer(request) === "test-primary-token";
        if (match && serves) {
          if (Number(match[1]) < 100) {
            entered++;
            await gate.promise;
          }
          return jsonResponse([]);
        }
        return normal(input, init);
      }),
    );
    expect((await relay(path(100))).status).toBe(200);
    const completed: Response[] = [];
    const requests = Array.from({ length: 7 }, (_, i) =>
      relay(path(i + 1)).then((response) => {
        completed.push(response);
        return response;
      }),
    );
    try {
      await expect.poll(() => entered).toBe(6);
      await expect.poll(() => completed.length).toBe(1);
      expect(completed[0]!.status).toBe(424);
      expect(await completed[0]!.clone().json()).toMatchObject({
        error: { code: "fallback_local", details: { reason: "relay_overloaded" } },
      });
      const hit = await relay(path(100));
      expect(hit.status).toBe(200);
      expect(await hit.json()).toMatchObject({ relay: { cache: "hit" } });
      expect(
        (await relay(path(100), CALLER_TOKEN, { headers: { "cache-control": "max-age=0" } }))
          .status,
      ).toBe(424);
      expect(
        (
          await relay(path(100), CALLER_TOKEN, {
            headers: { "if-none-match": '"caller-validator"' },
          })
        ).status,
      ).toBe(424);
      expect((await relay(path(101), "other-token")).status).toBe(200);
      await env.DB.prepare(
        "UPDATE caller_tokens SET token_hash = ? WHERE id = 'caller-client-token'",
      )
        .bind(await hashToken("rotated-token"))
        .run();
      expect((await relay(path(102), "rotated-token")).status).toBe(424);
      expect(await permitRows()).toHaveLength(6);
      const denied = await env.DB.prepare(
        "SELECT caller_token_id, client_name, fallback_reason FROM audit_events WHERE error_code = 'fallback_local' ORDER BY caller_token_id",
      ).all();
      expect(denied.results).toEqual([
        {
          caller_token_id: "caller-client-token",
          client_name: "test-mac",
          fallback_reason: "relay_overloaded",
        },
        {
          caller_token_id: "caller-client-token",
          client_name: "test-mac",
          fallback_reason: "relay_overloaded",
        },
        {
          caller_token_id: "caller-client-token",
          client_name: "test-mac",
          fallback_reason: "relay_overloaded",
        },
        {
          caller_token_id: "caller-client-token",
          client_name: "test-mac",
          fallback_reason: "relay_overloaded",
        },
      ]);
      const stats = await callWorker(`/v1/pools/${POOL}/stats?client=test-mac`, {
        headers: { authorization: "Bearer rotated-token" },
      });
      expect(await stats.json()).toMatchObject({
        client_usage: { fallbacks: 4 },
        fallback_reasons: expect.arrayContaining([
          expect.objectContaining({ reason: "relay_overloaded", requests: 4 }),
        ]),
      });
      console.log(
        `admission ${backend}: 7 misses -> 6 admitted + 1 relay_overloaded; warm hit=200; second client=200; rotated token=424; audit/stats attributed`,
      );
    } finally {
      gate.release();
      await Promise.all(requests);
    }
    expect(completed.filter((response) => response.status === 200)).toHaveLength(6);
    expect(await permitRows()).toHaveLength(0);
  },
);

it("honors the configured client cap and releases slots after backend failure", async () => {
  await seedPool();
  expect(await admission().acquire("one", client, 2)).toBe(true);
  expect(await admission().acquire("two", client, 2)).toBe(true);
  const upstream = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic backend failure"));
  vi.stubGlobal("fetch", upstream);
  expect((await requestWithEnv({ CLIENT_BACKEND_CONCURRENCY: "2" }, path(1), {})).status).toBe(424);
  expect(upstream).not.toHaveBeenCalled();
  await admission().release("two");
  await requestWithEnv({ CLIENT_BACKEND_CONCURRENCY: "2" }, path(1), {});
  expect(upstream).toHaveBeenCalled();
  expect(await permitRows()).toHaveLength(1);
});

it("fails closed on a lost grant acknowledgement and cleans up the committed permit", async () => {
  await seedPool();
  const real = admission();
  const namespace = {
    idFromName: env.BACKEND_ADMISSION.idFromName.bind(env.BACKEND_ADMISSION),
    get: () => ({
      acquire: async (id: string, key: string, limit: number) => {
        expect(await real.acquire(id, key, limit)).toBe(true);
        throw new Error("synthetic lost grant acknowledgement");
      },
      release: (id: string) => real.release(id),
    }),
  };
  const upstream = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", upstream);
  const response = await requestWithEnv({ BACKEND_ADMISSION: namespace }, path(1), {});
  expect(response.status).toBe(424);
  expect(await response.json()).toMatchObject({
    error: { details: { reason: "relay_overloaded" } },
  });
  expect(upstream).not.toHaveBeenCalled();
  expect(await permitRows()).toHaveLength(0);
});

it("keeps admission independent of the pool object's publication gate", async () => {
  const gate = ownedWork.gate();
  let blocked = false;
  const held = ownedWork.track(
    runInDurableObject(poolCoordinatorStub(env, POOL), (_instance, state) =>
      state.blockConcurrencyWhile(async () => {
        blocked = true;
        await gate.promise;
      }),
    ),
  );
  try {
    await expect.poll(() => blocked).toBe(true);
    expect(await admission().acquire("first", client, 1)).toBe(true);
    expect(await admission().acquire("second", client, 1)).toBe(false);
    expect(await admission().acquire("other", "other-client", 1)).toBe(true);
    console.log("publication gate held: independent admission grants/denials complete");
  } finally {
    gate.release();
    await held;
  }
});

it("preserves live counts across DO eviction and expires abandoned permits without a permanent leak", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  expect(await admission().acquire("abandoned", client, 1)).toBe(true);
  expect(await admission().acquire("abandoned", client, 1)).toBe(true);
  expect(await permitRows()).toHaveLength(1);
  await evictDurableObject(admission());
  expect(await admission().acquire("new", client, 1)).toBe(false);
  vi.setSystemTime(start + 30_001);
  expect(await admission().renew("abandoned")).toBe(false);
  expect(await admission().acquire("new", client, 1)).toBe(true);
  await admission().release("abandoned");
  expect(await permitRows()).toHaveLength(1);
  await admission().release("new");
  await admission().release("new");
  expect(await permitRows()).toHaveLength(0);
  console.log(
    "DO eviction: live cap preserved; orphan reclaimed at 30s; late/double release cannot delete replacement",
  );
});

it("renews only live permits and never extends the durable 60-second deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  expect(await admission().acquire("long", client, 1)).toBe(true);
  for (const elapsed of [20_000, 40_000, 59_999]) {
    vi.setSystemTime(start + elapsed);
    expect(await admission().renew("long")).toBe(true);
  }
  await evictDurableObject(admission());
  vi.setSystemTime(start + 60_000);
  expect(await admission().renew("long")).toBe(false);
  expect(await admission().acquire("next", client, 1)).toBe(true);
});

it.each([false, true])(
  "cancels an upstream request and reclaims its permit (lost release=%s)",
  async (lostRelease) => {
    await seedPool();
    const controller = new AbortController();
    let entered = false;
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        entered = true;
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init!.signal!.reason);
            },
            { once: true },
          );
        });
      }),
    );
    const real = admission();
    const namespace = {
      idFromName: env.BACKEND_ADMISSION.idFromName.bind(env.BACKEND_ADMISSION),
      get: () => ({
        acquire: (id: string, key: string, limit: number) => real.acquire(id, key, limit),
        renew: (id: string) => real.renew(id),
        release: async (id: string) => {
          if (lostRelease) throw new Error("synthetic lost release");
          await real.release(id);
        },
      }),
    } as unknown as Env["BACKEND_ADMISSION"];
    const response = runWithContext((ctx) =>
      worker.fetch(
        new Request("https://octopool.dev/v1/github/request", {
          method: "POST",
          signal: controller.signal,
          headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ pool: POOL, method: "GET", path: path(1) }),
        }),
        { ...env, BACKEND_ADMISSION: namespace },
        ctx,
      ),
    );
    try {
      await expect.poll(() => entered).toBe(true);
      expect(await permitRows()).toHaveLength(1);
    } finally {
      controller.abort();
      await response;
    }
    expect(aborted).toBe(true);
    expect((await response).status).toBe(424);
    expect(await permitRows()).toHaveLength(lostRelease ? 1 : 0);
    if (lostRelease) {
      await evictDurableObject(admission());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 30_001);
      expect(await admission().acquire("replacement", client, 1)).toBe(true);
      expect(await permitRows()).toHaveLength(1);
    }
    console.log(
      `abort: upstream cancelled; ${lostRelease ? "lost release recovered by durable expiry after restart" : "permit released immediately"}`,
    );
  },
);
