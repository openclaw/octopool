import { describe, expect, it, vi } from "vitest";
import { queries } from "../src/generated/sql";
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
      cache_served_responses: 0,
      uncached_outcomes: 0,
      saved_github_requests: 0,
      backend_requests: 0,
    });
  });

  it("counts cache-served responses and uncached outcomes with historical wire aliases", () => {
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
      cache_served_responses: 9,
      uncached_outcomes: 5,
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
    const env = statsEnv(bindings);
    const response = await poolStats(env, "maintainers", caller, {
      label: "24h",
      seconds: 86_400,
    });

    expect(env.DB.batch).toHaveBeenCalledOnce();
    expect(response).not.toHaveProperty("client_filter");
    expect(clientScopedBindings(bindings)).toEqual([
      ["maintainers", "-86400 seconds", "caller-id", "test-mac"],
      ["maintainers", "-86400 seconds", "caller-id", "test-mac"],
    ]);
  });

  it("maps batched results to the correct scopes for a filtered client", async () => {
    const bindings: unknown[][] = [];
    const latest = "2026-01-01T00:00:00Z";
    const env = statsEnv(bindings, (query, values) => {
      if (query === queries.usageAggregate || query === queries.usageRoutes) {
        expect(values.slice(0, 2)).toEqual(["maintainers", "-86400 seconds"]);
        const scopes: Record<string, { requests: number; route_kind: string }> = {
          "/": { requests: 30, route_kind: "pool-route" },
          "caller-id/": { requests: 20, route_kind: "caller-route" },
          "caller-id/ci-runner": { requests: 10, route_kind: "client-route" },
        };
        const scope = scopes[values.slice(2).join("/")];
        expect(scope).toBeDefined();
        return query === queries.usageAggregate
          ? [{ requests: scope!.requests }]
          : [
              {
                route_kind: scope!.route_kind,
                requests: scope!.requests - 1,
                latest_seen_at: latest,
              },
            ];
      }
      switch (query) {
        case queries.usageClients:
          expect(values).toEqual(["maintainers", "caller-id", "-86400 seconds"]);
          return [{ client_name: "ci-runner", requests: 10, latest_seen_at: latest }];
        case queries.usageBackends:
          expect(values).toEqual(["maintainers", "-86400 seconds"]);
          return [
            {
              backend: "api",
              route_kind: "repository",
              requests: 7,
              cache_misses: 6,
              cache_bypass: null,
              revalidated: 1,
              latest_seen_at: latest,
            },
          ];
        case queries.usageFallbackReasons:
          expect(values).toEqual(["maintainers", "-86400 seconds"]);
          return [
            {
              reason: "route_denied",
              route_kind: "repository",
              requests: 2,
              latest_seen_at: latest,
            },
          ];
        case queries.cacheTotals:
          expect(values).toEqual(["maintainers"]);
          return [{ total_entries: 7, fresh_entries: 5, expired_entries: 2, body_bytes: 1024 }];
        default:
          throw new Error("unexpected stats query");
      }
    });
    const response = await poolStats(
      env,
      "maintainers",
      caller,
      { label: "24h", seconds: 86_400 },
      "ci-runner",
    );

    expect(response).toMatchObject({
      operator: { github_login: "caller", client_name: "test-mac" },
      client_filter: "ci-runner",
      pool_usage: { requests: 30 },
      caller_usage: { requests: 20 },
      client_usage: { requests: 10 },
      routes: [{ route_kind: "pool-route", requests: 29, latest_seen_at: latest }],
      caller_routes: [{ route_kind: "caller-route", requests: 19, latest_seen_at: latest }],
      client_routes: [{ route_kind: "client-route", requests: 9, latest_seen_at: latest }],
      clients: [{ client_name: "ci-runner", requests: 10, latest_seen_at: latest }],
      backends: [
        {
          backend: "api",
          route_kind: "repository",
          requests: 7,
          cache_misses: 6,
          cache_bypass: 0,
          revalidated: 1,
          latest_seen_at: latest,
        },
      ],
      fallback_reasons: [
        { reason: "route_denied", route_kind: "repository", requests: 2, latest_seen_at: latest },
      ],
      cache: { total_entries: 7, fresh_entries: 5, expired_entries: 2, body_bytes: 1024 },
    });
    expect(clientScopedBindings(bindings)).toEqual([
      ["maintainers", "-86400 seconds", "caller-id", "ci-runner"],
      ["maintainers", "-86400 seconds", "caller-id", "ci-runner"],
    ]);
  });
});

type StatsStatement = { query: string; values: unknown[] };

function statsEnv(
  bindings: unknown[][],
  rowsFor: (query: string, values: unknown[]) => Record<string, unknown>[] = () => [],
): Env {
  const prepare = vi.fn((query: string) => ({
    bind: (...values: unknown[]): StatsStatement => ({ query, values }),
  }));
  const batch = vi.fn(async (statements: StatsStatement[]) =>
    statements.map(({ query, values }) => {
      bindings.push(values);
      return { results: rowsFor(query, values) };
    }),
  );
  return { DB: { prepare, batch } } as unknown as Env;
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
