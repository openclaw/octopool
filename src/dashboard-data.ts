import { queries } from "./generated/sql";
import { HttpError, jsonResponse } from "./http";
import {
  normalizeCacheActivity,
  normalizeCacheTotals,
  type CacheTotalsRow,
  type UsageAggregateRow,
} from "./metrics";
import { requireDashboardAdmin } from "./web-session";

export async function dashboardData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pool = url.searchParams.get("pool")?.trim() || "maintainers";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(pool)) {
    throw new HttpError(400, "pool_invalid", "Pool id is invalid");
  }
  const operator = await requireDashboardAdmin(request, env, pool);
  const coordinator = env.POOL_COORDINATOR.getByName(`pool:${pool}`);
  const [
    identities,
    cache,
    usage,
    users,
    clients,
    recent,
    routeUsage,
    routeKeys7d,
    errorCodes7d,
    identityUsage,
    publicRepos,
    coordinatorSnapshot,
  ] = await Promise.all([
    dashboardIdentities(env, pool),
    dashboardCache(env, pool),
    dashboardUsage(env, pool),
    dashboardUsers(env, pool),
    dashboardClients(env, pool),
    dashboardRecent(env, pool),
    dashboardRouteUsage(env, pool),
    dashboardRouteKeys7d(env, pool),
    dashboardErrorCodes7d(env, pool),
    dashboardIdentityUsage(env, pool),
    dashboardPublicRepos(env),
    coordinator.snapshot(),
  ]);
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
    cache,
    usage,
    users,
    clients,
    recent,
    route_usage: routeUsage,
    route_keys_7d: routeKeys7d,
    error_codes_7d: errorCodes7d,
    identity_usage: identityUsage,
    public_repos: publicRepos,
    coordinator: coordinatorSnapshot,
  });
}

async function dashboardUsage(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.usageAggregate)
    .bind(pool, "-24 hours", "", "")
    .first<UsageAggregateRow>();
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

async function dashboardIdentities(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardIdentities).bind(pool).all<{
    id: string;
    kind: string;
    login: string;
    installation_id: number | null;
    status: string;
    weight: number;
    updated_at: string;
  }>();
  return rows.results;
}

async function dashboardCache(env: Env, pool: string) {
  const row = await env.DB.prepare(queries.cacheTotals).bind(pool).first<CacheTotalsRow>();
  return {
    ...normalizeCacheTotals(row),
    oldest_created_at: row?.oldest_created_at ?? null,
    newest_created_at: row?.newest_created_at ?? null,
    routes: await dashboardCacheRoutes(env, pool),
  };
}

async function dashboardCacheRoutes(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardCacheRoutes).bind(pool).all<{
    route_kind: string;
    entries: number;
    fresh_entries: number | null;
    latest_created_at: string | null;
  }>();
  return rows.results.map((row) => ({
    ...row,
    fresh_entries: row.fresh_entries ?? 0,
  }));
}

async function dashboardUsers(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardUsers).bind(pool).all<{
    id: string;
    name: string;
    github_login: string;
    requests: number;
    errors: number | null;
    avg_duration_ms: number | null;
    last_seen: string | null;
  }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardClients(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardClients).bind(pool).all<{
    github_login: string;
    client_name: string;
    requests: number;
    errors: number | null;
    saved_github_requests: number | null;
    backend_requests: number | null;
    last_seen: string | null;
  }>();
  return rows.results.map((row) => ({
    ...row,
    errors: row.errors ?? 0,
    saved_github_requests: row.saved_github_requests ?? 0,
    backend_requests: row.backend_requests ?? 0,
  }));
}

async function dashboardRecent(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardRecent).bind(pool).all<{
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
  }>();
  return rows.results;
}

async function dashboardRouteUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.usageRoutes)
    .bind(pool, "-24 hours", "", "")
    .all<UsageAggregateRow & { route_kind: string }>();
  return rows.results.map((row) => {
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

async function dashboardRouteKeys7d(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardRouteKeys7d).bind(pool).all<{
    route_kind: string;
    route_key: string;
    requests: number;
    cache_hits: number | null;
    cache_misses: number | null;
    coalesced: number | null;
    fallbacks: number | null;
    service_errors: number | null;
    latest_seen_at: string | null;
  }>();
  return rows.results.map((row) => ({
    ...row,
    cache_hits: row.cache_hits ?? 0,
    cache_misses: row.cache_misses ?? 0,
    coalesced: row.coalesced ?? 0,
    fallbacks: row.fallbacks ?? 0,
    service_errors: row.service_errors ?? 0,
  }));
}

async function dashboardErrorCodes7d(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardErrorCodes7d).bind(pool).all<{
    outcome: string;
    route_kind: string;
    requests: number;
    latest_seen_at: string | null;
  }>();
  return rows.results;
}

async function dashboardIdentityUsage(env: Env, pool: string) {
  const rows = await env.DB.prepare(queries.dashboardIdentityUsage)
    .bind(pool)
    .all<{ identity_id: string; requests: number; errors: number | null }>();
  return rows.results.map((row) => ({ ...row, errors: row.errors ?? 0 }));
}

async function dashboardPublicRepos(env: Env) {
  const row = await env.DB.prepare(queries.dashboardPublicRepos).first<{
    total_entries: number;
    fresh_entries: number | null;
    newest_checked_at: string | null;
  }>();
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    newest_checked_at: row?.newest_checked_at ?? null,
  };
}
