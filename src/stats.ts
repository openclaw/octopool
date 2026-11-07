import { HttpError } from "./http";
import { queries } from "./generated/sql";
import {
  normalizeAggregate,
  normalizeCacheTotals,
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
  const since = `-${window.seconds} seconds`;
  const usage = (query: string, callerId = "", clientName = "") =>
    env.DB.prepare(query).bind(pool, since, callerId, clientName);
  // A single read-only batch keeps the report on one database snapshot and
  // avoids ten independent Worker-to-D1 round trips.
  const results = await env.DB.batch([
    usage(queries.usageAggregate),
    usage(queries.usageAggregate, caller.id),
    usage(queries.usageAggregate, caller.id, statsClientName),
    usage(queries.usageRoutes),
    usage(queries.usageRoutes, caller.id),
    usage(queries.usageRoutes, caller.id, statsClientName),
    env.DB.prepare(queries.usageClients).bind(pool, caller.id, since),
    env.DB.prepare(queries.usageBackends).bind(pool, since),
    env.DB.prepare(queries.usageFallbackReasons).bind(pool, since),
    env.DB.prepare(queries.cacheTotals).bind(pool),
  ]);
  const aggregate = (index: number) =>
    normalizeAggregate((results[index]!.results as UsageAggregateRow[])[0] ?? null);
  const routes = (index: number) =>
    (results[index]!.results as RouteRow[]).map((row) => ({
      route_kind: row.route_kind,
      latest_seen_at: row.latest_seen_at,
      ...normalizeAggregate(row),
    }));
  return {
    generated_at: new Date().toISOString(),
    pool,
    window,
    operator: {
      github_login: caller.github_login,
      client_name: caller.client_name,
    },
    ...(clientFilter === undefined ? {} : { client_filter: clientFilter }),
    pool_usage: aggregate(0),
    caller_usage: aggregate(1),
    client_usage: aggregate(2),
    routes: routes(3),
    caller_routes: routes(4),
    client_routes: routes(5),
    clients: (results[6]!.results as ClientRow[]).map((row) => ({
      client_name: row.client_name,
      latest_seen_at: row.latest_seen_at,
      ...normalizeAggregate(row),
    })),
    backends: (results[7]!.results as BackendRow[]).map((row) => ({
      ...row,
      cache_misses: row.cache_misses ?? 0,
      cache_bypass: row.cache_bypass ?? 0,
      revalidated: row.revalidated ?? 0,
    })),
    fallback_reasons: results[8]!.results as FallbackReasonRow[],
    cache: normalizeCacheTotals((results[9]!.results as CacheTotalsRow[])[0] ?? null),
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
