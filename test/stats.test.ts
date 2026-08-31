import { describe, expect, it, vi } from "vitest";
import { normalizeAggregate } from "../src/metrics";
import { parseStatsWindow, poolStats } from "../src/stats";
import { HttpError } from "../src/http";
import type { Caller } from "../src/types";

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
      service_errors: 0,
      fallbacks: 0,
      avg_duration_ms: null,
      cache_hits: 0,
      cache_stale: 0,
      cache_misses: 0,
      cache_bypass: 0,
      cache_unknown: 0,
      cacheable_requests: 0,
      eligible_cache_requests: 0,
      cache_hit_rate: null,
      cacheable_hit_rate: null,
      eligible_cache_hit_rate: null,
      bypass_rate: null,
      coalesced: 0,
      saved_github_requests: 0,
      backend_requests: 0,
    });
  });

  it("counts stale cache serves as saved GitHub requests", () => {
    expect(
      normalizeAggregate({
        requests: 13,
        errors: 1,
        service_errors: 1,
        fallbacks: 2,
        avg_duration_ms: 12.5,
        cache_hits: 7,
        cache_stale: 2,
        cache_misses: 3,
        cache_bypass: 2,
        cache_unknown: 1,
        cacheable_requests: 10,
        eligible_cache_requests: 9,
        coalesced: 2,
      }),
    ).toEqual({
      requests: 13,
      errors: 1,
      service_errors: 1,
      fallbacks: 2,
      avg_duration_ms: 12.5,
      cache_hits: 7,
      cache_stale: 2,
      cache_misses: 3,
      cache_bypass: 2,
      cache_unknown: 1,
      cacheable_requests: 10,
      eligible_cache_requests: 9,
      cache_hit_rate: 0.75,
      cacheable_hit_rate: 0.9,
      eligible_cache_hit_rate: 1,
      bypass_rate: 2 / 13,
      coalesced: 2,
      saved_github_requests: 9,
      backend_requests: 5,
    });
  });
});

describe("client-filtered stats", () => {
  const caller: Caller = {
    id: "caller-id",
    name: "Caller",
    github_login: "caller",
    github_user_id: 42,
    org_login: "openclaw",
    org_verified_at: null,
    caller_token_id: "caller-token-id",
    client_name: "test-mac",
  };

  it("keeps the calling client by default and emits no filter field", async () => {
    const bindings: unknown[][] = [];
    const response = await poolStats(statsEnv(bindings), "maintainers", caller, {
      label: "24h",
      seconds: 86_400,
    });

    expect(response).not.toHaveProperty("client_filter");
    expect(clientScopedBindings(bindings)).toEqual([
      ["maintainers", "-86400 seconds", "caller-id", "test-mac"],
      ["maintainers", "-86400 seconds", "caller-id", "test-mac"],
    ]);
  });

  it("binds a filtered client together with the authenticated caller id", async () => {
    const bindings: unknown[][] = [];
    const response = await poolStats(
      statsEnv(bindings),
      "maintainers",
      caller,
      { label: "24h", seconds: 86_400 },
      "ci-runner",
    );

    expect(response).toMatchObject({
      operator: { github_login: "caller", client_name: "test-mac" },
      client_filter: "ci-runner",
    });
    expect(clientScopedBindings(bindings)).toEqual([
      ["maintainers", "-86400 seconds", "caller-id", "ci-runner"],
      ["maintainers", "-86400 seconds", "caller-id", "ci-runner"],
    ]);
  });
});

function statsEnv(bindings: unknown[][]): Env {
  const prepare = vi.fn(() => ({
    bind: (...values: unknown[]) => {
      bindings.push(values);
      return {
        first: async () => null,
        all: async () => ({ results: [] }),
      };
    },
  }));
  return { DB: { prepare } } as unknown as Env;
}

function clientScopedBindings(bindings: unknown[][]): unknown[][] {
  return bindings.filter(
    (values) =>
      values.length === 4 &&
      values[2] === "caller-id" &&
      typeof values[3] === "string" &&
      values[3] !== "",
  );
}
