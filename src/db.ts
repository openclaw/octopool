import { cachedConfigLookup } from "./config-cache";
import { relayTiming, relayPhasePromise, withRelayTiming } from "./relay-timing";
import type { CacheMissReason } from "./cache";
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
  return relayPhasePromise("pool_policy", () =>
    cachedConfigLookup(`policy:${pool}`, async () => {
      const row = await env.DB.prepare(queries.getPoolPolicy).bind(pool).first<PoolRow>();
      if (row === null) {
        return null;
      }
      return parsePolicy(row.policy_json, env.DEFAULT_ALLOWED_OWNERS);
    }),
  );
}

export async function loadIdentities(
  env: Env,
  pool: string,
  route: RouteInfo,
  // fresh: authoritative-recheck moments (e.g. proving a cached row's source
  // identity is still active after a 304) must not serve from the config cache.
  options: { fresh?: boolean } = {},
): Promise<Identity[]> {
  const lookup = <T>(key: string, load: () => Promise<T>) =>
    relayPhasePromise("identity_eligibility", () =>
      options.fresh === true ? load() : cachedConfigLookup(key, load),
    );
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
  const identities = await lookup(`identities:${pool}:${owner}/${repo}`, async () => {
    const rows = await env.DB.prepare(queries.listActiveIdentitiesForRoute)
      .bind(pool, owner, repo)
      .all<IdentityRow>();
    return rows.results;
  });
  return route.kind === "graphql_read"
    ? identities.filter((identity) => identity.kind === "github_app")
    : identities;
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
    requestedMaxAge?: number | null;
    cacheMissReason?: CacheMissReason | null;
    timingsJSON?: string;
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
      event.requestedMaxAge ?? null,
      event.cacheMissReason ?? null,
      event.timingsJSON ?? null,
    )
    .run();
}

// Wait for the frozen response snapshot so the audit and header agree.
export function scheduleRelayAudit(
  env: Env,
  ctx: ExecutionContext,
  event: Parameters<typeof insertAudit>[1],
): void {
  const timing = relayTiming();
  const insert = () =>
    withRelayTiming(undefined, () =>
      ctx.waitUntil(
        insertAudit(env, {
          ...event,
          ...(timing?.json === undefined ? {} : { timingsJSON: timing.json }),
        }),
      ),
    );
  if (timing === undefined) insert();
  else timing.onReady(insert);
}

export async function pruneOldAuditEvents(env: Env, limit = 500): Promise<number> {
  const result = await env.DB.prepare(queries.deleteOldAuditEventsBatch).bind(limit).run();
  return result.meta.changes;
}
