import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  captureD1Baseline,
  initializeD1Baseline,
  restoreD1Baseline,
  type D1Baseline,
} from "./d1-baseline";
import { callWarmWorker, runScheduled, runWithContext, seedPool } from "./harness";
import { ownedWork } from "./owned-work";
import { CacheWriteLedger, clearActionLogs, clearCoordinators } from "./storage-isolation";

const migrationNames = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS.map(
  ({ name }) => name,
);
let baseline: D1Baseline;
beforeAll(async () => {
  baseline = await captureD1Baseline(env.DB);
});

describe("per-test setup boundary", () => {
  const key = "https://octopool.dev/isolation/previous-test";
  const coordinator = () =>
    env.POOL_COORDINATOR.get(env.POOL_COORDINATOR.idFromName("previous-test"));

  it("writes real stores through the normal test bindings", async () => {
    await seedPool();
    await env.ACTIONS_LOGS.put("previous-test", "old");
    await caches.default.put(
      key,
      new Response("old", { headers: { "cache-control": "public, max-age=3600" } }),
    );
    await (
      await caches.open("previous-test")
    ).put(key, new Response("old", { headers: { "cache-control": "public, max-age=3600" } }));
    expect(await caches.default.match(key)).toBeDefined();
    expect((await coordinator().acquireCacheFill(key)).kind).toBe("owner");
    await runInDurableObject(coordinator(), async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 86_400_000);
    });
  });

  it("starts the next body with the exact D1 baseline and cleared configured stores", async () => {
    expect(await captureD1Baseline(env.DB)).toEqual(baseline);
    expect(await env.ACTIONS_LOGS.get("previous-test")).toBeNull();
    expect(await caches.default.match(key)).toBeUndefined();
    expect(await (await caches.open("previous-test")).match(key)).toBeUndefined();
    await runInDurableObject(coordinator(), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec("SELECT * FROM cache_fills").toArray()).toEqual([]);
    });
    await seedPool();
  });
});

describe("real D1 baseline restoration", () => {
  it("restores orphaned schema/data and permits the unchanged fixed seed", async () => {
    const policy = await env.DB.prepare("SELECT * FROM string_rewrite_policy").all();
    const migrations = await env.DB.prepare("SELECT * FROM d1_migrations ORDER BY id").all<{
      name: string;
    }>();
    expect(migrations.results.map(({ name }) => name)).toEqual(migrationNames);
    await seedPool();
    await env.DB.batch([
      env.DB.prepare("ALTER TABLE identities RENAME TO identities_old"),
      env.DB.prepare("DROP TABLE string_rewrite_policy"),
      env.DB.prepare(
        "CREATE TABLE isolation_sentinel (id INTEGER PRIMARY KEY AUTOINCREMENT, pool_id TEXT REFERENCES pools(id), value TEXT)",
      ),
      env.DB.prepare(
        "INSERT INTO isolation_sentinel (pool_id, value) VALUES ('maintainers', 'old')",
      ),
      env.DB.prepare("CREATE INDEX isolation_index ON isolation_sentinel(value)"),
      env.DB.prepare("CREATE VIEW isolation_view AS SELECT * FROM isolation_sentinel"),
      env.DB.prepare(
        "CREATE TRIGGER isolation_trigger AFTER INSERT ON isolation_sentinel BEGIN UPDATE isolation_sentinel SET value = 'changed' WHERE id = NEW.id; END",
      ),
    ]);
    // Global abort reaches D1's internal actor behind its service binding.
    // evictAllDurableObjects only evicts this Worker's explicit DO bindings.
    // Natural 11-second idle reproduces the same retained-storage condition.
    await abortAllDurableObjects();
    await restoreD1Baseline(env.DB, baseline);
    expect(
      (
        await env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE name LIKE 'isolation_%' OR name = 'identities_old'",
        ).all()
      ).results,
    ).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM string_rewrite_policy").all()).results).toEqual(
      policy.results,
    );
    expect((await env.DB.prepare("SELECT * FROM d1_migrations").all()).results).toEqual(
      migrations.results,
    );
    expect(await captureD1Baseline(env.DB)).toEqual(baseline);
    await seedPool();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM pools").first("n")).toBe(1);
    await expect(seedPool()).rejects.toThrow("UNIQUE constraint failed: pools.id");
    await expect(
      env.DB.prepare(
        "INSERT INTO identity_scopes (identity_id, owner) VALUES ('missing', 'openclaw')",
      ).run(),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
  });

  it("orders a quoted child created before its mixed-case FK parent", async () => {
    await env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE "child""table" (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "PARENT"(id))',
      ),
      env.DB.prepare("CREATE TABLE parent (id INTEGER PRIMARY KEY)"),
      env.DB.prepare("INSERT INTO parent VALUES (1)"),
      env.DB.prepare('INSERT INTO "child""table" VALUES (1, 1)'),
    ]);
    await restoreD1Baseline(env.DB, baseline);
    expect(await captureD1Baseline(env.DB)).toEqual(baseline);
  });

  it("rolls back all teardown and replay if a statement fails", async () => {
    await seedPool();
    await env.DB.prepare("CREATE TABLE rollback_sentinel (id INTEGER)").run();
    const before = await captureD1Baseline(env.DB);
    await expect(
      restoreD1Baseline(env.DB, [...baseline, "INSERT INTO nonexistent_table VALUES (1);"]),
    ).rejects.toThrow("no such table");
    expect(await captureD1Baseline(env.DB)).toEqual(before);
  });

  it("round trips sequences, multiline text, blobs, schema, indexes and triggers", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE export_values (\n id INTEGER PRIMARY KEY AUTOINCREMENT,\n value TEXT UNIQUE, data BLOB\n)",
      ),
      env.DB.prepare("INSERT INTO export_values (id, value, data) VALUES (?, ?, ?)").bind(
        41,
        "first\nsecond\r\n'quote'",
        new Uint8Array([0, 10, 255]).buffer,
      ),
      env.DB.prepare("INSERT INTO export_values (id, value) VALUES (75, 'removed high sequence')"),
      env.DB.prepare("DELETE FROM export_values WHERE id = 75"),
      env.DB.prepare("CREATE INDEX export_index ON export_values(data)"),
      env.DB.prepare("CREATE VIEW export_view AS SELECT id, value FROM export_values"),
      env.DB.prepare(
        "CREATE TRIGGER export_trigger AFTER INSERT ON export_values BEGIN UPDATE export_values SET value = upper(NEW.value) WHERE id = NEW.id; END",
      ),
    ]);
    const extraBaseline = await captureD1Baseline(env.DB);
    expect(extraBaseline.some((sql) => sql.startsWith("CREATE TABLE") && sql.includes("\n"))).toBe(
      true,
    );
    expect(extraBaseline.some((sql) => sql === "DELETE FROM sqlite_sequence;")).toBe(true);
    await restoreD1Baseline(env.DB, extraBaseline);
    expect(
      await env.DB.prepare("SELECT id, value, hex(data) AS data FROM export_values").first(),
    ).toEqual({ id: 41, value: "first\nsecond\r\n'quote'", data: "000AFF" });
    await env.DB.prepare("INSERT INTO export_values (value) VALUES ('next')").run();
    expect(await env.DB.prepare("SELECT id, value FROM export_view WHERE id = 76").first()).toEqual(
      { id: 76, value: "NEXT" },
    );
    await expect(
      env.DB.prepare("INSERT INTO export_values (value) VALUES ('NEXT')").run(),
    ).rejects.toThrow("UNIQUE constraint failed");
    await restoreD1Baseline(env.DB, baseline);
    expect(await captureD1Baseline(env.DB)).toEqual(baseline);
  });

  it("rejects initialization against an already migrated database", async () => {
    await expect(initializeD1Baseline(env.DB, [])).rejects.toThrow("requires a pristine database");
    expect(await captureD1Baseline(env.DB)).toEqual(baseline);
  });

  it("rejects virtual tables before destructive restore", async () => {
    await env.DB.prepare("CREATE VIRTUAL TABLE unsupported_search USING fts5(value)").run();
    try {
      await expect(captureD1Baseline(env.DB)).rejects.toThrow("does not support virtual tables");
      await expect(restoreD1Baseline(env.DB, baseline)).rejects.toThrow(
        "does not support virtual tables",
      );
      expect(await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first("n")).toBe(
        migrationNames.length,
      );
    } finally {
      await env.DB.prepare("DROP TABLE unsupported_search").run();
    }
  });

  it("rejects cyclic dependencies before destructive restore", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE cycle_a (id INTEGER PRIMARY KEY, b INTEGER REFERENCES cycle_b(id))",
      ),
      env.DB.prepare(
        "CREATE TABLE cycle_b (id INTEGER PRIMARY KEY, a INTEGER REFERENCES cycle_a(id))",
      ),
    ]);
    try {
      await expect(restoreD1Baseline(env.DB, baseline)).rejects.toThrow("foreign-key cycles");
      expect(await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first("n")).toBe(
        migrationNames.length,
      );
    } finally {
      await env.DB.batch([
        env.DB.prepare("DROP TABLE cycle_a"),
        env.DB.prepare("DROP TABLE cycle_b"),
      ]);
    }
  });
});

describe("real configured storage ownership", () => {
  it("clears multiple persisted dormant coordinator IDs, alarms, SQL and instances", async () => {
    const ids = ["storage-isolation-a", "storage-isolation-b"].map((name) =>
      env.POOL_COORDINATOR.idFromName(name),
    );
    const oldTokens: string[] = [];
    for (const id of ids) {
      const stub = env.POOL_COORDINATOR.get(id);
      const lease = await stub.acquireCacheFill("old-key");
      expect(lease.kind).toBe("owner");
      if (lease.kind !== "owner") throw new Error("Expected fresh owner");
      oldTokens.push(lease.token);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("sentinel", "old");
        state.storage.sql.exec("CREATE TABLE isolation_sentinel (value TEXT)");
        state.storage.sql.exec("INSERT INTO isolation_sentinel VALUES ('old')");
        await state.storage.setAlarm(Date.now() + 86_400_000);
      });
      await evictDurableObject(stub);
    }
    expect((await listDurableObjectIds(env.POOL_COORDINATOR)).map(String)).toEqual(
      expect.arrayContaining(ids.map(String)),
    );
    await clearCoordinators(env.POOL_COORDINATOR);
    for (const [index, id] of ids.entries()) {
      const stub = env.POOL_COORDINATOR.get(id);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get("sentinel")).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
        expect(
          state.storage.sql
            .exec("SELECT name FROM sqlite_schema WHERE name = 'isolation_sentinel'")
            .toArray(),
        ).toEqual([]);
        // Constructor recreation is required: deleteAll removed cache_fills too.
        expect(state.storage.sql.exec("SELECT * FROM cache_fills").toArray()).toEqual([]);
      });
      const fresh = await stub.acquireCacheFill("old-key");
      expect(fresh.kind).toBe("owner");
      if (fresh.kind !== "owner") throw new Error("Expected recreated owner");
      expect(fresh.token).not.toBe(oldTokens[index]);
      expect(await stub.completeCacheFill("old-key", oldTokens[index]!, "shared")).toBe(false);
      expect(await stub.completeCacheFill("old-key", fresh.token, "shared")).toBe(true);
    }
  });

  it("deletes real R2 objects across bounded pages", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        env.ACTIONS_LOGS.put(`isolation/${index}`, `body-${index}`),
      ),
    );
    const list = vi.spyOn(env.ACTIONS_LOGS, "list");
    await clearActionLogs(env.ACTIONS_LOGS, 2);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[1]?.[0]?.cursor).toBeTruthy();
    list.mockRestore();
    expect((await env.ACTIONS_LOGS.list()).objects).toEqual([]);
    expect(await env.ACTIONS_LOGS.get("isolation/4")).toBeNull();
  });

  it("forwards default/named cache hits and removes their owned keys", async () => {
    const ledger = new CacheWriteLedger(caches);
    const request = new Request("https://octopool.dev/isolation/cache", {
      headers: { "x-test": "fixture" },
    });
    const named = await ledger.caches.open("isolation-named");
    expect(named.put).toBe(named.put);
    expect(named.constructor).toBe(caches.default.constructor);
    for (const [cache, body] of [
      [ledger.caches.default, "default"],
      [named, "named"],
    ] as const) {
      const response = new Response(body, {
        headers: { "cache-control": "public, max-age=3600", "x-test": "preserved" },
      });
      await cache.put(request, response);
      const hit = await cache.match.call(cache, request);
      expect(hit?.headers.get("x-test")).toBe("preserved");
      expect(await hit?.text()).toBe(body);
      expect(await (await cache.match(request))?.text()).toBe(body);
      await expect(async () => cache.match.call({} as Cache, request)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    const borrowedKey = "https://octopool.dev/isolation/borrowed-method";
    await ledger.caches.default.put.call(
      named,
      borrowedKey,
      new Response("borrowed", {
        headers: { "cache-control": "public, max-age=3600" },
      }),
    );
    expect(await (await named.match(borrowedKey))?.text()).toBe("borrowed");
    expect(await ledger.caches.default.match(borrowedKey)).toBeUndefined();
    await ledger.clear();
    expect(await ledger.caches.default.match(request)).toBeUndefined();
    expect(await (await ledger.caches.open("isolation-named")).match(request)).toBeUndefined();
    expect(await named.match(borrowedKey)).toBeUndefined();
  });

  it("settles a real streaming put before deleting its recorded key", async () => {
    const ledger = new CacheWriteLedger(caches);
    const gate = ownedWork.gate();
    const request = new Request("https://octopool.dev/isolation/stream");
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate.promise;
        controller.enqueue(new TextEncoder().encode("late body"));
        controller.close();
      },
    });
    const write = ledger.caches.default.put(
      request,
      new Response(body, { headers: { "cache-control": "public, max-age=3600" } }),
    );
    let cleared = false;
    const cleanup = ledger.clear().then(() => {
      cleared = true;
    });
    try {
      await Promise.resolve();
      expect(cleared).toBe(false);
    } finally {
      gate.release();
      await Promise.all([write, cleanup]);
    }
    expect(cleared).toBe(true);
    expect(await ledger.caches.default.match(request)).toBeUndefined();
  });

  it("releases owned request gates and drains background writes before storage cleanup", async () => {
    const ledger = new CacheWriteLedger(caches);
    const gate = ownedWork.gate();
    const request = new Request("https://octopool.dev/isolation/background");
    const events: string[] = [];
    const response = runWithContext((ctx) => {
      ctx.waitUntil(
        gate.promise.then(async () => {
          await ledger.caches.default.put(
            request,
            new Response("late", { headers: { "cache-control": "public, max-age=3600" } }),
          );
          await env.ACTIONS_LOGS.put("late-owned-work", "late");
          events.push("write");
        }),
      );
      return new Response("request");
    });
    await ownedWork.finish();
    expect((await response).status).toBe(200);
    await ledger.clear();
    await clearActionLogs(env.ACTIONS_LOGS);
    events.push("cleanup");
    expect(events).toEqual(["write", "cleanup"]);
    expect(await ledger.caches.default.match(request)).toBeUndefined();
    expect(await env.ACTIONS_LOGS.get("late-owned-work")).toBeNull();
  });

  it.each(["fetch", "scheduled"] as const)(
    "drains the context when the %s handler throws",
    async (kind) => {
      const gate = ownedWork.gate();
      const error = new Error("handler failed");
      const handler = (ctx: ExecutionContext): never => {
        ctx.waitUntil(
          gate.promise.then(async () => {
            await env.ACTIONS_LOGS.put("thrown-handler", "drained");
          }),
        );
        throw error;
      };
      if (kind === "fetch")
        vi.spyOn(worker, "fetch").mockImplementation((_request, _env, ctx) => handler(ctx));
      else
        vi.spyOn(worker, "scheduled").mockImplementation((_controller, _env, ctx) => handler(ctx));
      const request = kind === "fetch" ? callWarmWorker("/") : runScheduled();
      const rejected = expect(request).rejects.toBe(error);
      gate.release();
      await rejected;
      expect(await (await env.ACTIONS_LOGS.get("thrown-handler"))?.text()).toBe("drained");
      // This test intentionally expects the tracked failure as well as the caller's.
      await expect(ownedWork.drain()).rejects.toBe(error);
    },
  );
});
