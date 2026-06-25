import { HttpError } from "./http";
import { queries } from "./generated/sql";
import {
  normalizeAggregate,
  normalizeCacheTotals,
  type CacheAggregate,
  type CacheTotalsRow,
  type UsageAggregateRow,
} from "./metrics";
import type { Caller } from "./types";

const MAX_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export type StatsWindow = {
  label: string;
  seconds: number;
};

type RouteRow = UsageAggregateRow & {
  route_kind: string;
  latest_seen_at: string;
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
  const row = await env.DB.prepare(queries.usageAggregate)
    .bind(pool, `-${windowSeconds} seconds`, callerId ?? "")
    .first<UsageAggregateRow>();
  return normalizeAggregate(row);
}

async function routeUsage(
  env: Env,
  pool: string,
  windowSeconds: number,
  callerId?: string,
): Promise<(CacheAggregate & { route_kind: string; latest_seen_at: string | null })[]> {
  const rows = await env.DB.prepare(queries.usageRoutes)
    .bind(pool, `-${windowSeconds} seconds`, callerId ?? "")
    .all<RouteRow>();
  return rows.results.map((row) => ({
    route_kind: row.route_kind,
    latest_seen_at: row.latest_seen_at,
    ...normalizeAggregate(row),
  }));
}

async function cacheTotals(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.cacheTotals).bind(pool).first<CacheTotalsRow>();
  return normalizeCacheTotals(row);
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
