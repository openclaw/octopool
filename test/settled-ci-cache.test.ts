import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheTTLSeconds, staleCacheSeconds } from "../src/cache";
import { classifyRoute, defaultPolicy } from "../src/policy";

const now = Date.parse("2026-09-28T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();
const collections = [
  ["commits/abc1234/check-runs", "check_runs", 300],
  ["commits/main/check-runs", "check_runs", 120],
  ["commits/abc1234/check-suites", "check_suites", 300],
  ["commits/main/check-suites", "check_suites", 120],
  ["check-suites/42/check-runs", "check_runs", 300],
  ["commits/abc1234/status", "statuses", 300],
  ["commits/main/status", "statuses", 120],
  ["commits/abc1234/statuses", "array", 300],
  ["commits/main/statuses", "array", 120],
  ["statuses/abc1234", "array", 300],
] as const;

afterEach(() => vi.restoreAllMocks());

describe.each(collections)("settled CI TTL: %s", (tail, shape, cap) => {
  const route = classifyRoute(
    { pool: "maintainers", method: "GET", path: `/repos/openclaw/octopool/${tail}` },
    defaultPolicy("openclaw"),
  );
  const checks = shape === "check_runs" || shape === "check_suites";
  const item = (timestamp: unknown) =>
    checks
      ? { status: "completed", completed_at: timestamp }
      : { state: "success", updated_at: timestamp };
  const ttl = (items: unknown[], state = "success") =>
    cacheTTLSeconds(route, {
      status: 200,
      headers: {},
      body: shape === "array" ? items : { state, [shape]: items },
    });

  it.each([
    [0, 60],
    [600, 60],
    [900, 90],
    [1_809, 180],
    [3_000, 300],
    [86_400, 300],
    [-100, 60],
  ])("uses the newest item at age %i and bounds fresh/stale lifetimes", (age, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(ttl([item(ago(86_400)), item(ago(age))])).toBe(Math.min(expected, cap));
    expect(ttl([item(ago(age)), item(ago(86_400))])).toBe(Math.min(expected, cap));
    expect(staleCacheSeconds(route, cap)).toBe(300);
  });

  it.each([undefined, null, "invalid", 123])(
    "keeps a missing/invalid item timestamp %j at 60s",
    (timestamp) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      expect(ttl([item(ago(86_400)), item(timestamp)])).toBe(60);
    },
  );

  it("keeps empty, malformed, active and pending collections at 60s", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(ttl([])).toBe(60);
    expect(ttl([null])).toBe(60);
    expect(
      ttl([item(ago(86_400)), { ...item(ago(86_400)), status: "in_progress", state: "pending" }]),
    ).toBe(60);
    if (shape === "statuses") expect(ttl([item(ago(86_400))], "pending")).toBe(60);
    expect(cacheTTLSeconds(route)).toBe(60);
  });

  it("uses a later update even when completion is old", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(ttl([{ ...item(ago(86_400)), completed_at: ago(86_400), updated_at: ago(900) }])).toBe(
      90,
    );
    expect(ttl([{ ...item(ago(86_400)), completed_at: ago(86_400), updated_at: "invalid" }])).toBe(
      60,
    );
  });
});
