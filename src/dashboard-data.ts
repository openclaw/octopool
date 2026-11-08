import { CACHE_PUBLICATION_EPOCH } from "./cache-publication";
import { queries } from "./generated/sql";
import { HttpError, jsonResponse } from "./http";
import {
  normalizeCacheActivity,
  normalizeCacheTotals,
  type CacheTotalsRow,
  type UsageAggregateRow,
} from "./metrics";
import { poolCoordinatorStub } from "./pool-coordinator";
import { requireDashboardAdmin } from "./web-session";

export async function dashboardData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pool = url.searchParams.get("pool")?.trim() || "maintainers";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(pool)) {
    throw new HttpError(400, "pool_invalid", "Pool id is invalid");
  }
  const operator = await requireDashboardAdmin(request, env, pool);
  const coordinator = poolCoordinatorStub(env, pool);
  // Keep all D1 panels on one read snapshot and one database round trip.
  const [results, coordinatorSnapshot] = await Promise.all([
    env.DB.batch([
      env.DB.prepare(queries.dashboardIdentities).bind(pool),
      env.DB.prepare(queries.cacheTotals).bind(pool),
      env.DB.prepare(queries.dashboardCacheRoutes).bind(pool),
      env.DB.prepare(queries.usageAggregate).bind(pool, "-24 hours", "", ""),
      env.DB.prepare(queries.dashboardUsers).bind(pool),
      env.DB.prepare(queries.dashboardClients).bind(pool),
      env.DB.prepare(queries.dashboardRecent).bind(pool),
      env.DB.prepare(queries.usageRoutes).bind(pool, "-24 hours", "", ""),
      env.DB.prepare(queries.dashboardRouteKeys7d).bind(pool),
      env.DB.prepare(queries.dashboardErrorCodes7d).bind(pool),
      env.DB.prepare(queries.dashboardIdentityUsage).bind(pool),
      env.DB.prepare(queries.dashboardPublicRepos).bind(CACHE_PUBLICATION_EPOCH),
    ]),
    coordinator.snapshot(),
  ]);
  const format = <T, R>(index: number, normalize: (rows: T[]) => R): R =>
    normalize(results[index]!.results as T[]);
  const identities = format(0, dashboardIdentities);
  return jsonResponse({
    generated_at: new Date().toISOString(),
    pool,
    operator: {
      kind: "web",
      github_login: operator.github_login,
      dashboard_role: operator.dashboard_role,
    },
    identities: {
      total: identities.length,
      active: identities.filter((identity) => identity.status === "active").length,
      items: identities,
    },
    cache: { ...format(1, dashboardCache), routes: format(2, dashboardCacheRoutes) },
    usage: format(3, dashboardUsage),
    users: format(4, dashboardUsers),
    clients: format(5, dashboardClients),
    recent: format(6, dashboardRecent),
    route_usage: format(7, dashboardRouteUsage),
    route_keys_7d: format(8, dashboardRouteKeys7d),
    error_codes_7d: format(9, dashboardErrorCodes7d),
    identity_usage: format(10, dashboardIdentityUsage),
    public_repos: format(11, dashboardPublicRepos),
    coordinator: coordinatorSnapshot,
  });
}

function dashboardUsage(rows: UsageAggregateRow[]) {
  const row = rows[0] ?? null;
  const cache = normalizeCacheActivity(row);
  return {
    requests_24h: row?.requests ?? 0,
    errors_24h: row?.errors ?? 0,
    service_errors_24h: row?.service_errors ?? 0,
    fallbacks_24h: row?.operational_fallbacks ?? 0,
    denied_24h: row?.denied ?? 0,
    cache_hits_24h: cache.cache_hits,
    cache_stale_24h: cache.cache_stale,
    cache_misses_24h: cache.cache_misses,
    cache_bypass_24h: cache.cache_bypass,
    coalesced_24h: cache.coalesced,
    cache_hit_rate_24h: cache.cache_hit_rate,
    eligible_cache_hit_rate_24h: cache.eligible_cache_hit_rate,
    avg_duration_ms_24h: row?.avg_duration_ms ?? null,
    latest_seen_at: row?.latest_seen_at ?? null,
  };
}

function dashboardIdentities(
  rows: {
    id: string;
    kind: string;
    login: string;
    installation_id: number | null;
    status: string;
    weight: number;
    updated_at: string;
  }[],
) {
  return rows;
}

function dashboardCache(rows: CacheTotalsRow[]) {
  const row = rows[0] ?? null;
  return {
    ...normalizeCacheTotals(row),
    oldest_created_at: row?.oldest_created_at ?? null,
    newest_created_at: row?.newest_created_at ?? null,
  };
}

function dashboardCacheRoutes(
  rows: {
    route_kind: string;
    entries: number;
    fresh_entries: number | null;
    latest_created_at: string | null;
  }[],
) {
  return rows.map((row) => ({
    ...row,
    fresh_entries: row.fresh_entries ?? 0,
  }));
}

function dashboardUsers(
  rows: {
    id: string;
    name: string;
    github_login: string;
    requests: number;
    errors: number | null;
    avg_duration_ms: number | null;
    last_seen: string | null;
  }[],
) {
  return rows.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

function dashboardClients(
  rows: {
    github_login: string;
    client_name: string;
    requests: number;
    errors: number | null;
    cache_served_responses: number | null;
    uncached_outcomes: number | null;
    last_seen: string | null;
  }[],
) {
  return rows.map((row) => ({
    ...row,
    errors: row.errors ?? 0,
    cache_served_responses: row.cache_served_responses ?? 0,
    uncached_outcomes: row.uncached_outcomes ?? 0,
    // Deprecated wire aliases count relay outcomes, not avoided or actual upstream requests.
    saved_github_requests: row.cache_served_responses ?? 0,
    backend_requests: row.uncached_outcomes ?? 0,
  }));
}

function dashboardRecent(
  rows: {
    created_at: string;
    github_login: string;
    client_name: string | null;
    route_kind: string;
    route_key: string;
    identity_id: string | null;
    status: number;
    error_code: string | null;
    fallback_reason: string | null;
    duration_ms: number;
  }[],
) {
  return rows;
}

function dashboardRouteUsage(rows: (UsageAggregateRow & { route_kind: string })[]) {
  return rows.map((row) => {
    const cache = normalizeCacheActivity(row);
    const eligibleHits = row.eligible_cache_hits ?? 0;
    const eligibleRequests = row.eligible_cache_requests ?? 0;
    return {
      route_kind: row.route_kind,
      requests: row.requests,
      errors: row.errors ?? 0,
      service_errors: row.service_errors ?? 0,
      fallbacks: row.operational_fallbacks ?? 0,
      cache_hits: cache.cache_hits,
      cache_stale: cache.cache_stale,
      cache_misses: cache.cache_misses,
      cache_bypass: cache.cache_bypass,
      coalesced: cache.coalesced,
      eligible_hits: eligibleHits,
      eligible_misses: eligibleRequests - eligibleHits,
      cache_hit_rate: cache.cache_hit_rate,
      eligible_cache_hit_rate: cache.eligible_cache_hit_rate,
    };
  });
}

function dashboardRouteKeys7d(
  rows: {
    route_kind: string;
    route_key: string;
    requests: number;
    cache_hits: number | null;
    cache_misses: number | null;
    coalesced: number | null;
    fallbacks: number | null;
    service_errors: number | null;
    latest_seen_at: string | null;
  }[],
) {
  return rows.map((row) => ({
    ...row,
    cache_hits: row.cache_hits ?? 0,
    cache_misses: row.cache_misses ?? 0,
    coalesced: row.coalesced ?? 0,
    fallbacks: row.fallbacks ?? 0,
    service_errors: row.service_errors ?? 0,
  }));
}

function dashboardErrorCodes7d(
  rows: {
    outcome: string;
    route_kind: string;
    requests: number;
    latest_seen_at: string | null;
  }[],
) {
  return rows;
}

function dashboardIdentityUsage(
  rows: { identity_id: string; requests: number; errors: number | null }[],
) {
  return rows.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

function dashboardPublicRepos(
  rows: {
    total_entries: number;
    fresh_entries: number | null;
    newest_checked_at: string | null;
  }[],
) {
  const row = rows[0] ?? null;
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    newest_checked_at: row?.newest_checked_at ?? null,
  };
}
