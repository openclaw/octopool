import { DurableObject } from "cloudflare:workers";
import { queries } from "./generated/sql";
import { BACKEND_DEADLINE_MS, BACKEND_LEASE_MS } from "./backend-work";

export function backendAdmissionStub(env: Env, pool: string): DurableObjectStub<BackendAdmission> {
  return env.BACKEND_ADMISSION.get(env.BACKEND_ADMISSION.idFromName(`pool:${pool}`), {
    locationHint: "wnam",
  });
}

// This object has no D1/network operations or publication waiters. All permit
// decisions use durable local SQL, independent of the pool's publication gate.
export class BackendAdmission extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(queries.createBackendPermits);
    ctx.storage.sql.exec(queries.createBackendPermitsClientIndex);
    ctx.storage.sql.exec(queries.createBackendPermitsExpiryIndex);
  }

  acquire(permitId: string, clientKey: string, limit: number): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid admission limit");
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(queries.drainBackendPermits, now);
      const existing = sql
        .exec<{ client_key: string; expires_at: number }>(queries.readBackendPermit, permitId)
        .toArray()[0];
      if (existing !== undefined)
        return existing.client_key === clientKey && existing.expires_at > now;
      const { count } = sql
        .exec<{ count: number }>(queries.countBackendPermits, clientKey, now)
        .one();
      if (count >= limit) return false;
      sql.exec(
        queries.insertBackendPermit,
        permitId,
        clientKey,
        now + BACKEND_LEASE_MS,
        now + BACKEND_DEADLINE_MS,
      );
      return true;
    });
  }

  renew(permitId: string): boolean {
    const now = Date.now();
    return (
      this.ctx.storage.sql
        .exec(queries.renewBackendPermit, permitId, now, now + BACKEND_LEASE_MS)
        .toArray().length === 1
    );
  }

  release(permitId: string): void {
    this.ctx.storage.sql.exec(queries.releaseBackendPermit, permitId);
  }
}
