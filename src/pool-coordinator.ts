import { DurableObject } from "cloudflare:workers";
import { queries } from "./generated/sql";
import type { CoordinatorSnapshot, RecordResult, SelectionRequest, SelectionResult } from "./types";

type LeaseRow = {
  identity_id: string;
  expires_at: number;
};

type RateRow = {
  limit_count: number;
  remaining: number;
  reset_at: number;
};

const CACHE_FILL_LEASE_MS = 8_000;

// The coordinator must live near the D1 primary (WNAM since the 2026-08 region
// move) or every selectIdentity/recordResult hop re-adds the cross-region
// latency the migration removed. Location hints only apply when an object is
// first created, so the name carries a generation suffix that retires the
// EU-born instance; its state is all short-TTL coordination data, safe to drop.
export function poolCoordinatorStub(env: Env, pool: string): DurableObjectStub<PoolCoordinator> {
  const id = env.POOL_COORDINATOR.idFromName(`pool:${pool}@wnam`);
  return env.POOL_COORDINATOR.get(id, { locationHint: "wnam" });
}

export class PoolCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(queries.createLeasesTable);
      this.ctx.storage.sql.exec(queries.createRateStatesTable);
      try {
        this.ctx.storage.sql.exec(queries.migrateRateStatesLimit);
      } catch {
        // Existing Durable Objects already have the column; new ones get it from CREATE TABLE.
      }
      this.ctx.storage.sql.exec(queries.createCooldownsTable);
      this.ctx.storage.sql.exec(queries.createCacheFillsTable);
    });
  }

  claimCacheFill(cacheKey: string): string | null {
    const now = Date.now();
    const fill = this.ctx.storage.sql
      .exec<{ owner_token: string; expires_at: number }>(queries.getCacheFill, cacheKey)
      .toArray()[0];
    if (fill !== undefined && fill.expires_at > now) {
      return null;
    }
    const ownerToken = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      queries.upsertCacheFill,
      cacheKey,
      ownerToken,
      now + CACHE_FILL_LEASE_MS,
    );
    return ownerToken;
  }

  finishCacheFill(cacheKey: string, ownerToken: string): void {
    this.ctx.storage.sql.exec(queries.deleteCacheFill, cacheKey, ownerToken);
  }

  selectIdentity(request: SelectionRequest): SelectionResult {
    const now = Date.now();
    const candidateIds = new Set(request.candidates.map((candidate) => candidate.id));
    const lease = this.ctx.storage.sql
      .exec<LeaseRow>(queries.getLease, request.routeKey)
      .toArray()[0];
    if (
      lease !== undefined &&
      lease.expires_at > now &&
      candidateIds.has(lease.identity_id) &&
      !this.isCoolingDown(lease.identity_id, request, now) &&
      !this.isQuotaExhausted(lease.identity_id, request.resource, now)
    ) {
      return {
        identityId: lease.identity_id,
        reason: "sticky",
        leaseTtlSeconds: Math.ceil((lease.expires_at - now) / 1000),
      };
    }

    let best: (typeof request.candidates)[number] | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of request.candidates) {
      if (this.isCoolingDown(candidate.id, request, now)) {
        continue;
      }
      const rate = this.ctx.storage.sql
        .exec<RateRow>(queries.getRateState, candidate.id, request.resource)
        .toArray()[0];
      if (rate !== undefined && rate.reset_at > now && rate.remaining <= 0) {
        continue;
      }
      const remaining = rate === undefined || rate.reset_at <= now ? 5000 : rate.remaining;
      const score = remaining + candidate.weight;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best === undefined) {
      throw new Error("all_identity_candidates_cooling_down");
    }
    const ttlMs = 10_000;
    this.ctx.storage.sql.exec(queries.upsertLease, request.routeKey, best.id, now + ttlMs);
    return {
      identityId: best.id,
      reason: bestScore === Number.NEGATIVE_INFINITY ? "fallback" : "highest_remaining",
      leaseTtlSeconds: ttlMs / 1000,
    };
  }

  recordResult(result: RecordResult): void {
    if (result.rate?.remaining !== undefined && result.rate.resetAt !== undefined) {
      this.ctx.storage.sql.exec(
        queries.upsertRateState,
        result.identityId,
        result.resource,
        result.rate.limit ?? 5000,
        result.rate.remaining,
        result.rate.resetAt * 1000,
      );
    }
    if (result.status === 401 || result.status === 403 || result.status === 429) {
      const cooldown = classifyCooldown(result);
      this.ctx.storage.sql.exec(
        queries.upsertCooldown,
        result.identityId,
        cooldown.key,
        result.status,
        "github_error",
        Date.now() + cooldown.ttlMs,
      );
    }
  }

  snapshot(): CoordinatorSnapshot {
    const now = Date.now();
    const rates = this.ctx.storage.sql
      .exec<CoordinatorSnapshot["rates"][number]>(queries.coordinatorRates, now)
      .toArray();
    const cooldowns = this.ctx.storage.sql
      .exec<CoordinatorSnapshot["cooldowns"][number]>(queries.coordinatorCooldowns, now)
      .toArray();
    const leases = this.ctx.storage.sql
      .exec<CoordinatorSnapshot["leases"][number]>(queries.coordinatorLeases, now)
      .toArray();
    return { rates, cooldowns, leases };
  }

  private cooldownExpiresAt(identityId: string, routeKey: string, now: number): number | undefined {
    const cooldown = this.ctx.storage.sql
      .exec<{ expires_at: number }>(queries.getCooldownExpiresAt, identityId, routeKey)
      .toArray()[0];
    return cooldown !== undefined && cooldown.expires_at > now ? cooldown.expires_at : undefined;
  }

  private isCoolingDown(identityId: string, request: SelectionRequest, now: number): boolean {
    return (
      this.cooldownExpiresAt(identityId, "*", now) !== undefined ||
      this.cooldownExpiresAt(identityId, `resource:${request.resource}`, now) !== undefined ||
      this.cooldownExpiresAt(identityId, request.routeKey, now) !== undefined
    );
  }

  private isQuotaExhausted(identityId: string, resource: string, now: number): boolean {
    const rate = this.ctx.storage.sql
      .exec<RateRow>(queries.getRateState, identityId, resource)
      .toArray()[0];
    return rate !== undefined && rate.reset_at > now && rate.remaining <= 0;
  }
}

function classifyCooldown(result: RecordResult): { key: string; ttlMs: number } {
  const retryAfterMs =
    result.rate?.retryAfter !== undefined ? Math.max(result.rate.retryAfter, 1) * 1000 : undefined;
  if (result.status === 401) {
    return { key: "*", ttlMs: retryAfterMs ?? 120_000 };
  }
  if (retryAfterMs !== undefined) {
    return { key: "*", ttlMs: retryAfterMs };
  }
  if (result.status === 403 && result.rate?.remaining !== undefined && result.rate.remaining > 0) {
    return { key: "*", ttlMs: 120_000 };
  }
  if (result.status === 429) {
    return { key: `resource:${result.resource}`, ttlMs: 120_000 };
  }
  return { key: result.routeKey, ttlMs: 120_000 };
}
