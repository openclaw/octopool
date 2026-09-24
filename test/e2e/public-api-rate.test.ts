import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { storePublicAPIRate } from "../../src/github-public-api";
import { callAnonymousGitHubAPI, callGitHubWeb } from "../../src/github-web";
import { withGitHubEgress } from "../../src/github-egress";
import { queries } from "../../src/generated/sql";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { observePublicationD1 } from "./publication-d1-observer";
import { ownedWork } from "./owned-work";
import { runWithContext } from "./harness";

const headers = (remaining = 59, reset = 4_102_444_800) =>
  new Headers({
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
  });
const snapshot = () =>
  env.DB.prepare(
    "SELECT resource, remaining, reset_at FROM github_public_api_rates ORDER BY resource",
  ).all();

it("throttles per resource while persisting first, exhaustion, reset and interval observations", async () => {
  const writes: unknown[][] = [];
  const traced = {
    ...env,
    DB: observePublicationD1(env.DB, {
      before: async (sql, values) => {
        if (sql === queries.upsertPublicApiRate) writes.push(values);
      },
    }),
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  try {
    await storePublicAPIRate(traced, "core", headers());
    await storePublicAPIRate(traced, "core", headers(58));
    expect(writes).toHaveLength(1);
    expect((await snapshot()).results).toMatchObject([{ remaining: 59 }]);
    await storePublicAPIRate(traced, "search", headers(9));
    await storePublicAPIRate(traced, "core", headers(0));
    await storePublicAPIRate(traced, "core", headers(0));
    expect(writes).toHaveLength(3);
    expect((await snapshot()).results).toMatchObject([{ remaining: 0 }, { remaining: 9 }]);
    await storePublicAPIRate(traced, "core", headers(60, 4_102_448_400));
    vi.setSystemTime(now + 14_999);
    await storePublicAPIRate(traced, "core", headers(59, 4_102_448_400));
    expect(writes).toHaveLength(4);
    vi.setSystemTime(now + 15_000);
    await storePublicAPIRate(traced, "core", headers(58, 4_102_448_400));
    expect(writes).toHaveLength(5);
    expect((await snapshot()).results).toEqual([
      { resource: "core", remaining: 58, reset_at: 4_102_448_400 },
      { resource: "search", remaining: 9, reset_at: 4_102_444_800 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["web", "anonymous"])(
  "returns %s responses and current rate classification before advisory D1 completes",
  async (transport) => {
    const entered = ownedWork.gate();
    const release = ownedWork.gate();
    let writes = 0;
    const traced = withGitHubEgress(
      {
        ...env,
        DB: observePublicationD1(env.DB, {
          before: async (sql) => {
            if (sql !== queries.upsertPublicApiRate) return;
            writes++;
            entered.release();
            await release.promise;
          },
        }),
      },
      [],
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("limited", { status: 403, headers: headers(0) })),
    );
    const request = {
      pool: "a",
      method: "GET" as const,
      path: "/repos/openclaw/octopool/issues/42",
    };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    let returned = false;
    const pending = runWithContext(async (ctx) => {
      if (transport === "anonymous") {
        expect(await callAnonymousGitHubAPI(traced, request, route, ctx)).toEqual({
          rateLimited: true,
        });
      } else {
        expect(await callGitHubWeb(traced, request, route, { ctx })).toBeUndefined();
      }
      returned = true;
      await storePublicAPIRate(traced, "core", headers(0), ctx);
    });
    try {
      await entered.promise;
      await expect.poll(() => returned).toBe(true);
      expect(writes).toBe(1);
      expect((await snapshot()).results).toEqual([]);
    } finally {
      release.release();
      await pending;
    }
    expect((await snapshot()).results).toMatchObject([{ remaining: 0 }]);
  },
);

it("awaits eligible writes without a context and bounds retries after advisory failures", async () => {
  const entered = ownedWork.gate();
  const release = ownedWork.gate();
  let writes = 0;
  const traced = {
    ...env,
    DB: observePublicationD1(env.DB, {
      before: async () => {
        writes++;
        entered.release();
        await release.promise;
        throw new Error("synthetic D1 failure");
      },
    }),
  };
  let returned = false;
  const pending = ownedWork.track(
    storePublicAPIRate(traced, "core", headers()).then(() => {
      returned = true;
    }),
  );
  try {
    await entered.promise;
    await storePublicAPIRate(traced, "core", headers(58));
    expect(returned).toBe(false);
    expect(writes).toBe(1);
  } finally {
    release.release();
    await pending;
  }
  await storePublicAPIRate(traced, "core", headers(57));
  expect(writes).toBe(1);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 15_000);
    await storePublicAPIRate(traced, "core", headers(56));
    expect(writes).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
