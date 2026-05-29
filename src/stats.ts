import { HttpError } from "./http";
import { queries } from "./generated/sql";
import type { Caller } from "./types";

const MAX_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export type StatsWindow = {
  label: string;
  seconds: number;
};

export type CacheAggregate = {
  requests: number;
  errors: number;
  avg_duration_ms: number | null;
  cache_hits: number;
  cache_misses: number;
  cache_bypass: number;
  cache_unknown: number;
  cacheable_requests: number;
  cache_hit_rate: number | null;
  cacheable_hit_rate: number | null;
  bypass_rate: number | null;
  saved_github_requests: number;
  backend_requests: number;
};

export type AggregateRow = {
  requests: number;
  errors: number | null;
  avg_duration_ms: number | null;
  cache_hits: number | null;
  cache_misses: number | null;
  cache_bypass: number | null;
  cache_unknown: number | null;
  cacheable_requests: number | null;
};

type RouteRow = AggregateRow & {
  route_kind: string;
  latest_seen_at: string | null;
};

export function parseStatsWindow(raw: string | null): StatsWindow {
  const fallback = { label: "24h", seconds: 24 * 60 * 60 };
  if (raw === null || raw.trim() === "") {
    return fallback;
  }
  const trimmed = raw.trim().toLowerCase();
  const match = /^([1-9][0-9]*)(m|h|d)?$/.exec(trimmed);
  if (match === null) {
    throw new HttpError(400, "invalid_window", "since must look like 30m, 24h, or 7d");
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "h";
  const seconds = amount * unitSeconds(unit);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_WINDOW_SECONDS) {
    throw new HttpError(400, "invalid_window", "since must be between 1 minute and 30 days");
  }
  return { label: `${amount}${unit}`, seconds };
}

export async function poolStats(env: Env, pool: string, caller: Caller, window: StatsWindow) {
  const [poolUsage, callerUsage, routes, callerRoutes, cache] = await Promise.all([
    aggregateUsage(env, pool, window.seconds),
    aggregateUsage(env, pool, window.seconds, caller.id),
    routeUsage(env, pool, window.seconds),
    routeUsage(env, pool, window.seconds, caller.id),
    cacheTotals(env, pool),
  ]);
  return {
    generated_at: new Date().toISOString(),
    pool,
    window,
    operator: {
      github_login: caller.github_login,
    },
    pool_usage: poolUsage,
    caller_usage: callerUsage,
    routes,
    caller_routes: callerRoutes,
    cache,
  };
}

async function aggregateUsage(
  env: Env,
  pool: string,
  windowSeconds: number,
  callerId?: string,
): Promise<CacheAggregate> {
  const statement = env.DB.prepare(
    callerId === undefined ? queries.statsAggregatePool : queries.statsAggregateCaller,
  );
  const bound =
    callerId === undefined
      ? statement.bind(pool, `-${windowSeconds} seconds`)
      : statement.bind(pool, `-${windowSeconds} seconds`, callerId);
  const row = await bound.first<AggregateRow>();
  return normalizeAggregate(row);
}

async function routeUsage(
  env: Env,
  pool: string,
  windowSeconds: number,
  callerId?: string,
): Promise<(CacheAggregate & { route_kind: string; latest_seen_at: string | null })[]> {
  const statement = env.DB.prepare(
    callerId === undefined ? queries.statsRoutesPool : queries.statsRoutesCaller,
  );
  const bound =
    callerId === undefined
      ? statement.bind(pool, `-${windowSeconds} seconds`)
      : statement.bind(pool, `-${windowSeconds} seconds`, callerId);
  const rows = await bound.all<RouteRow>();
  return rows.results.map((row) => ({
    route_kind: row.route_kind,
    latest_seen_at: row.latest_seen_at,
    ...normalizeAggregate(row),
  }));
}

async function cacheTotals(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.statsCacheTotals).bind(pool).first<{
    total_entries: number;
    fresh_entries: number | null;
    expired_entries: number | null;
    body_bytes: number | null;
  }>();
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    expired_entries: row?.expired_entries ?? 0,
    body_bytes: row?.body_bytes ?? 0,
  };
}

export function normalizeAggregate(row: AggregateRow | null): CacheAggregate {
  const cacheHits = row?.cache_hits ?? 0;
  const cacheMisses = row?.cache_misses ?? 0;
  const denominator = cacheHits + cacheMisses;
  const requests = row?.requests ?? 0;
  const cacheBypass = row?.cache_bypass ?? 0;
  const cacheUnknown = row?.cache_unknown ?? 0;
  const cacheableRequests = row?.cacheable_requests ?? 0;
  return {
    requests,
    errors: row?.errors ?? 0,
    avg_duration_ms: row?.avg_duration_ms ?? null,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
    cache_bypass: cacheBypass,
    cache_unknown: cacheUnknown,
    cacheable_requests: cacheableRequests,
    cache_hit_rate: denominator === 0 ? null : cacheHits / denominator,
    cacheable_hit_rate: cacheableRequests === 0 ? null : cacheHits / cacheableRequests,
    bypass_rate: requests === 0 ? null : cacheBypass / requests,
    saved_github_requests: cacheHits,
    backend_requests: cacheMisses + cacheBypass,
  };
}

function unitSeconds(unit: string): number {
  switch (unit) {
    case "m":
      return 60;
    case "h":
      return 60 * 60;
    case "d":
      return 24 * 60 * 60;
    default:
      throw new HttpError(400, "invalid_window", "since unit must be m, h, or d");
  }
}
