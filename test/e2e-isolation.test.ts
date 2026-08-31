import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureD1Baseline,
  childFirstTables,
  restoreD1Baseline,
  validateD1Export,
} from "./e2e/d1-baseline";
import { IsolationLifecycle } from "./e2e/lifecycle";
import { OwnedWork } from "./e2e/owned-work";

vi.mock("cloudflare:test", () => ({ applyD1Migrations: vi.fn() }));
afterEach(() => vi.useRealTimers());

describe("D1 baseline contract", () => {
  it("rejects SQLite statistics before export or destructive restore", async () => {
    const batch = vi.fn();
    const db = {
      prepare: () => ({
        all: async () => ({
          results: [
            { name: "sqlite_stat1", type: "table", sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" },
          ],
        }),
      }),
      batch,
    } as unknown as D1Database;
    await expect(captureD1Baseline(db)).rejects.toThrow(
      "does not support SQLite statistics tables",
    );
    await expect(restoreD1Baseline(db, [])).rejects.toThrow(
      "does not support SQLite statistics tables",
    );
    expect(batch).not.toHaveBeenCalled();
  });
  it("orders a child created before its mixed-case FK target first", () => {
    expect(
      childFirstTables(
        new Map([
          ['child"table', ["PARENT"]],
          ["parent", []],
        ]),
      ),
    ).toEqual(['child"table', "parent"]);
  });

  it.each([
    new Map([
      ["a", ["b"]],
      ["b", ["A"]],
    ]),
    new Map([["self", ["SELF"]]]),
  ])("rejects cycles before any destructive batch", (graph) => {
    expect(() => childFirstTables(graph)).toThrow("foreign-key cycles");
  });

  it("keeps complete multiline statements immutable", () => {
    const statements = [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE multiline (\n value TEXT\n);",
      "INSERT INTO multiline VALUES ('first\nsecond');",
    ];
    const baseline = validateD1Export([statements]);
    statements.pop();
    expect(baseline).toHaveLength(3);
    expect(baseline[2]).toContain("first\nsecond");
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  it.each(
    [
      null,
      [],
      [[]],
      [["CREATE TABLE unexpected (id);"]],
      [["PRAGMA defer_foreign_keys=TRUE;", null]],
      [["PRAGMA defer_foreign_keys=TRUE;", "CREATE VIRTUAL TABLE unsupported;"]],
      [["PRAGMA defer_foreign_keys=TRUE;", "ANALYZE sqlite_schema;"]],
      [["PRAGMA defer_foreign_keys=TRUE;", "PRAGMA foreign_keys=OFF;"]],
      [["PRAGMA defer_foreign_keys=TRUE;", "CREATE TABLE incomplete (id)"]],
    ].map((rows) => ({ rows })),
  )("rejects unsupported export shape %#", ({ rows }) => {
    expect(() => validateD1Export(rows)).toThrow("Unsupported Miniflare D1 export");
  });
});

describe("test-owned work and hook lifecycle", () => {
  it("releases gates and drains nested work before allowing cleanup", async () => {
    const work = new OwnedWork();
    const { promise } = work.gate();
    const events: string[] = [];
    work.track(
      promise.then(() => {
        events.push("request");
        work.track(
          Promise.resolve().then(() => {
            events.push("background write");
          }),
        );
      }),
    );
    await work.finish();
    events.push("storage cleanup");
    expect(events).toEqual(["request", "background write", "storage cleanup"]);
    work.start();
  });

  it("releases a gate registered by a late request during teardown", async () => {
    const work = new OwnedWork();
    const first = work.gate();
    work.track(
      first.promise.then(async () => {
        await work.gate().promise;
      }),
    );
    await work.finish();
    work.start();
  });

  it("preserves caller rejections and reports abandoned errors during drain", async () => {
    const work = new OwnedWork();
    const error = new Error("background failed");
    await expect(work.track(Promise.reject(error))).rejects.toBe(error);
    await expect(work.finish()).rejects.toBe(error);
  });

  it("fails closed after a deadline while the original setup is still running", async () => {
    vi.useFakeTimers();
    const lifecycle = new IsolationLifecycle(10_000);
    const deferred = Promise.withResolvers<void>();
    const setup = lifecycle.run(() => deferred.promise);
    const rejection = expect(setup).rejects.toThrow("isolation is poisoned");
    await vi.advanceTimersByTimeAsync(10_000);
    const nextBody = vi.fn(async () => {});
    await expect(lifecycle.run(nextBody)).rejects.toThrow("isolation is poisoned");
    const cleanup = vi.fn(async () => {});
    await expect(lifecycle.run(cleanup, true)).rejects.toThrow("isolation is poisoned");
    expect(nextBody).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    deferred.resolve();
    await rejection;
    await expect(lifecycle.run(nextBody)).rejects.toThrow("isolation is poisoned");
  });

  it("detects a missed deadline even if work settles before the timer fires", async () => {
    vi.useFakeTimers();
    const lifecycle = new IsolationLifecycle(10_000);
    await expect(
      lifecycle.run(async () => {
        vi.setSystemTime(Date.now() + 10_001);
      }),
    ).rejects.toThrow("isolation is poisoned");
  });

  it("does not restore mocks after failed drain or admit another body", async () => {
    const lifecycle = new IsolationLifecycle(10_000);
    const work = new OwnedWork();
    const error = new Error("late write failed");
    await expect(work.track(Promise.reject(error))).rejects.toBe(error);
    const restoreMocks = vi.fn();
    await expect(
      lifecycle.run(async () => {
        await work.finish();
        restoreMocks();
      }, true),
    ).rejects.toBe(error);
    expect(restoreMocks).not.toHaveBeenCalled();
    await expect(lifecycle.run(async () => {})).rejects.toThrow("isolation is poisoned");
  });

  it("allows owned teardown after a timed-out body, while keeping the file poisoned", async () => {
    const lifecycle = new IsolationLifecycle(10_000);
    const work = new OwnedWork();
    const gate = work.gate();
    const completed = vi.fn();
    work.track(gate.promise.then(completed));
    lifecycle.poison(new Error("body timed out"));
    await expect(lifecycle.run(() => work.finish(), true)).rejects.toThrow("isolation is poisoned");
    expect(completed).toHaveBeenCalledOnce();
    await expect(lifecycle.run(async () => {})).rejects.toThrow("isolation is poisoned");
  });
});
