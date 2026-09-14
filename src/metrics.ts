export type CacheActivityRow = {
  cache_hits: number | null;
  cache_stale: number | null;
  cache_misses: number | null;
  cache_bypass: number | null;
  coalesced: number | null;
  eligible_cache_hits?: number | null;
  eligible_cache_requests: number | null;
};

export type UsageAggregateRow = CacheActivityRow & {
  requests: number;
  errors: number | null;
  service_errors: number | null;
  fallbacks: number | null;
  operational_fallbacks?: number | null;
  denied?: number | null;
  avg_duration_ms: number | null;
  cache_unknown: number | null;
  cacheable_requests: number | null;
  latest_seen_at?: string | null;
};

export type CacheAggregate = {
  requests: number;
  errors: number;
  service_errors: number;
  fallbacks: number;
  avg_duration_ms: number | null;
  cache_hits: number;
  cache_stale: number;
  cache_misses: number;
  cache_bypass: number;
  cache_unknown: number;
  cacheable_requests: number;
  eligible_cache_requests: number;
  cache_hit_rate: number | null;
  cacheable_hit_rate: number | null;
  eligible_cache_hit_rate: number | null;
  bypass_rate: number | null;
  coalesced: number;
  cache_served_responses: number;
  uncached_outcomes: number;
  /** @deprecated Historical alias for cache_served_responses, not avoided GitHub requests. */
  saved_github_requests: number;
  /** @deprecated Historical alias for uncached_outcomes, not upstream fetches. */
  backend_requests: number;
};

export type CacheTotalsRow = {
  total_entries: number;
  fresh_entries: number | null;
  expired_entries: number | null;
  body_bytes: number | null;
  oldest_created_at?: string | null;
  newest_created_at?: string | null;
};

export function normalizeCacheActivity(row: CacheActivityRow | null, eligibleSuccessOnly = true) {
  const cacheHits = row?.cache_hits ?? 0;
  const cacheStale = row?.cache_stale ?? 0;
  const cacheMisses = row?.cache_misses ?? 0;
  const cacheServed = cacheHits + cacheStale;
  const cacheDenominator = cacheServed + cacheMisses;
  const eligibleHits = eligibleSuccessOnly
    ? (row?.eligible_cache_hits ?? cacheServed)
    : cacheServed;
  const eligibleRequests = row?.eligible_cache_requests ?? 0;
  return {
    cache_hits: cacheHits,
    cache_stale: cacheStale,
    cache_misses: cacheMisses,
    cache_bypass: row?.cache_bypass ?? 0,
    coalesced: row?.coalesced ?? 0,
    cache_hit_rate: cacheDenominator === 0 ? null : cacheServed / cacheDenominator,
    eligible_cache_hit_rate: eligibleRequests === 0 ? null : eligibleHits / eligibleRequests,
    cache_served_responses: cacheServed,
    uncached_outcomes: cacheMisses + (row?.cache_bypass ?? 0),
  };
}

export function normalizeAggregate(row: UsageAggregateRow | null): CacheAggregate {
  const cache = normalizeCacheActivity(row, false);
  const requests = row?.requests ?? 0;
  const cacheUnknown = row?.cache_unknown ?? 0;
  const cacheableRequests = row?.cacheable_requests ?? 0;
  return {
    requests,
    errors: row?.errors ?? 0,
    service_errors: row?.service_errors ?? 0,
    fallbacks: row?.fallbacks ?? 0,
    avg_duration_ms: row?.avg_duration_ms ?? null,
    cache_hits: cache.cache_hits,
    cache_stale: cache.cache_stale,
    cache_misses: cache.cache_misses,
    cache_bypass: cache.cache_bypass,
    cache_unknown: cacheUnknown,
    cacheable_requests: cacheableRequests,
    eligible_cache_requests: row?.eligible_cache_requests ?? 0,
    cache_hit_rate: cache.cache_hit_rate,
    cacheable_hit_rate:
      cacheableRequests === 0 ? null : cache.cache_served_responses / cacheableRequests,
    eligible_cache_hit_rate: cache.eligible_cache_hit_rate,
    bypass_rate: requests === 0 ? null : cache.cache_bypass / requests,
    coalesced: cache.coalesced,
    cache_served_responses: cache.cache_served_responses,
    uncached_outcomes: cache.uncached_outcomes,
    saved_github_requests: cache.cache_served_responses,
    backend_requests: cache.uncached_outcomes,
  };
}

export function normalizeCacheTotals(row: CacheTotalsRow | null) {
  return {
    total_entries: row?.total_entries ?? 0,
    fresh_entries: row?.fresh_entries ?? 0,
    expired_entries: row?.expired_entries ?? 0,
    body_bytes: row?.body_bytes ?? 0,
  };
}
