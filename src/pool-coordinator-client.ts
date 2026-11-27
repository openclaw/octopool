import type { PoolCoordinator } from "./pool-coordinator";

// The coordinator must live near the D1 primary (WNAM since the 2026-08 region
// move) or every selectIdentity/recordResult hop re-adds the cross-region
// latency the migration removed. Location hints only apply when an object is
// first created, so the name carries a generation suffix that retires the
// EU-born instance; its state is all short-TTL coordination data, safe to drop.
export function poolCoordinatorStub(env: Env, pool: string): DurableObjectStub<PoolCoordinator> {
  const id = env.POOL_COORDINATOR.idFromName(`pool:${pool}@wnam`);
  return env.POOL_COORDINATOR.get(id, { locationHint: "wnam" });
}

export function publicProofCoordinatorStub(env: Env): DurableObjectStub<PoolCoordinator> {
  return env.POOL_COORDINATOR.get(env.POOL_COORDINATOR.idFromName("public-proof:global@wnam"), {
    locationHint: "wnam",
  });
}
