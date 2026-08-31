import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { queries } from "../../src/generated/sql";
import { rateFromHeaders } from "../../src/github-rate";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import type { RecordResult } from "../../src/types";

const NOW = 1_800_000_000_000;
const R1 = NOW / 1000 + 60;
const R2 = R1 + 60;
const request = (routeKey = "A", resource = "core", id = "a") => ({
  routeKey,
  resource,
  candidates: [{ id, weight: 100 }],
});
const feedback = (
  rate?: RecordResult["rate"],
  status = 200,
  routeKey = "A",
  resource = "core",
): RecordResult => ({
  identityId: "a",
  routeKey,
  resource,
  status,
  ...(rate === undefined ? {} : { rate }),
});
const coordinator = () => poolCoordinatorStub(env, "feedback");

async function rows() {
  return runInDurableObject(coordinator(), (_instance, state) => ({
    rates: state.storage.sql
      .exec("SELECT * FROM rate_states ORDER BY identity_id, resource")
      .toArray(),
    cooldowns: state.storage.sql.exec("SELECT * FROM cooldowns ORDER BY route_key").toArray(),
  }));
}

describe("persisted quota feedback", () => {
  it.each([
    {
      name: "same-window zero then positive",
      samples: [
        [R1, 0, 6000],
        [R1, 9, 5000],
      ],
      reset: R1,
      remaining: 0,
      limit: 6000,
    },
    {
      name: "same-window positive then zero",
      samples: [
        [R1, 9, 5000],
        [R1, 0, 6000],
      ],
      reset: R1,
      remaining: 0,
      limit: 5000,
    },
    {
      name: "same-window minimum",
      samples: [
        [R1, 30, 6000],
        [R1, 7, 5000],
        [R1, 20, 9000],
      ],
      reset: R1,
      remaining: 7,
      limit: 6000,
    },
    {
      name: "older future window",
      samples: [
        [R2, 0, 6000],
        [R1, 4999, 5000],
      ],
      reset: R2,
      remaining: 0,
      limit: 6000,
    },
    {
      name: "older expired window",
      samples: [
        [R2, 0, 6000],
        [NOW / 1000, 4999, 5000],
      ],
      reset: R2,
      remaining: 0,
      limit: 6000,
    },
    {
      name: "newer positive recovery",
      samples: [
        [R1, 0, 6000],
        [R2, 4999, 5000],
      ],
      reset: R2,
      remaining: 4999,
      limit: 5000,
    },
    {
      name: "newer depletion then delayed success",
      samples: [
        [R1, 4999, 5000],
        [R2, 0, 6000],
        [R1, 4900, 5000],
      ],
      reset: R2,
      remaining: 0,
      limit: 6000,
    },
  ])("$name", async ({ samples, reset, remaining, limit }) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    expect((await stub.selectIdentity(request())).kind).toBe("selected");
    for (const [resetAt, count, limitCount] of samples) {
      await stub.recordResult(
        feedback({ resetAt: resetAt!, remaining: count!, limit: limitCount! }),
      );
    }
    expect((await rows()).rates).toEqual([
      { identity_id: "a", resource: "core", limit_count: limit, remaining, reset_at: reset * 1000 },
    ]);
    for (const route of ["A", "fresh"]) {
      expect((await stub.selectIdentity(request(route))).kind).toBe(
        remaining === 0 ? "unavailable" : "selected",
      );
    }
  });

  it("recovers at exact reset while a sticky lease is still live, without deleting the row", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.selectIdentity(request());
    await stub.recordResult(feedback({ remaining: 0, resetAt: NOW / 1000 + 1 }));
    for (const [offset, kind] of [
      [999, "unavailable"],
      [1000, "selected"],
      [1001, "selected"],
    ] as const) {
      clock.mockReturnValue(NOW + offset);
      expect((await stub.selectIdentity(request())).kind).toBe(kind);
      expect((await stub.snapshot()).rates).toHaveLength(offset < 1000 ? 1 : 0);
    }
    expect((await stub.selectIdentity(request())).reason).toBe("sticky");
    expect((await rows()).rates).toHaveLength(1);
  });

  it("keeps identity and resource budgets independent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.recordResult(feedback({ remaining: 0, resetAt: R2 }));
    expect((await stub.selectIdentity(request())).kind).toBe("unavailable");
    expect((await stub.selectIdentity(request("search", "search"))).kind).toBe("selected");
    expect((await stub.selectIdentity(request("other", "core", "b"))).kind).toBe("selected");
  });

  it("ignores missing and malformed header observations, retaining independent cooldown feedback", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.recordResult(feedback({ remaining: 0, resetAt: R1 }));
    const before = (await rows()).rates;
    const valid = {
      "x-ratelimit-limit": "6000",
      "x-ratelimit-remaining": "9",
      "x-ratelimit-reset": String(R2),
    };
    const partials = [{}, { "x-ratelimit-remaining": "9" }, { "x-ratelimit-reset": String(R2) }];
    for (const headers of partials) {
      await stub.recordResult(feedback(rateFromHeaders(headers)));
      expect((await rows()).rates).toEqual(before);
    }
    for (const key of Object.keys(valid)) {
      for (const bad of ["", "9junk", "1e3", "1.5", "-1", "NaN", "Infinity", "9007199254740992"]) {
        await stub.recordResult(
          feedback(rateFromHeaders({ ...valid, [key]: bad }), 429, "bad", "core"),
        );
        expect((await rows()).rates, `${key}=${bad}`).toEqual(before);
      }
    }
    for (const reset of ["0", "9007199254741"]) {
      await stub.recordResult(feedback(rateFromHeaders({ ...valid, "x-ratelimit-reset": reset })));
      expect((await rows()).rates).toEqual(before);
    }
    expect((await rows()).cooldowns).toEqual([
      {
        identity_id: "a",
        route_key: "resource:core",
        status: 429,
        reason: "github_error",
        expires_at: NOW + 120_000,
      },
    ]);
    expect((await stub.selectIdentity(request())).kind).toBe("unavailable");
  });

  it("validates numeric RPC authority without coercion or unsafe reset arithmetic", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.recordResult(feedback({ remaining: 0, resetAt: R1 }));
    const before = (await rows()).rates;
    for (const key of ["remaining", "resetAt", "limit"] as const) {
      for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "9", null]) {
        const rate = { remaining: 9, resetAt: R2, limit: 6000, [key]: bad } as RecordResult["rate"];
        await stub.recordResult(feedback(rate));
        expect((await rows()).rates, `${key}=${String(bad)}`).toEqual(before);
      }
    }
    for (const resetAt of [0, Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1]) {
      await stub.recordResult(feedback({ remaining: 9, resetAt }));
      expect((await rows()).rates).toEqual(before);
    }
    await stub.recordResult(
      feedback({ remaining: Number.MAX_SAFE_INTEGER, resetAt: R2, limit: 0 }),
    );
    expect((await rows()).rates).toEqual([
      {
        identity_id: "a",
        resource: "core",
        limit_count: 0,
        remaining: Number.MAX_SAFE_INTEGER,
        reset_at: R2 * 1000,
      },
    ]);
  });
});

describe("persisted cooldown feedback", () => {
  it.each([
    { seconds: 9_005_399_254_740, key: "*", deadline: 9_007_199_254_740_000 },
    { seconds: 9_005_399_254_741, key: "resource:core", deadline: NOW + 120_000 },
  ])(
    "checks the absolute deadline after safe duration conversion: $seconds",
    async ({ seconds, key, deadline }) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      await coordinator().recordResult(
        feedback(rateFromHeaders({ "retry-after": String(seconds) }), 429),
      );
      expect((await rows()).cooldowns[0]).toMatchObject({ route_key: key, expires_at: deadline });
    },
  );

  it.each([false, true])(
    "retains the longer global deadline and its metadata, reverse=%s",
    async (reverse) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const stub = coordinator();
      const samples = [feedback({ retryAfter: 3600 }, 429), feedback(undefined, 401)];
      for (const sample of reverse ? samples.reverse() : samples) await stub.recordResult(sample);
      await stub.recordResult(feedback({ remaining: 10, resetAt: R2 }));
      expect((await rows()).cooldowns).toEqual([
        {
          identity_id: "a",
          route_key: "*",
          status: 429,
          reason: "github_error",
          expires_at: NOW + 3_600_000,
        },
      ]);
      for (const [route, resource] of [
        ["A", "core"],
        ["B", "search"],
      ] as const) {
        expect((await stub.selectIdentity(request(route, resource))).kind).toBe("unavailable");
      }
      expect((await stub.selectIdentity(request("B", "core", "b"))).kind).toBe("selected");
    },
  );

  it("replays absolute SQL observations without changing state or equal-deadline metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await runInDurableObject(coordinator(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(queries.upsertRateState, "a", "core", 6000, 0, R2 * 1000);
      sql.exec(queries.upsertCooldown, "a", "*", 429, "long", NOW + 3_600_000);
      for (let replay = 0; replay < 2; replay++) {
        sql.exec(queries.upsertRateState, "a", "core", 6000, 0, R2 * 1000);
        sql.exec(queries.upsertCooldown, "a", "*", 429, "long", NOW + 3_600_000);
      }
      sql.exec(queries.upsertCooldown, "a", "*", 401, "equal", NOW + 3_600_000);
      sql.exec(queries.upsertCooldown, "a", "*", 403, "short", NOW + 120_000);
    });
    expect((await rows()).cooldowns).toEqual([
      {
        identity_id: "a",
        route_key: "*",
        status: 429,
        reason: "long",
        expires_at: NOW + 3_600_000,
      },
    ]);
    expect((await rows()).rates[0]).toMatchObject({ remaining: 0, reset_at: R2 * 1000 });
    expect((await coordinator().selectIdentity(request())).kind).toBe("unavailable");
  });

  it("recovers at exact cooldown expiry and accepts a subsequent failure", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.selectIdentity(request());
    await stub.recordResult(feedback({ retryAfter: 1 }, 401));
    for (const [offset, kind] of [
      [999, "unavailable"],
      [1000, "selected"],
      [1001, "selected"],
    ] as const) {
      clock.mockReturnValue(NOW + offset);
      expect((await stub.selectIdentity(request())).kind).toBe(kind);
      expect((await stub.snapshot()).cooldowns).toHaveLength(offset < 1000 ? 1 : 0);
    }
    await stub.recordResult(feedback(undefined, 401));
    expect((await rows()).cooldowns[0]).toMatchObject({ expires_at: NOW + 121_001 });
    expect((await stub.selectIdentity(request())).kind).toBe("unavailable");
  });

  it("keeps route, resource and global keys independent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.recordResult(feedback({ remaining: 9 }, 403));
    expect((await stub.selectIdentity(request())).kind).toBe("unavailable");
    expect((await stub.selectIdentity(request("B"))).kind).toBe("selected");
    await stub.recordResult(feedback(undefined, 429, "B", "search"));
    expect((await stub.selectIdentity(request("C", "search"))).kind).toBe("unavailable");
    expect((await stub.selectIdentity(request("B"))).kind).toBe("selected");
    await stub.recordResult(feedback(undefined, 401));
    expect((await stub.selectIdentity(request("B"))).kind).toBe("unavailable");
    expect((await rows()).cooldowns.map((row) => row.route_key)).toEqual([
      "*",
      "A",
      "resource:search",
    ]);
    expect((await rows()).rates).toEqual([]);
  });

  it.each([
    { status: 403, rate: { remaining: 0 }, key: "A" },
    { status: 403, rate: {}, key: "A" },
    { status: 403, rate: { remaining: 0, resetAt: R2 }, key: "A" },
    { status: 403, rate: { remaining: 9, resetAt: R2 }, key: "A" },
    { status: 429, rate: {}, key: "resource:core" },
    { status: 401, rate: {}, key: "*" },
    { status: 404, rate: { remaining: 9, resetAt: R2 }, key: undefined },
    { status: 422, rate: { remaining: 9, resetAt: R2 }, key: undefined },
    { status: 503, rate: { remaining: 9, resetAt: R2, retryAfter: 60 }, key: undefined },
    { status: 304, rate: { remaining: 0, resetAt: R2 }, key: undefined },
  ])("preserves status/scope policy: $status $rate", async ({ status, rate, key }) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.recordResult(feedback(rate, status));
    expect((await rows()).cooldowns.map((row) => row.route_key)).toEqual(key ? [key] : []);
    const exhausted = rate.remaining === 0 && rate.resetAt !== undefined;
    expect((await stub.selectIdentity(request("B"))).kind).toBe(
      exhausted || key === "*" || key === "resource:core" ? "unavailable" : "selected",
    );
    expect((await rows()).rates).toHaveLength(rate.resetAt === undefined ? 0 : 1);
  });

  it.each([0, 86_400_000, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "60", null])(
    "handles Retry-After safely without a product cap: %s",
    async (value) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const stub = coordinator();
      await stub.recordResult(feedback({ retryAfter: value } as RecordResult["rate"], 429));
      const accepted = value === 0 || value === 86_400_000;
      expect((await rows()).cooldowns).toEqual([
        {
          identity_id: "a",
          route_key: accepted ? "*" : "resource:core",
          status: 429,
          reason: "github_error",
          expires_at: NOW + (value === 0 ? 1000 : value === 86_400_000 ? 86_400_000_000 : 120_000),
        },
      ]);
    },
  );
});

describe("feedback storage lifetime and failure", () => {
  it("preserves committed state through real DO eviction and stale feedback", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    let stub = coordinator();
    await stub.recordResult(feedback({ remaining: 0, resetAt: R2, retryAfter: 3600 }, 429));
    const before = await rows();
    await evictDurableObject(stub);
    stub = coordinator();
    await stub.recordResult(feedback({ remaining: 4999, resetAt: R1 }, 401));
    expect(await rows()).toEqual(before);
    expect((await stub.selectIdentity(request())).kind).toBe("unavailable");
  });

  it("rolls back the rate write when the subsequent cooldown SQL write fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const stub = coordinator();
    await stub.recordResult(feedback({ remaining: 0, resetAt: R1 }));
    const before = await rows();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER reject_cooldown BEFORE INSERT ON cooldowns BEGIN SELECT RAISE(ABORT, 'feedback fault'); END",
      );
    });
    try {
      await runInDurableObject(stub, (instance) => {
        expect(() =>
          instance.recordResult(feedback({ remaining: 4999, resetAt: R2 }, 401)),
        ).toThrow("feedback fault");
      });
      const after = await rows();
      expect(after).toEqual(before);
      expect((await stub.selectIdentity(request())).kind).toBe("unavailable");
    } finally {
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("DROP TRIGGER reject_cooldown").toArray(),
      );
    }
  });
});
