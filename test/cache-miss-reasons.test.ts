import { afterEach, describe, expect, it, vi } from "vitest";
import { readGitHubCache, type CacheMissReason } from "../src/cache";
import { CACHE_PUBLICATION_EPOCH } from "../src/cache-publication";
import { readTerminalLogCache } from "../src/terminal-log-cache";
import { sqliteTimestamp } from "../src/sqlite-time";

vi.mock("../src/github-web", () => ({ callGitHubWeb: vi.fn() }));
vi.mock("../src/github-public-actions", () => ({ completedJobPageProof: vi.fn() }));
vi.mock("../src/public-repos", () => ({ observeAnonymousPublicRepo: vi.fn() }));

const now = Date.parse("2026-09-28T12:00:00Z");
const freshRow = () => ({
  status: 200,
  response_headers_json: "{}",
  body_json: "{}",
  body_encoding: "json",
  identity_id: null,
  identity_kind: null,
  publication_epoch: CACHE_PUBLICATION_EPOCH,
  created_at: sqliteTimestamp(now - 30_000),
  expires_at: sqliteTimestamp(now + 30_000),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cache lookup miss observations", () => {
  it.each([
    ["absent", null, undefined],
    ["expired", { expires_at: sqliteTimestamp(now) }, undefined],
    ["caller_max_age", {}, 10],
    ["unusable", { publication_epoch: "old" }, undefined],
    ["unusable", { body_json: "{" }, undefined],
    ["unusable", { expires_at: "invalid" }, undefined],
  ] as const)("reports %s using a single keyed D1 read", async (reason, overrides, maxAge) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("caches", { default: { match: async () => undefined } });
    const first = vi.fn(async () => (overrides === null ? null : { ...freshRow(), ...overrides }));
    const env = { DB: { prepare: () => ({ bind: () => ({ first }) }) } } as unknown as Env;
    const misses: CacheMissReason[] = [];
    expect(
      await readGitHubCache(env, "key", undefined, maxAge, (reason) => misses.push(reason)),
    ).toBeUndefined();
    expect(misses).toEqual([reason]);
    expect(first).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0, 60])(
    "does not report a miss for hits or live reads (%j)",
    async (maxAge) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.stubGlobal("caches", { default: { match: async () => undefined } });
      const first = vi.fn(async () => freshRow());
      const env = { DB: { prepare: () => ({ bind: () => ({ first }) }) } } as unknown as Env;
      const onMiss = vi.fn();
      const cached = await readGitHubCache(env, "key", undefined, maxAge, onMiss);
      expect(cached !== undefined).toBe(maxAge !== 0);
      expect(onMiss).not.toHaveBeenCalled();
      expect(first).toHaveBeenCalledTimes(maxAge === 0 ? 0 : 1);
    },
  );

  it.each([
    ["absent", null],
    [
      "expired",
      { "created-at": sqliteTimestamp(now - 7 * 86_400_000), "body-codec": "lossless-v1" },
    ],
    ["unusable", { "created-at": "invalid" }],
    ["unusable", { "created-at": sqliteTimestamp(now) }],
  ] as const)("reports R2 %s from the existing object read", async (reason, metadata) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const get = vi.fn(async () =>
      metadata === null
        ? null
        : {
            customMetadata: metadata,
            body: { cancel: async () => {} },
          },
    );
    const env = { ACTIONS_LOGS: { get, delete: async () => {} } } as unknown as Env;
    const onMiss = vi.fn();
    expect(await readTerminalLogCache(env, "key", onMiss)).toBeUndefined();
    expect(onMiss).toHaveBeenCalledExactlyOnceWith(reason);
    expect(get).toHaveBeenCalledOnce();
  });
});
