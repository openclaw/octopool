import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayTiming,
  relayPhase,
  relayPhasePromise,
  relayTiming,
  withRelayTiming,
} from "../src/relay-timing";
import { withTimingBindings } from "../src/relay-timing-bindings";

afterEach(() => vi.restoreAllMocks());

describe("relay phase timing", () => {
  it("keeps inclusive phases separate from elapsed total and freezes at response readiness", () => {
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const timing = new RelayTiming();
    withRelayTiming(timing, () => {
      const auth = relayPhase("auth");
      now = 110;
      const rewrite = relayPhase("rewrite_policy");
      now = 115;
      const nestedAuth = relayPhase("auth");
      now = 120;
      rewrite[Symbol.dispose]();
      now = 125;
      nestedAuth[Symbol.dispose]();
      now = 130;
      auth[Symbol.dispose]();
      now = 140;
      const response = timing.responseReady(new Response());
      expect(response.headers.get("Server-Timing")).toContain(
        "response_ready;dur=40, auth;dur=30, rewrite_policy;dur=10",
      );
      const frozen = timing.json;
      expect(JSON.parse(frozen!)).toMatchObject({
        version: 1,
        response_ready_ms: 40,
        phases_ms: { auth: 30, rewrite_policy: 10 },
        phase_calls: { auth: 2 },
      });
      now = 200;
      timing.count("d1_ops");
      using _late = relayPhase("auth");
      expect(timing.json).toBe(frozen);
    });
  });

  it("preserves the original promise and rejected error while measuring completion", async () => {
    const timing = new RelayTiming();
    const error = new Error("upstream unavailable");
    const original = Promise.reject(error);
    await withRelayTiming(timing, async () => {
      expect(relayPhasePromise("pooled_fetch", () => original)).toBe(original);
      await expect(original).rejects.toBe(error);
      timing.responseReady(new Response());
      expect(JSON.parse(timing.json!).phase_calls.pooled_fetch).toBe(1);
    });
  });

  it("isolates concurrent request counts and excludes detached background work", async () => {
    const timings = [new RelayTiming(), new RelayTiming()];
    await Promise.all(
      timings.map((timing, index) =>
        withRelayTiming(timing, async () => {
          relayTiming()?.count("github_fetches");
          await Promise.resolve();
          if (index === 1) relayTiming()?.count("github_fetches");
          withRelayTiming(undefined, () => relayTiming()?.count("github_fetches"));
          timing.responseReady(new Response());
        }),
      ),
    );
    expect(timings.map((timing) => JSON.parse(timing.json!).github_fetches)).toEqual([1, 2]);
    expect(relayTiming()).toBeUndefined();
  });

  it("counts D1 executions and DO calls without changing receivers, statements, or promises", async () => {
    const pending = Promise.resolve(null);
    const statement = {
      bind() {
        expect(this).toBe(statement);
        return statement;
      },
      first() {
        expect(this).toBe(statement);
        return pending;
      },
    };
    const db = {
      prepare() {
        expect(this).toBe(db);
        return statement;
      },
      withSession() {
        expect(this).toBe(db);
        return db;
      },
      batch(items: unknown[]) {
        expect(this).toBe(db);
        expect(items).toEqual([statement]);
        return pending;
      },
    };
    const stub = {
      fetch() {
        expect(this).toBe(stub);
        return pending;
      },
    };
    const namespace = {
      get() {
        expect(this).toBe(namespace);
        return stub;
      },
    };
    const env = withTimingBindings({
      DB: db,
      POOL_COORDINATOR: namespace,
      POLICY_COORDINATOR: namespace,
      BACKEND_ADMISSION: namespace,
    } as unknown as Env);
    const timing = new RelayTiming();
    withRelayTiming(timing, () => {
      const query = env.DB.prepare("SELECT 1").bind();
      expect(query.first()).toBe(pending);
      expect(env.DB.batch([query])).toBe(pending);
      expect(env.DB.withSession("first-primary").prepare("SELECT 1").first()).toBe(pending);
      expect(
        env.POLICY_COORDINATOR.get("id" as unknown as DurableObjectId).fetch("https://policy/"),
      ).toBe(pending);
      timing.responseReady(new Response());
    });
    expect(JSON.parse(timing.json!)).toMatchObject({ d1_ops: 3, do_calls: 1 });
  });
});
