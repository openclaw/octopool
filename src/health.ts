import { queries } from "./generated/sql";
import { HttpError, jsonResponse } from "./http";
import { poolCoordinatorStub } from "./pool-coordinator";

export async function poolHealth(
  env: Env,
  pool: string,
  includeCapacity = false,
): Promise<Response> {
  const identities = await env.DB.prepare(queries.poolHealth)
    .bind(pool)
    .first<{ identities_total: number; identities_healthy: number | null }>();
  if (identities === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  const capacity = includeCapacity ? await observedCapacity(env, pool) : undefined;
  return jsonResponse({
    pool,
    identities_total: identities.identities_total,
    identities_active: identities.identities_healthy ?? 0,
    identities_healthy: identities.identities_healthy ?? 0,
    health_basis: "configuration",
    ...(capacity === undefined ? {} : { capacity }),
    policy_version: 1,
  });
}

async function observedCapacity(env: Env, pool: string) {
  const snapshot = await poolCoordinatorStub(env, pool).snapshot();
  const resources = new Map<
    string,
    { observed_identities: number; exhausted_identities: number }
  >();
  for (const rate of snapshot.rates) {
    const counts = resources.get(rate.resource) ?? {
      observed_identities: 0,
      exhausted_identities: 0,
    };
    counts.observed_identities++;
    if (rate.remaining === 0) counts.exhausted_identities++;
    resources.set(rate.resource, counts);
  }
  return {
    source: "coordinator_snapshot",
    observed_at: new Date().toISOString(),
    rate_limits: [...resources]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, counts]) => ({ resource, ...counts })),
    active_cooldowns: snapshot.cooldowns.length,
    active_leases: snapshot.leases.length,
  };
}
