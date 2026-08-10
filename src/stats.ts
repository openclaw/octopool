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

type ClientRow = UsageAggregateRow & {
  client_name: string;
  latest_seen_at: string;
};

type BackendRow = {
  backend: string;
  route_kind: string;
  requests: number;
  cache_misses: number | null;
  cache_bypass: number | null;
  revalidated: number | null;
  latest_seen_at: string | null;
};

type FallbackReasonRow = {
  reason: string;
  route_kind: string;
  requests: number;
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

export async function poolStats(
  env: Env,
  pool: string,
  caller: Caller,
  window: StatsWindow,
  clientFilter?: string,
) {
  const statsClientName = clientFilter ?? caller.client_name;
  const [
    poolUsage,
    callerUsage,
    currentClientUsage,
    routes,
    callerRoutes,
    clientRoutes,
    clients,
    backends,
    fallbackReasons,
    cache,
  ] = await Promise.all([
    aggregateUsage(env, pool, window.seconds),
    aggregateUsage(env, pool, window.seconds, caller.id),
    aggregateUsage(env, pool, window.seconds, caller.id, statsClientName),
    routeUsage(env, pool, window.seconds),
    routeUsage(env, pool, window.seconds, caller.id),
    routeUsage(env, pool, window.seconds, caller.id, statsClientName),
    loadClientUsage(env, pool, window.seconds, caller.id),
    loadBackendUsage(env, pool, window.seconds),
    loadFallbackReasons(env, pool, window.seconds),
    cacheTotals(env, pool),
  ]);
  return {
    generated_at: new Date().toISOString(),
    pool,
    window,
    operator: {
      github_login: caller.github_login,
      client_name: caller.client_name,
    },
    ...(clientFilter === undefined ? {} : { client_filter: clientFilter }),
    pool_usage: poolUsage,
    caller_usage: callerUsage,
    client_usage: currentClientUsage,
    routes,
    caller_routes: callerRoutes,
    client_routes: clientRoutes,
    clients,
    backends,
    fallback_reasons: fallbackReasons,
    cache,
  };
}

async function aggregateUsage(
  env: Env,
  pool: string,
  windowSeconds: number,
  callerId?: string,
  clientName?: string,
): Promise<CacheAggregate> {
  const row = await env.DB.prepare(queries.usageAggregate)
    .bind(pool, `-${windowSeconds} seconds`, callerId ?? "", clientName ?? "")
    .first<UsageAggregateRow>();
  return normalizeAggregate(row);
}

async function routeUsage(
  env: Env,
  pool: string,
  windowSeconds: number,
  callerId?: string,
  clientName?: string,
): Promise<(CacheAggregate & { route_kind: string; latest_seen_at: string | null })[]> {
  const rows = await env.DB.prepare(queries.usageRoutes)
    .bind(pool, `-${windowSeconds} seconds`, callerId ?? "", clientName ?? "")
    .all<RouteRow>();
  return rows.results.map((row) => ({
    route_kind: row.route_kind,
    latest_seen_at: row.latest_seen_at,
    ...normalizeAggregate(row),
  }));
}

async function loadClientUsage(env: Env, pool: string, windowSeconds: number, callerId: string) {
  const rows = await env.DB.prepare(queries.usageClients)
    .bind(pool, callerId, `-${windowSeconds} seconds`)
    .all<ClientRow>();
  return rows.results.map((row) => ({
    client_name: row.client_name,
    latest_seen_at: row.latest_seen_at,
    ...normalizeAggregate(row),
  }));
}

async function loadBackendUsage(env: Env, pool: string, windowSeconds: number) {
  const rows = await env.DB.prepare(queries.usageBackends)
    .bind(pool, `-${windowSeconds} seconds`)
    .all<BackendRow>();
  return rows.results.map((row) => ({
    ...row,
    cache_misses: row.cache_misses ?? 0,
    cache_bypass: row.cache_bypass ?? 0,
    revalidated: row.revalidated ?? 0,
  }));
}

async function loadFallbackReasons(env: Env, pool: string, windowSeconds: number) {
  const rows = await env.DB.prepare(queries.usageFallbackReasons)
    .bind(pool, `-${windowSeconds} seconds`)
    .all<FallbackReasonRow>();
  return rows.results;
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
