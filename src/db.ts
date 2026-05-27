import { defaultPolicy, parsePolicy } from "./policy";
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
  await env.DB.prepare(
    `INSERT INTO pools (id, name, policy_json)
     VALUES (?1, ?1, ?2)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(pool, policy)
    .run();
}

export async function loadPoolPolicy(env: Env, pool: string): Promise<PoolPolicy | null> {
  const row = await env.DB.prepare("SELECT policy_json FROM pools WHERE id = ?1")
    .bind(pool)
    .first<PoolRow>();
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
    const rows = await env.DB.prepare(
      `SELECT id, kind, login, secret_ref, installation_id, weight
       FROM identities
       WHERE pool_id = ?1
         AND status = 'active'`,
    )
      .bind(pool)
      .all<IdentityRow>();
    return rows.results;
  }
  const owner = route.owner ?? "";
  const repo = route.repo ?? "";
  const rows = await env.DB.prepare(
    `SELECT DISTINCT identities.id, identities.kind, identities.login, identities.secret_ref, identities.installation_id, identities.weight
     FROM identities
     JOIN identity_scopes ON identity_scopes.identity_id = identities.id
     WHERE identities.pool_id = ?1
       AND identities.status = 'active'
       AND lower(identity_scopes.owner) = lower(?2)
       AND (
         lower(identity_scopes.repo) = lower(?3)
         OR identity_scopes.repo IS NULL
       )`,
  )
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
    durationMs: number;
    cacheStatus?: "hit" | "miss" | "bypass" | "unknown";
    cacheable?: boolean;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
       (request_id, caller_id, pool_id, route_key, route_kind, identity_id, status, error_code, duration_ms, cache_status, cacheable)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      event.requestId,
      event.callerId,
      event.pool,
      event.routeKey,
      event.routeKind,
      event.identityId ?? null,
      event.status,
      event.errorCode ?? null,
      event.durationMs,
      event.cacheStatus ?? "unknown",
      event.cacheable === true ? 1 : 0,
    )
    .run();
}
