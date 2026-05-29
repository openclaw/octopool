import { describe, expect, it } from "vitest";
import { normalizeAggregate, parseStatsWindow } from "../src/stats";
import { HttpError } from "../src/http";

describe("stats windows", () => {
  it("defaults to 24h", () => {
    expect(parseStatsWindow(null)).toEqual({ label: "24h", seconds: 24 * 60 * 60 });
    expect(parseStatsWindow("")).toEqual({ label: "24h", seconds: 24 * 60 * 60 });
  });

  it("parses minute, hour, and day windows", () => {
    expect(parseStatsWindow("30m")).toEqual({ label: "30m", seconds: 30 * 60 });
    expect(parseStatsWindow("24h")).toEqual({ label: "24h", seconds: 24 * 60 * 60 });
    expect(parseStatsWindow("7d")).toEqual({ label: "7d", seconds: 7 * 24 * 60 * 60 });
    expect(parseStatsWindow("2")).toEqual({ label: "2h", seconds: 2 * 60 * 60 });
  });

  it("rejects invalid or too-large windows", () => {
    expect(() => parseStatsWindow("0h")).toThrow(HttpError);
    expect(() => parseStatsWindow("31d")).toThrow(HttpError);
    expect(() => parseStatsWindow("yesterday")).toThrow(HttpError);
  });
});

describe("stats aggregates", () => {
  it("normalizes null aggregate rows", () => {
    expect(normalizeAggregate(null)).toEqual({
      requests: 0,
      errors: 0,
      avg_duration_ms: null,
      cache_hits: 0,
      cache_misses: 0,
      cache_bypass: 0,
      cache_unknown: 0,
      cacheable_requests: 0,
      cache_hit_rate: null,
      cacheable_hit_rate: null,
      bypass_rate: null,
      saved_github_requests: 0,
      backend_requests: 0,
    });
  });

  it("computes hit rate from hits and misses only", () => {
    expect(
      normalizeAggregate({
        requests: 13,
        errors: 1,
        avg_duration_ms: 12.5,
        cache_hits: 7,
        cache_misses: 3,
        cache_bypass: 2,
        cache_unknown: 1,
        cacheable_requests: 10,
      }),
    ).toEqual({
      requests: 13,
      errors: 1,
      avg_duration_ms: 12.5,
      cache_hits: 7,
      cache_misses: 3,
      cache_bypass: 2,
      cache_unknown: 1,
      cacheable_requests: 10,
      cache_hit_rate: 0.7,
      cacheable_hit_rate: 0.7,
      bypass_rate: 2 / 13,
      saved_github_requests: 7,
      backend_requests: 5,
    });
  });
});
