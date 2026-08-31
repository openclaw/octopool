import { DurableObject } from "cloudflare:workers";
import type { CacheFillAcquisition, CacheFillOutcome } from "./cache-fill";
import {
  CACHE_PUBLICATION_EPOCH,
  PUBLICATION_LEASE_MS,
  publicationBinding,
  tryPublicationOwner,
  type PublicationOwner,
} from "./cache-publication";
import { queries } from "./generated/sql";
import { isCredentialFailureReason, type CredentialFailureReason } from "./github-auth";
import { isRateInteger, isRateSeconds } from "./github-rate";
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

type LegacyCacheFillAcquisition =
  | { kind: "owner"; token: string }
  | { kind: "completed"; outcome: CacheFillOutcome }
  | { kind: "retry" };

type CacheFillRow = {
  owner_token: string;
  expires_at: number;
};

type CacheFillWaiterGroup = {
  ownerToken: string;
  expiresAt: number;
  completion: Promise<Exclude<LegacyCacheFillAcquisition, { kind: "owner" }>>;
  resolve(result: Exclude<LegacyCacheFillAcquisition, { kind: "owner" }>): void;
  timer?: ReturnType<typeof setTimeout>;
};

export class PoolCoordinator extends DurableObject<Env> {
  private readonly cacheFillWaiters = new Map<string, CacheFillWaiterGroup>();

  private readonly publicationWaiters = new Map<
    string,
    {
      owner: PublicationOwner;
      resolve(value: CacheFillAcquisition): void;
      promise: Promise<CacheFillAcquisition>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

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
      this.ctx.storage.sql.exec(queries.createLeasesExpiryIndex);
      this.ctx.storage.sql.exec(queries.createCooldownsExpiryIndex);
      this.ctx.storage.sql.exec(queries.createCacheFillsTable);
      this.ctx.storage.sql.exec(queries.createLegacyCacheFillExpiryIndex);
    });
  }

  async tryAcquirePublication(resource: string): Promise<PublicationOwner | undefined> {
    this.ctx.storage.sql.exec(queries.drainExpiredLegacyCacheFills, Date.now());
    return tryPublicationOwner(this.env, resource);
  }

  async acquirePublication(resource: string): Promise<CacheFillAcquisition> {
    const acquisition = await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(queries.drainExpiredLegacyCacheFills, Date.now());
      const owner = await tryPublicationOwner(this.env, resource);
      if (owner !== undefined) {
        this.wakePublication(resource, { kind: "retry" });
        return { result: { kind: "owner", owner } as CacheFillAcquisition };
      }
      const current = await this.env.DB.prepare(queries.readPublicationOwner)
        .bind(CACHE_PUBLICATION_EPOCH, resource)
        .first<PublicationOwner>();
      if (current === null) return { result: { kind: "retry" } as CacheFillAcquisition };
      let group = this.publicationWaiters.get(resource);
      if (group?.owner.id !== current.id) {
        this.wakePublication(resource, { kind: "retry" });
        let resolve!: (value: CacheFillAcquisition) => void;
        const promise = new Promise<CacheFillAcquisition>((done) => {
          resolve = done;
        });
        group = {
          owner: current,
          resolve,
          promise,
          timer: setTimeout(
            () => this.wakePublication(resource, { kind: "retry" }),
            PUBLICATION_LEASE_MS,
          ),
        };
        this.publicationWaiters.set(resource, group);
      }
      return { waiting: group!.promise };
    });
    return acquisition.result ?? acquisition.waiting!;
  }

  async renewPublication(owner: PublicationOwner): Promise<boolean> {
    const row = await this.env.DB.prepare(queries.renewPublicationOwner)
      .bind(...publicationBinding(owner), PUBLICATION_LEASE_MS)
      .first<PublicationOwner>();
    if (row === null) return false;
    const group = this.publicationWaiters.get(owner.resource_key);
    if (group?.owner.id === owner.id && group.owner.owner_token === owner.owner_token) {
      clearTimeout(group.timer);
      group.timer = setTimeout(
        () => this.wakePublication(owner.resource_key, { kind: "retry" }),
        PUBLICATION_LEASE_MS,
      );
    }
    return true;
  }

  async completePublication(
    owner: PublicationOwner,
    outcome: CacheFillOutcome,
    publicationId?: number,
  ): Promise<boolean> {
    if (
      publicationId !== undefined &&
      (outcome !== "shared" || !Number.isSafeInteger(publicationId) || publicationId < 1)
    ) {
      throw new Error("Invalid publication completion");
    }
    const row = await this.env.DB.prepare(
      outcome === "none" || outcome === "failed" || outcome === "rejected" || outcome === "unknown"
        ? queries.revokePublicationOwner
        : queries.completePublicationOwner,
    )
      .bind(...publicationBinding(owner))
      .first<{ id: number; was_live?: number }>();
    if (row === null) return false;
    // Revocation cleans expired rows too; only a live receipt accepts completion.
    const accepted = row.was_live !== 0;
    const group = this.publicationWaiters.get(owner.resource_key);
    if (group?.owner.id === owner.id && group.owner.owner_token === owner.owner_token) {
      this.wakePublication(
        owner.resource_key,
        accepted
          ? {
              kind: "completed",
              outcome,
              ...(publicationId === undefined ? {} : { publicationId }),
            }
          : { kind: "retry" },
      );
    }
    return accepted;
  }

  private wakePublication(resource: string, result: CacheFillAcquisition): void {
    const group = this.publicationWaiters.get(resource);
    if (group === undefined) return;
    this.publicationWaiters.delete(resource);
    clearTimeout(group.timer);
    group.resolve(result);
  }

  // In-flight pre-epoch Workers still call these RPCs. Their keys and proof table
  // are retired for new readers. Remove this surface after old routing is drained.
  acquireCacheFill(
    cacheKey: string,
  ): Promise<LegacyCacheFillAcquisition> | LegacyCacheFillAcquisition {
    const now = Date.now();
    const fill = this.cacheFill(cacheKey);
    if (fill !== undefined && fill.expires_at > now) {
      return this.waitForCacheFill(cacheKey, fill);
    }
    if (fill !== undefined) {
      this.wakeCacheFill(cacheKey, fill.owner_token, { kind: "retry" });
    }
    const ownerToken = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      queries.upsertCacheFill,
      cacheKey,
      ownerToken,
      now + CACHE_FILL_LEASE_MS,
    );
    return { kind: "owner", token: ownerToken };
  }

  renewCacheFill(cacheKey: string, ownerToken: string): boolean {
    const now = Date.now();
    const expiresAt = now + CACHE_FILL_LEASE_MS;
    const updated = this.ctx.storage.sql.exec(
      queries.renewCacheFill,
      cacheKey,
      ownerToken,
      expiresAt,
      now,
    );
    if (updated.rowsWritten === 0) {
      return false;
    }
    this.extendCacheFillWaiter(cacheKey, ownerToken, expiresAt);
    return true;
  }

  completeCacheFill(cacheKey: string, ownerToken: string, outcome: CacheFillOutcome): boolean {
    const deleted = this.ctx.storage.sql.exec(
      queries.completeCacheFill,
      cacheKey,
      ownerToken,
      Date.now(),
    );
    if (deleted.rowsWritten === 0) {
      return false;
    }
    this.wakeCacheFill(cacheKey, ownerToken, { kind: "completed", outcome });
    return true;
  }

  selectIdentity(request: SelectionRequest): SelectionResult {
    const now = Date.now();
    this.ctx.storage.sql.exec(queries.deleteExpiredLeases, now);
    this.ctx.storage.sql.exec(queries.deleteExpiredCooldowns, now);
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
        kind: "selected",
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
      return { kind: "unavailable", reason: "all_identity_candidates_cooling_down" };
    }
    const ttlMs = 10_000;
    this.ctx.storage.sql.exec(queries.upsertLease, request.routeKey, best.id, now + ttlMs);
    return {
      kind: "selected",
      identityId: best.id,
      reason: "highest_remaining",
      leaseTtlSeconds: ttlMs / 1000,
    };
  }

  recordResult(result: RecordResult): void {
    // A failed cooldown statement must not leave half of this observation committed.
    this.ctx.storage.transactionSync(() => {
      const rate = result.rate;
      if (
        isRateInteger(rate?.remaining) &&
        isRateSeconds(rate?.resetAt) &&
        rate.resetAt > 0 &&
        (rate.limit === undefined || isRateInteger(rate.limit))
      ) {
        this.ctx.storage.sql.exec(
          queries.upsertRateState,
          result.identityId,
          result.resource,
          rate.limit ?? 5000,
          rate.remaining,
          rate.resetAt * 1000,
        );
      }
      if (result.status === 401 || result.status === 403 || result.status === 429) {
        const now = Date.now();
        const cooldown = classifyCooldown(result, now);
        this.ctx.storage.sql.exec(
          queries.upsertCooldown,
          result.identityId,
          cooldown.key,
          result.status,
          "github_error",
          now + cooldown.ttlMs,
        );
      }
    });
  }

  recordCredentialFailure(result: { identityId: string; reason: CredentialFailureReason }): void {
    if (
      typeof result?.identityId !== "string" ||
      result.identityId === "" ||
      !isCredentialFailureReason(result.reason)
    ) {
      throw new Error("Invalid credential failure observation");
    }
    this.ctx.storage.sql.exec(
      queries.upsertCooldown,
      result.identityId,
      "*",
      503,
      result.reason,
      Date.now() + 120_000,
    );
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

  private cacheFill(cacheKey: string): CacheFillRow | undefined {
    return this.ctx.storage.sql.exec<CacheFillRow>(queries.getCacheFill, cacheKey).toArray()[0];
  }

  private waitForCacheFill(
    cacheKey: string,
    fill: CacheFillRow,
  ): Promise<LegacyCacheFillAcquisition> {
    let group = this.cacheFillWaiters.get(cacheKey);
    if (group === undefined || group.ownerToken !== fill.owner_token) {
      if (group !== undefined) {
        this.wakeCacheFill(cacheKey, group.ownerToken, { kind: "retry" });
      }
      let resolve!: CacheFillWaiterGroup["resolve"];
      const completion = new Promise<Exclude<LegacyCacheFillAcquisition, { kind: "owner" }>>(
        (complete) => {
          resolve = complete;
        },
      );
      group = {
        ownerToken: fill.owner_token,
        expiresAt: fill.expires_at,
        completion,
        resolve,
      };
      this.cacheFillWaiters.set(cacheKey, group);
      this.scheduleCacheFillExpiry(cacheKey, group, fill.expires_at);
    } else if (fill.expires_at > group.expiresAt) {
      this.scheduleCacheFillExpiry(cacheKey, group, fill.expires_at);
    }
    return group.completion;
  }

  private scheduleCacheFillExpiry(
    cacheKey: string,
    group: CacheFillWaiterGroup,
    expiresAt: number,
  ): void {
    group.expiresAt = expiresAt;
    if (group.timer !== undefined) {
      clearTimeout(group.timer);
    }
    group.timer = setTimeout(
      () => {
        this.wakeCacheFill(cacheKey, group.ownerToken, { kind: "retry" });
      },
      Math.max(1, expiresAt - Date.now()),
    );
  }

  private extendCacheFillWaiter(cacheKey: string, ownerToken: string, expiresAt: number): void {
    const group = this.cacheFillWaiters.get(cacheKey);
    if (group !== undefined && group.ownerToken === ownerToken) {
      this.scheduleCacheFillExpiry(cacheKey, group, expiresAt);
    }
  }

  private wakeCacheFill(
    cacheKey: string,
    ownerToken: string,
    result: Exclude<LegacyCacheFillAcquisition, { kind: "owner" }>,
  ): void {
    const group = this.cacheFillWaiters.get(cacheKey);
    if (group === undefined || group.ownerToken !== ownerToken) {
      return;
    }
    this.cacheFillWaiters.delete(cacheKey);
    if (group.timer !== undefined) {
      clearTimeout(group.timer);
    }
    group.resolve(result);
  }
}

function classifyCooldown(result: RecordResult, now: number): { key: string; ttlMs: number } {
  const retryAfter = result.rate?.retryAfter;
  const duration = isRateSeconds(retryAfter) ? Math.max(retryAfter, 1) * 1000 : undefined;
  const retryAfterMs =
    duration !== undefined && Number.isSafeInteger(now + duration) ? duration : undefined;
  if (result.status === 401) {
    return { key: "*", ttlMs: retryAfterMs ?? 120_000 };
  }
  if (retryAfterMs !== undefined) {
    return { key: "*", ttlMs: retryAfterMs };
  }
  if (result.status === 429) {
    return { key: `resource:${result.resource}`, ttlMs: 120_000 };
  }
  return { key: result.routeKey, ttlMs: 120_000 };
}

export function publicProofCoordinatorStub(env: Env): DurableObjectStub<PoolCoordinator> {
  return env.POOL_COORDINATOR.get(env.POOL_COORDINATOR.idFromName("public-proof:global@wnam"), {
    locationHint: "wnam",
  });
}
