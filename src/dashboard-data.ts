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

type IdentityRow = {
  id: string;
  kind: string;
  login: string;
  installation_id: number | null;
  status: string;
  weight: number;
  updated_at: string;
};

type CacheRouteRow = {
  route_kind: string;
  entries: number;
  fresh_entries: number | null;
  latest_created_at: string | null;
};

type UserRow = {
  id: string;
  name: string;
  github_login: string;
  requests: number;
  errors: number | null;
  avg_duration_ms: number | null;
  last_seen: string | null;
};

type ClientRow = {
  github_login: string;
  client_name: string;
  requests: number;
  errors: number | null;
  cache_served_responses: number | null;
  uncached_outcomes: number | null;
  last_seen: string | null;
};

type RecentRow = {
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
};

type RouteKeyRow = {
  route_kind: string;
  route_key: string;
  requests: number;
  cache_hits: number | null;
  cache_misses: number | null;
  coalesced: number | null;
  fallbacks: number | null;
  service_errors: number | null;
  latest_seen_at: string | null;
};

type ErrorCodeRow = {
  outcome: string;
  route_kind: string;
  requests: number;
  latest_seen_at: string | null;
};

type IdentityUsageRow = { identity_id: string; requests: number; errors: number | null };

type PublicRepoRow = {
  total_entries: number;
  fresh_entries: number | null;
  newest_checked_at: string | null;
};

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
  const rows = <T>(index: number) => results[index]!.results as T[];
  const identities = rows<IdentityRow>(0);
  const cache = rows<CacheTotalsRow>(1)[0] ?? null;
  const publicRepos = rows<PublicRepoRow>(11)[0];
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
    cache: {
      ...normalizeCacheTotals(cache),
      oldest_created_at: cache?.oldest_created_at ?? null,
      newest_created_at: cache?.newest_created_at ?? null,
      routes: rows<CacheRouteRow>(2).map((row) => ({
        ...row,
        fresh_entries: row.fresh_entries ?? 0,
      })),
    },
    usage: dashboardUsage(rows<UsageAggregateRow>(3)[0] ?? null),
    users: rows<UserRow>(4).map((row) => ({ ...row, errors: row.errors ?? 0 })),
    clients: rows<ClientRow>(5).map((row) => ({
      ...row,
      errors: row.errors ?? 0,
      cache_served_responses: row.cache_served_responses ?? 0,
      uncached_outcomes: row.uncached_outcomes ?? 0,
      // Deprecated wire aliases count relay outcomes, not avoided or actual upstream requests.
      saved_github_requests: row.cache_served_responses ?? 0,
      backend_requests: row.uncached_outcomes ?? 0,
    })),
    recent: rows<RecentRow>(6),
    route_usage: dashboardRouteUsage(rows<UsageAggregateRow & { route_kind: string }>(7)),
    route_keys_7d: rows<RouteKeyRow>(8).map((row) => ({
      ...row,
      cache_hits: row.cache_hits ?? 0,
      cache_misses: row.cache_misses ?? 0,
      coalesced: row.coalesced ?? 0,
      fallbacks: row.fallbacks ?? 0,
      service_errors: row.service_errors ?? 0,
    })),
    error_codes_7d: rows<ErrorCodeRow>(9),
    identity_usage: rows<IdentityUsageRow>(10).map((row) => ({ ...row, errors: row.errors ?? 0 })),
    public_repos: {
      total_entries: publicRepos?.total_entries ?? 0,
      fresh_entries: publicRepos?.fresh_entries ?? 0,
      newest_checked_at: publicRepos?.newest_checked_at ?? null,
    },
    coordinator: coordinatorSnapshot,
  });
}

function dashboardUsage(row: UsageAggregateRow | null) {
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
