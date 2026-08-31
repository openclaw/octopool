import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import {
  CACHE_PUBLICATION_EPOCH,
  bodyPublicationResource,
  publicationBinding,
  tryPublicationOwner,
  type PublicationOwner,
} from "../../src/cache-publication";
import {
  githubCacheKey,
  writeGitHubCache,
  readGitHubCache,
  readStaleGitHubCache,
} from "../../src/cache";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { queries } from "../../src/generated/sql";
import { POOL, seedPool } from "./harness";
import { ownedWork } from "./owned-work";
import { observePublicationD1 } from "./publication-d1-observer";
import { storePublicRepoProof } from "../../src/public-repos";
import { sqliteTimestamp } from "../../src/sqlite-time";
import { runScheduledMaintenance } from "../../src/maintenance";
import { acquireOwnedCacheFill } from "../../src/cache-fill";

const request = { pool: POOL, method: "GET" as const, path: "/repos/openclaw/octopool/issues/42" };
const route = classifyRoute(request, defaultPolicy("openclaw"));
const response = { status: 200, headers: {}, body: "observed" };
const coordinator = () => poolCoordinatorStub(env, POOL);

it.each(["expiry", "replacement", "GC", "completed", "replay"])(
  "rejects absent-body insertion after %s",
  async (mode) => {
    await seedPool();
    const key = await githubCacheKey(POOL, request, route);
    const a = (await coordinator().tryAcquirePublication(bodyPublicationResource(key)))!;
    if (mode === "completed") {
      expect(await coordinator().completePublication(a, "shared")).toBe(true);
    } else {
      await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
      if (mode === "GC" || mode === "replay")
        await env.DB.prepare(queries.deleteExpiredPublicationOwners).bind(16).all();
      if (mode === "replacement")
        expect((await coordinator().tryAcquirePublication(a.resource_key))!.id).toBeGreaterThan(
          a.id,
        );
      if (mode === "replay") {
        const replay = await env.DB.prepare(queries.acquirePublicationOwner)
          .bind(CACHE_PUBLICATION_EPOCH, a.resource_key, a.owner_token, 8_000)
          .first<PublicationOwner>();
        expect(replay!.id).toBeGreaterThan(a.id);
        expect(await coordinator().renewPublication(a)).toBe(false);
        expect(await coordinator().completePublication(a, "shared")).toBe(false);
        expect(await coordinator().completePublication(a, "failed")).toBe(false);
      }
    }
    expect(await writeGitHubCache(env, key, request, route, response, a)).toBe("rejected");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(
      0,
    );
    expect(
      await env.DB.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
      ).first<number>("seq"),
    ).toBeGreaterThanOrEqual(a.id);
  },
);

it("survives actual DO eviction while an external D1 write is held before execution", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const a = (await coordinator().tryAcquirePublication(bodyPublicationResource(key)))!;
  const gate = ownedWork.gate();
  let entered = false;
  const db = observePublicationD1(env.DB, {
    before: async (sql) => {
      if (sql === queries.writeGitHubCache) {
        entered = true;
        await gate.promise;
      }
    },
  });
  const pending = ownedWork.track(
    writeGitHubCache({ ...env, DB: db }, key, request, route, response, a),
  );
  try {
    await expect.poll(() => entered).toBe(true);
    await evictDurableObject(coordinator());
    expect(await coordinator().tryAcquirePublication(a.resource_key)).toBeUndefined();
    await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
    const b = (await coordinator().tryAcquirePublication(a.resource_key))!;
    expect(b.id).toBeGreaterThan(a.id);
    expect(
      await writeGitHubCache(env, key, request, route, { ...response, body: "replacement" }, b),
    ).toBe("shared");
    await coordinator().completePublication(b, "shared");
    gate.release();
    expect(await pending).toBe("rejected");
    expect((await readGitHubCache(env, key))?.body).toBe("replacement");
  } finally {
    gate.release();
    await pending;
  }
});

it("recovers an exact committed receipt after a lost SQL acknowledgment and preserves partial edge failure", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const a = (await coordinator().tryAcquirePublication(bodyPublicationResource(key)))!;
  const actual = caches.default;
  vi.stubGlobal("caches", {
    default: {
      match: actual.match.bind(actual),
      delete: actual.delete.bind(actual),
      put: async () => {
        throw new Error("synthetic edge failure");
      },
    },
  });
  const db = observePublicationD1(env.DB, {
    after: async (sql) => {
      if (sql === queries.writeGitHubCache) throw new Error("ack lost after commit");
    },
  });
  expect(await writeGitHubCache({ ...env, DB: db }, key, request, route, response, a)).toBe(
    "shared",
  );
  expect(await coordinator().completePublication(a, "shared")).toBe(true);
  expect((await readGitHubCache(env, key))?.body).toBe(response.body);
});

it("does not convert an uncertain acquisition into a grant or ownerless body fill", async () => {
  const observed: string[] = [];
  const db = observePublicationD1(env.DB, {
    after: async (sql) => {
      observed.push(sql);
      if (sql === queries.acquirePublicationOwner)
        throw new Error("lost committed grant acknowledgment");
    },
  });
  await expect(tryPublicationOwner({ ...env, DB: db }, "cache:abandoned")).rejects.toThrow(
    "lost committed grant",
  );
  expect(observed).toEqual([
    queries.deleteExpiredPublicationOwners,
    queries.acquirePublicationOwner,
  ]);
  expect(await coordinator().tryAcquirePublication("cache:abandoned")).toBeUndefined();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM github_cache_entries").first("n")).toBe(0);
});

it("keeps shared storage distinct from a lost completion acknowledgment", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const real = coordinator();
  const acquired = await acquireOwnedCacheFill(
    {
      acquirePublication: (resource) => real.acquirePublication(resource),
      tryAcquirePublication: (resource) => real.tryAcquirePublication(resource),
      renewPublication: (capability) => real.renewPublication(capability),
      completePublication: async (capability, outcome, publicationId) => {
        await real.completePublication(capability, outcome, publicationId);
        throw new Error("synthetic lost completion acknowledgment");
      },
    },
    bodyPublicationResource(key),
  );
  expect(acquired.kind).toBe("owner");
  if (acquired.kind !== "owner") return;
  try {
    expect(
      await acquired.owner.publish(() =>
        writeGitHubCache(env, key, request, route, response, acquired.owner.capability),
      ),
    ).toEqual({ storage: "shared", completion: "unknown" });
    expect((await readGitHubCache(env, key))?.body).toBe("observed");
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM cache_publication_owners").first("n"),
    ).toBe(0);
  } finally {
    await acquired.owner.fail();
  }
});

it("records actual native statement and row costs for short body fill, contention and abandoned-owner backlog", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const costs: { query: string; read: number; written: number }[] = [];
  const db = observePublicationD1(env.DB, {
    after: async (sql, _values, result) => {
      costs.push({
        query: Object.entries(queries).find(([, query]) => query === sql)?.[0] ?? "fixture",
        read: result.meta.rows_read,
        written: result.meta.rows_written,
      });
    },
  });
  const traced = { ...env, DB: db };
  const a = (await tryPublicationOwner(traced, bodyPublicationResource(key)))!;
  await db
    .prepare(queries.renewPublicationOwner)
    .bind(...publicationBinding(a), 8_000)
    .first();
  expect(await writeGitHubCache(traced, key, request, route, response, a)).toBe("shared");
  await db
    .prepare(queries.completePublicationOwner)
    .bind(...publicationBinding(a))
    .first();
  expect(costs.map(({ query }) => query)).toEqual([
    "deleteExpiredPublicationOwners",
    "acquirePublicationOwner",
    "renewPublicationOwner",
    "writeGitHubCache",
    "completePublicationOwner",
  ]);
  console.log("native short body SQL costs (4 binding operations, 5 statements)", costs);
  costs.length = 0;
  const publicOwner = (await tryPublicationOwner(traced, "public-repo:openclaw/octopool"))!;
  await db
    .prepare(queries.renewPublicationOwner)
    .bind(...publicationBinding(publicOwner), 8_000)
    .first();
  expect(
    await storePublicRepoProof(
      traced,
      "openclaw",
      "octopool",
      true,
      sqliteTimestamp(Date.now()),
      publicOwner,
    ),
  ).toBe("shared");
  await db
    .prepare(queries.completePublicationOwner)
    .bind(...publicationBinding(publicOwner))
    .first();
  expect(costs).toHaveLength(5);
  console.log("native anonymous proof SQL costs (4 binding operations, 5 statements)", costs);
  costs.length = 0;
  for (let i = 0; i < 33; i++) await coordinator().tryAcquirePublication(`cache:abandoned-${i}`);
  await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
  const backlog: number[] = [];
  for (let i = 0; i < 3; i++) {
    await tryPublicationOwner(traced, "cache:busy");
    backlog.push(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM cache_publication_owners WHERE lease_until_ms = 0",
      ).first<number>("n"))!,
    );
  }
  expect(backlog).toEqual([17, 1, 0]);
  expect(costs.filter(({ query }) => query === "deleteExpiredPublicationOwners")).toHaveLength(3);
  console.log("native acquisition-scaled GC and busy cost", { backlog, costs });
});

it("measures a real renewable fill through DO RPC and native SQL", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  type Cost = { query: string; read: number; written: number };
  type ObservedDO = { env: Env; originalEnv: Env; publicationCosts: Cost[] };
  const stub = coordinator();
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as ObservedDO;
    target.originalEnv = target.env;
    target.publicationCosts = [];
    target.env = {
      ...target.env,
      DB: observePublicationD1(target.env.DB, {
        after: async (sql, _values, result) => {
          target.publicationCosts.push({
            query: Object.entries(queries).find(([, value]) => value === sql)![0],
            read: result.meta.rows_read,
            written: result.meta.rows_written,
          });
        },
      }),
    };
  });
  const acquired = await acquireOwnedCacheFill(stub, bodyPublicationResource(key));
  expect(acquired.kind).toBe("owner");
  if (acquired.kind !== "owner") throw new Error("Native measurement grant missing");
  const bodyCosts: Cost[] = [];
  const traced = {
    ...env,
    DB: observePublicationD1(env.DB, {
      after: async (sql, _values, result) => {
        bodyCosts.push({
          query: Object.entries(queries).find(([, value]) => value === sql)![0],
          read: result.meta.rows_read,
          written: result.meta.rows_written,
        });
      },
    }),
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    expect(
      await acquired.owner.publish(() =>
        writeGitHubCache(traced, key, request, route, response, acquired.owner.capability),
      ),
    ).toEqual({ storage: "shared", completion: "accepted" });
    const coordinatorCosts = await runInDurableObject(
      stub,
      (instance) => (instance as unknown as ObservedDO).publicationCosts,
    );
    const costs = [...coordinatorCosts, ...bodyCosts];
    expect(
      costs.filter(({ query }) => query === "renewPublicationOwner").length,
    ).toBeGreaterThanOrEqual(2);
    expect(costs.filter(({ query }) => query === "writeGitHubCache")).toHaveLength(1);
    console.log("native renewable fill measured SQL", {
      statements: costs.length,
      bindingOperations: costs.length - 1,
      costs,
    });
  } finally {
    await acquired.owner.fail();
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as ObservedDO;
      target.env = target.originalEnv;
    });
  }
});

it("drains only expired legacy fills in the contacted DO during mixed deployment", async () => {
  await runInDurableObject(coordinator(), (_instance, state) => {
    for (let i = 0; i < 18; i++)
      state.storage.sql.exec("INSERT INTO cache_fills VALUES (?, 'old', 0)", `old-${i}`);
    state.storage.sql.exec(
      "INSERT INTO cache_fills VALUES ('live', 'live', ?)",
      Date.now() + 60_000,
    );
    state.storage.sql.exec(
      "INSERT INTO leases VALUES ('identity', 'identity', ?)",
      Date.now() + 60_000,
    );
  });
  await coordinator().tryAcquirePublication("cache:new");
  const snapshot = await runInDurableObject(coordinator(), (_instance, state) => ({
    fills: state.storage.sql.exec("SELECT cache_key FROM cache_fills").toArray(),
    leases: state.storage.sql.exec("SELECT * FROM leases").toArray(),
  }));
  expect(snapshot.fills).toHaveLength(3);
  expect(snapshot.fills).toContainEqual({ cache_key: "live" });
  expect(snapshot.leases).toHaveLength(1);
});

it("renews before GC atomically, but cannot renew after GC wins", async () => {
  const a = (await coordinator().tryAcquirePublication("cache:renew-gc"))!;
  expect(await coordinator().renewPublication(a)).toBe(true);
  expect(
    (await env.DB.prepare(queries.deleteExpiredPublicationOwners).bind(16).all()).results,
  ).toEqual([]);
  await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
  expect(
    (await env.DB.prepare(queries.deleteExpiredPublicationOwners).bind(16).all()).results,
  ).toHaveLength(1);
  expect(await coordinator().renewPublication(a)).toBe(false);
});

it("uses periodic maintenance for idle abandoned owners without cascading into live payloads", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const a = (await coordinator().tryAcquirePublication(bodyPublicationResource(key)))!;
  expect(await writeGitHubCache(env, key, request, route, response, a)).toBe("shared");
  await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
  await runScheduledMaintenance(env);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM cache_publication_owners").first("n"),
  ).toBe(0);
  expect((await readGitHubCache(env, key))?.body).toBe("observed");
  expect(
    await env.DB.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
    ).first("seq"),
  ).toBe(a.id);
});

it("refuses old unfenced body writes on fresh and stale reads", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  await env.DB.prepare(
    "INSERT INTO github_cache_entries (cache_key,pool_id,method,path,query_json,headers_json,route_key,route_kind,status,response_headers_json,body_json,body_encoding,expires_at,stale_expires_at) VALUES (?,?,'GET',?,'{}','{}',?,'issue_view',200,'{}','\"legacy\"','json',datetime('now','+1 hour'),datetime('now','+2 hours'))",
  )
    .bind(key, POOL, request.path, route.routeKey)
    .run();
  expect(await readGitHubCache(env, key)).toBeUndefined();
  expect(await readStaleGitHubCache(env, key, route)).toBeUndefined();
});

it("rejects expired immutable evidence under a still-live owner and does not republish different evidence under the same receipt", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const a = (await coordinator().tryAcquirePublication(bodyPublicationResource(key)))!;
  const observedAt = Date.now();
  expect(
    await writeGitHubCache(
      env,
      key,
      request,
      route,
      response,
      a,
      undefined,
      observedAt - 3_600_000,
    ),
  ).toBe("rejected");
  expect(await writeGitHubCache(env, key, request, route, response, a, undefined, observedAt)).toBe(
    "shared",
  );
  expect(
    await writeGitHubCache(
      env,
      key,
      request,
      route,
      { ...response, body: "different" },
      a,
      undefined,
      observedAt,
    ),
  ).toBe("rejected");
  expect(await writeGitHubCache(env, key, request, route, response, a, undefined, observedAt)).toBe(
    "shared",
  );
  expect((await readGitHubCache(env, key))?.body).toBe("observed");
});

it("cannot recover an expired receipt as a fresh shared replay using the real storage clock", async () => {
  await seedPool();
  const key = await githubCacheKey(POOL, request, route);
  const a = (await coordinator().tryAcquirePublication(bodyPublicationResource(key)))!;
  // Leave at least one full second after timestamp truncation for the write.
  const observedAt = Date.now() - 298_000;
  expect(await writeGitHubCache(env, key, request, route, response, a, undefined, observedAt)).toBe(
    "shared",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  expect(await coordinator().renewPublication(a)).toBe(true);
  expect(await writeGitHubCache(env, key, request, route, response, a, undefined, observedAt)).toBe(
    "rejected",
  );
  expect(await readGitHubCache(env, key)).toBeUndefined();
});
