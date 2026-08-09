import { cachedConfigLookup } from "./config-cache";

function uncachedLookup<T>(_key: string, load: () => Promise<T>): Promise<T> {
  return load();
}
import { defaultPolicy, parsePolicy } from "./policy";
import { queries } from "./generated/sql";
import type { AuditBackend, Identity, PoolPolicy, RouteInfo } from "./types";

type PoolRow = {
  policy_json: string;
};

type IdentityRow = {
  id: string;
  kind: "pat" | "github_app";
  login: string;
  secret_ref: string;
  installation_id: number | null;
  weight: number;
};

export async function ensurePool(env: Env, pool: string): Promise<void> {
  const policy = JSON.stringify(defaultPolicy(env.DEFAULT_ALLOWED_OWNERS));
  await env.DB.prepare(queries.ensurePool).bind(pool, policy).run();
}

export async function loadPoolPolicy(env: Env, pool: string): Promise<PoolPolicy | null> {
  return cachedConfigLookup(`policy:${pool}`, async () => {
    const row = await env.DB.prepare(queries.getPoolPolicy).bind(pool).first<PoolRow>();
    if (row === null) {
      return null;
    }
    return parsePolicy(row.policy_json, env.DEFAULT_ALLOWED_OWNERS);
  });
}

export async function loadIdentities(
  env: Env,
  pool: string,
  route: RouteInfo,
  // fresh: authoritative-recheck moments (e.g. proving a cached row's source
  // identity is still active after a 304) must not serve from the config cache.
  options: { fresh?: boolean } = {},
): Promise<Identity[]> {
  const lookup = options.fresh === true ? uncachedLookup : cachedConfigLookup;
  if (route.owner === undefined) {
    return lookup(`identities:${pool}:*`, async () => {
      const rows = await env.DB.prepare(queries.listActiveIdentitiesForPool)
        .bind(pool)
        .all<IdentityRow>();
      return rows.results;
    });
  }
  if (route.publicOnly) {
    return lookup(`identities:${pool}:public`, async () => {
      const rows = await env.DB.prepare(queries.listActivePublicIdentitiesForPool)
        .bind(pool)
        .all<IdentityRow>();
      return rows.results;
    });
  }
  const owner = route.owner ?? "";
  const repo = route.repo ?? "";
  return lookup(`identities:${pool}:${owner}/${repo}`, async () => {
    const rows = await env.DB.prepare(queries.listActiveIdentitiesForRoute)
      .bind(pool, owner, repo)
      .all<IdentityRow>();
    return rows.results;
  });
}

export async function insertAudit(
  env: Env,
  event: {
    requestId: string;
    callerId: string;
    callerTokenId: string;
    clientName: string;
    pool: string;
    routeKey: string;
    routeKind: string;
    identityId?: string;
    status: number;
    errorCode?: string;
    fallbackReason?: string;
    backend?: AuditBackend;
    durationMs: number;
    cacheStatus?: "hit" | "miss" | "bypass" | "stale" | "unknown";
    cacheable?: boolean;
    coalesced?: boolean;
  },
): Promise<void> {
  await env.DB.prepare(queries.insertAudit)
    .bind(
      event.requestId,
      event.callerId,
      event.callerTokenId,
      event.clientName,
      event.pool,
      event.routeKey,
      event.routeKind,
      event.identityId ?? null,
      event.status,
      event.errorCode ?? null,
      event.fallbackReason ?? null,
      event.backend ?? null,
      event.durationMs,
      event.cacheStatus ?? "unknown",
      event.cacheable === true ? 1 : 0,
      event.coalesced === true ? 1 : 0,
    )
    .run();
}

export async function pruneOldAuditEvents(env: Env, limit = 500): Promise<number> {
  const result = await env.DB.prepare(queries.deleteOldAuditEventsBatch).bind(limit).run();
  return result.meta.changes;
}
