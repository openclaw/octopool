import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queries } from "../../src/generated/sql";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import type { SelectionRequest } from "../../src/types";
import { githubUpstream, jsonResponse, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { ownedWork } from "./owned-work";

const NOW = 1_800_000_000_000;
const coordinator = () => poolCoordinatorStub(env, "coordinator-retention");
const candidate = (id = "a") => [{ id, weight: 100 }];
function request(path: string, id = "a"): SelectionRequest {
  const route = classifyRoute(
    { pool: "coordinator-retention", method: "GET", path },
    defaultPolicy("openclaw"),
  );
  return { routeKey: route.routeKey, resource: route.resource, candidates: candidate(id) };
}
const contents = (name: string, id = "a") =>
  request(`/repos/openclaw/octopool/contents/retention/${name}.txt`, id);
const select = (input: SelectionRequest) => ownedWork.track(coordinator().selectIdentity(input));
async function observedSelection(input: SelectionRequest) {
  return ownedWork.track(
    runInDurableObject(coordinator(), (instance, state) => {
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      const calls: {
        statement: string;
        bindings: unknown[];
        cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
      }[] = [];
      const forwarding = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        calls.push({ statement, bindings, cursor });
        return cursor;
      });
      const clock = vi.spyOn(Date, "now");
      try {
        const result = instance.selectIdentity(input);
        return {
          result,
          clockCalls: clock.mock.calls.length,
          constructorTime: new Date().getTime(),
          calls: calls.map(({ statement, bindings, cursor }) => ({
            statement,
            bindings,
            read: cursor.rowsRead,
            written: cursor.rowsWritten,
          })),
        };
      } finally {
        clock.mockRestore();
        forwarding.mockRestore();
      }
    }),
  );
}
async function rows() {
  return ownedWork.track(
    runInDurableObject(coordinator(), (_instance, state) => ({
      leases: state.storage.sql.exec("SELECT * FROM leases ORDER BY route_key").toArray(),
      cooldowns: state.storage.sql
        .exec("SELECT * FROM cooldowns ORDER BY identity_id, route_key")
        .toArray(),
      rates: state.storage.sql
        .exec("SELECT * FROM rate_states ORDER BY identity_id, resource")
        .toArray(),
    })),
  );
}
function seedContents(count: number, prefix: "old" | "live") {
  return ownedWork.track(
    runInDurableObject(coordinator(), (instance) => {
      const feedback =
        prefix === "old"
          ? { identityId: "a", rate: { remaining: 100, resetAt: NOW / 1000 + 60 } }
          : { identityId: "b" };
      // Keep real selection/feedback order while avoiding per-entry setup RPCs.
      for (let i = 0; i < count; i++) {
        const input = contents(`${prefix}-${i}`, feedback.identityId);
        expect(instance.selectIdentity(input).kind).toBe("selected");
        instance.recordResult({
          ...feedback,
          routeKey: input.routeKey,
          resource: input.resource,
          status: 403,
        });
      }
      return count;
    }),
  );
}

beforeEach(() => {
  // Only JS coordination time moves; native D1 publication time is independent.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("native coordinator expiry retention", () => {
  it("physically drains a distinct contents backlog in bounded batches on natural selection", async () => {
    const runKeys = new Set<string>();
    for (let i = 1; i <= 40; i++) {
      const input = request(`/repos/openclaw/octopool/actions/runs/${i}`);
      runKeys.add(input.routeKey);
      expect((await select(input)).kind).toBe("selected");
    }
    expect(runKeys.size).toBe(1);
    await seedContents(40, "old");
    const before = await rows();
    expect(before.leases).toHaveLength(41);
    expect(before.cooldowns).toHaveLength(40);
    expect(before.rates).toHaveLength(1);
    vi.setSystemTime(NOW + 120_000);
    expect(await coordinator().snapshot()).toEqual({ leases: [], cooldowns: [], rates: [] });
    expect(await rows()).toEqual(before);

    expect((await select(contents("following"))).kind).toBe("selected");
    const first = await rows();
    console.log("native retention first activity", {
      before: { leases: before.leases.length, cooldowns: before.cooldowns.length },
      after: { leases: first.leases.length, cooldowns: first.cooldowns.length },
    });
    expect(first.leases).toHaveLength(26);
    expect(first.cooldowns).toHaveLength(24);
    for (const [leases, cooldowns] of [
      [10, 8],
      [1, 0],
      [1, 0],
    ]) {
      expect(await select(contents("following"))).toMatchObject({ reason: "sticky" });
      const persisted = await rows();
      expect(persisted.leases).toHaveLength(leases!);
      expect(persisted.cooldowns).toHaveLength(cooldowns!);
      expect(persisted.rates).toEqual(before.rates);
    }
  });

  it.each([40, 160])(
    "measures indexed native work with %s expired routes and a live tail",
    async (size) => {
      await seedContents(size, "old");
      vi.setSystemTime(NOW + 9_999);
      await seedContents(size, "live");
      vi.setSystemTime(NOW + 10_000);
      const leaseBoundary = await observedSelection(contents("lease-cost", "c"));
      expect(leaseBoundary.calls[0]).toMatchObject({
        statement: queries.deleteExpiredLeases,
        written: 16,
      });
      expect((await rows()).leases.filter((row) => row.identity_id === "b")).toHaveLength(size);
      vi.setSystemTime(NOW + 119_999);
      await select(contents("live-lease", "d"));
      const before = await rows();
      expect(before.leases).toHaveLength(size * 2 - 30);
      expect(before.cooldowns).toHaveLength(size * 2);
      expect(before.rates).toEqual([
        {
          identity_id: "a",
          resource: "core",
          limit_count: 5000,
          remaining: 100,
          reset_at: NOW + 60_000,
        },
      ]);
      vi.setSystemTime(NOW + 120_000);
      const observed = await observedSelection(contents("cost", "c"));
      expect(observed.clockCalls).toBe(1);
      expect(observed.constructorTime).toBe(NOW + 120_000);
      const deletions = observed.calls.filter((call) => call.statement.startsWith("DELETE"));
      expect(deletions.map(({ statement }) => statement)).toEqual([
        queries.deleteExpiredLeases,
        queries.deleteExpiredCooldowns,
      ]);
      expect(deletions.map(({ bindings }) => bindings)).toEqual([[NOW + 120_000], [NOW + 120_000]]);
      expect(deletions.map(({ written }) => written)).toEqual([16, 16]);
      for (const deletion of deletions) expect(deletion.read).toBeLessThanOrEqual(80);
      const after = await rows();
      expect(after.leases).toHaveLength(before.leases.length - 15);
      expect(after.leases.find((row) => row.identity_id === "d")).toEqual(
        before.leases.find((row) => row.identity_id === "d"),
      );
      expect(after.cooldowns).toHaveLength(size * 2 - 16);
      expect(after.cooldowns.filter((row) => row.identity_id === "b")).toEqual(
        before.cooldowns.filter((row) => row.identity_id === "b"),
      );
      expect(after.rates).toEqual(before.rates);
      const plans = await ownedWork.track(
        runInDurableObject(coordinator(), (_instance, state) =>
          [
            queries.deleteExpiredLeases,
            queries.deleteExpiredCooldowns,
            queries.coordinatorLeases,
            queries.coordinatorCooldowns,
          ].map((statement) =>
            state.storage.sql.exec(`EXPLAIN QUERY PLAN ${statement}`, NOW + 120_000).toArray(),
          ),
        ),
      );
      for (const [index, plan] of plans.entries()) {
        const details = JSON.stringify(plan);
        expect(details).toContain(index % 2 === 0 ? "leases_expiry" : "cooldowns_expiry");
        expect(details).not.toMatch(/SCAN (?:old|leases|cooldowns)|TEMP B-TREE/);
      }
      console.log(
        "native retention SQL cost",
        JSON.stringify({ size, leaseBoundary, observed, plans }),
      );
    },
  );

  it("preserves live sticky leases and deletes at exact equality even when selection is unavailable", async () => {
    const input = contents("boundary");
    await select(input);
    await ownedWork.track(
      coordinator().recordResult({
        identityId: "a",
        routeKey: input.routeKey,
        resource: input.resource,
        status: 401,
        rate: { retryAfter: 10 },
      }),
    );
    vi.setSystemTime(NOW + 9_999);
    const live = await rows();
    const unavailable = await observedSelection(input);
    expect(unavailable.result.kind).toBe("unavailable");
    expect(unavailable.calls.filter((call) => call.statement.startsWith("DELETE"))).toHaveLength(2);
    expect(await rows()).toEqual(live);
    vi.setSystemTime(NOW + 10_000);
    const empty = await observedSelection({ ...input, candidates: [] });
    expect(empty.result.kind).toBe("unavailable");
    expect(empty.clockCalls).toBe(1);
    expect(await rows()).toEqual({ leases: [], cooldowns: [], rates: [] });
    expect(await select(input)).toMatchObject({ reason: "highest_remaining" });
    const renewed = await rows();
    expect(renewed.leases[0]?.expires_at).toBe(NOW + 20_000);
    expect(
      await select({ ...input, candidates: [...candidate("b"), ...candidate()] }),
    ).toMatchObject({
      identityId: "a",
      reason: "sticky",
    });
    expect(await rows()).toEqual(renewed);
    console.log("native retention equality", { live, empty: { leases: 0, cooldowns: 0 }, renewed });
  });

  it.each(["renew-first", "collect-first"])(
    "preserves lease renewal and cooldown extension in %s order",
    async (order) => {
      const lease = contents("renew-lease", "b");
      const cooling = contents("extend-cooldown");
      await select(lease);
      await ownedWork.track(
        coordinator().recordResult({
          identityId: "a",
          routeKey: cooling.routeKey,
          resource: cooling.resource,
          status: 403,
        }),
      );
      vi.setSystemTime(NOW + 120_000);
      const extend = () =>
        ownedWork.track(
          coordinator().recordResult({
            identityId: "a",
            routeKey: cooling.routeKey,
            resource: cooling.resource,
            status: 403,
          }),
        );
      if (order === "collect-first") {
        await select(contents("trigger", "c"));
        expect((await rows()).cooldowns).toEqual([]);
        expect((await rows()).leases.map((row) => row.route_key)).not.toContain(lease.routeKey);
        await select(lease);
        await extend();
      } else {
        // Feedback first extends the expired row before the next selection can collect it.
        await extend();
        await select(lease);
      }
      const live = await rows();
      await select(contents("trigger", "c"));
      expect((await rows()).cooldowns).toEqual(live.cooldowns);
      expect((await rows()).leases.find((row) => row.route_key === lease.routeKey)).toEqual(
        live.leases.find((row) => row.route_key === lease.routeKey),
      );
      expect(live.cooldowns[0]?.expires_at).toBe(NOW + 240_000);
      expect(live.leases.find((row) => row.route_key === lease.routeKey)?.expires_at).toBe(
        NOW + 130_000,
      );
      expect((await select(cooling)).kind).toBe("unavailable");
      expect(await select(lease)).toMatchObject({ reason: "sticky", identityId: "b" });
    },
  );

  it("retains live independent cooldown scopes, credential health and rate history through cleanup", async () => {
    await seedContents(20, "old");
    vi.setSystemTime(NOW + 120_000);
    const route = contents("live-scopes");
    for (const [identityId, status, resource] of [
      ["route", 403, "core"],
      ["resource", 429, "core"],
      ["global", 401, "search"],
    ] as const) {
      await ownedWork.track(
        coordinator().recordResult({ identityId, status, resource, routeKey: route.routeKey }),
      );
    }
    await ownedWork.track(
      coordinator().recordCredentialFailure({
        identityId: "credential",
        reason: "identity_secret_missing",
      }),
    );
    await ownedWork.track(
      coordinator().recordResult({
        identityId: "exhausted",
        status: 200,
        resource: "core",
        routeKey: route.routeKey,
        rate: { remaining: 0, resetAt: NOW / 1000 + 300, limit: 6000 },
      }),
    );
    const before = await rows();
    expect(before.cooldowns).toHaveLength(24); // Feedback itself must not prune.
    vi.setSystemTime(NOW + 120_000);
    for (const id of ["route", "resource", "global", "credential", "exhausted"]) {
      expect((await select({ ...route, candidates: candidate(id) })).kind).toBe("unavailable");
    }
    const retained = await rows();
    expect(retained.cooldowns).toEqual(before.cooldowns.filter((row) => row.identity_id !== "a"));
    expect(retained.rates).toEqual(before.rates);
    expect((await select(contents("independent-route", "route"))).kind).toBe("selected");
    expect(
      (await select({ ...contents("independent-resource", "resource"), resource: "search" })).kind,
    ).toBe("selected");
    await ownedWork.track(
      coordinator().recordResult({
        identityId: "exhausted",
        status: 200,
        resource: "core",
        routeKey: route.routeKey,
        rate: { remaining: 4999, resetAt: NOW / 1000 + 200 },
      }),
    );
    expect((await rows()).rates).toEqual(before.rates);
    console.log("native retention preserved state", JSON.stringify({ before, retained }));
  });

  it("retains persisted state and idempotent indexes through graceful eviction and a following request", async () => {
    await seedContents(20, "old");
    const before = await rows();
    const indexes = () =>
      ownedWork.track(
        runInDurableObject(coordinator(), (_instance, state) =>
          state.storage.sql
            .exec("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name")
            .toArray(),
        ),
      );
    const originalIndexes = await indexes();
    expect(originalIndexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["leases_expiry", "cooldowns_expiry"]),
    );
    vi.setSystemTime(NOW + 120_000);
    await ownedWork.track(evictDurableObject(coordinator()));
    // Constructor runs against retained storage; neither it nor snapshot collects rows.
    expect(await rows()).toEqual(before);
    expect(await indexes()).toEqual(originalIndexes);
    expect(await coordinator().snapshot()).toEqual({ leases: [], cooldowns: [], rates: [] });
    await select(contents("after-eviction", "b"));
    const first = await rows();
    expect(first.leases).toHaveLength(5);
    expect(first.cooldowns).toHaveLength(4);
    await ownedWork.track(evictDurableObject(coordinator()));
    expect(await rows()).toEqual(first);
    expect(await indexes()).toEqual(originalIndexes);
    expect(await select(contents("after-eviction", "b"))).toMatchObject({ reason: "sticky" });
    expect((await rows()).leases).toHaveLength(1);
    expect((await rows()).cooldowns).toEqual([]);
    expect((await rows()).rates).toEqual(before.rates);
    console.log("native retention reconstruction", JSON.stringify({ originalIndexes, first }));
  });

  it.each([40, 160])(
    "measures additive expiry index construction over %s retained rows without deleting state",
    async (size) => {
      await seedContents(size, "old");
      const before = await rows();
      const costs = await ownedWork.track(
        runInDurableObject(coordinator(), (_instance, state) => {
          const sql = state.storage.sql;
          // Native shadow tables measure a first index build without removing real indexes/state.
          return [
            ["leases", queries.createLeasesTable, queries.createLeasesExpiryIndex],
            ["cooldowns", queries.createCooldownsTable, queries.createCooldownsExpiryIndex],
          ].map(([table, create, index]) => {
            const shadow = `retention_build_${table}`;
            sql.exec(create!.replace(`EXISTS ${table}`, `EXISTS ${shadow}`));
            sql.exec(`INSERT INTO ${shadow} SELECT * FROM ${table}`);
            const read = () => sql.exec(`SELECT * FROM ${shadow} ORDER BY rowid`).toArray();
            const retained = read();
            const statement = index!
              .replace(`${table}_expiry`, `${shadow}_expiry`)
              .replace(`ON ${table}(`, `ON ${shadow}(`);
            const build = sql.exec(statement);
            const built = { read: build.rowsRead, written: build.rowsWritten };
            const repeated = sql.exec(statement);
            return {
              table,
              statement,
              built,
              repeated: { read: repeated.rowsRead, written: repeated.rowsWritten },
              retained,
              after: read(),
            };
          });
        }),
      );
      for (const cost of costs) {
        expect(cost.retained).toHaveLength(size);
        expect(cost.after).toEqual(cost.retained);
        expect(cost.built.read).toBeGreaterThanOrEqual(size);
        expect(cost.built.written).toBeGreaterThanOrEqual(size);
        expect(cost.repeated).toEqual({ read: 0, written: 0 });
      }
      expect(await rows()).toEqual(before);
      console.log(
        "native retention index build",
        JSON.stringify(
          costs.map(({ retained, after: _after, ...cost }) => ({
            ...cost,
            retained: retained.length,
          })),
        ),
      );
    },
  );

  it("serves a following ordinary Worker request after the retention fixture has drained and reset", async () => {
    // This full Worker control also reads native D1 auth/publication timestamps.
    vi.useRealTimers();
    expect(await rows()).toEqual({ leases: [], cooldowns: [], rates: [] });
    await seedPool();
    vi.stubGlobal("fetch", githubUpstream({ primary: jsonResponse({ private: false }) }));
    const response = await requestWithEnv();
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ identity: { id: "primary" } });
  });
});
