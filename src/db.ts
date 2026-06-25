import { defaultPolicy, parsePolicy } from "./policy";
import { queries } from "./generated/sql";
import type { Identity, PoolPolicy, RouteInfo } from "./types";

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
  const row = await env.DB.prepare(queries.getPoolPolicy).bind(pool).first<PoolRow>();
  if (row === null) {
    return null;
  }
  return parsePolicy(row.policy_json, env.DEFAULT_ALLOWED_OWNERS);
}

export async function loadIdentities(
  env: Env,
  pool: string,
  route: RouteInfo,
): Promise<Identity[]> {
  if (route.owner === undefined) {
    const rows = await env.DB.prepare(queries.listActiveIdentitiesForPool)
      .bind(pool)
      .all<IdentityRow>();
    return rows.results;
  }
  if (route.publicOnly) {
    const rows = await env.DB.prepare(queries.listActivePublicIdentitiesForPool)
      .bind(pool)
      .all<IdentityRow>();
    return rows.results;
  }
  const owner = route.owner ?? "";
  const repo = route.repo ?? "";
  const rows = await env.DB.prepare(queries.listActiveIdentitiesForRoute)
    .bind(pool, owner, repo)
    .all<IdentityRow>();
  return rows.results;
}

export async function insertAudit(
  env: Env,
  event: {
    requestId: string;
    callerId: string;
    pool: string;
    routeKey: string;
    routeKind: string;
    identityId?: string;
    status: number;
    errorCode?: string;
    fallbackReason?: string;
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
      event.pool,
      event.routeKey,
      event.routeKind,
      event.identityId ?? null,
      event.status,
      event.errorCode ?? null,
      event.fallbackReason ?? null,
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
