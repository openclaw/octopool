import {
  BackendWork,
  backendAdmissionStub,
  admitBackendWork,
  assertBackendWorkActive,
} from "./backend-work";
import { startOwnedCacheFill, type CacheFillCoordinator } from "./cache-fill";

const MAX_REFRESHES = 8;
const pending = new Set<string>();

// Call outside the foreground BackendWork scope. No pending promise is shared
// across request lifetimes; durable ownership also coalesces across isolates.
export function scheduleCacheRefresh(
  env: Env,
  ctx: ExecutionContext,
  coordinator: CacheFillCoordinator,
  pool: string,
  cacheKey: string,
  client: string,
  refresh: () => Promise<void>,
): void {
  const limit = Math.min(MAX_REFRESHES, Math.floor(BackendWork.limit(env) / 2));
  if (limit < 1 || pending.size >= MAX_REFRESHES || pending.has(cacheKey)) return;
  pending.add(cacheKey);
  const backend = new BackendWork(backendAdmissionStub(env, pool), client, limit);
  ctx.waitUntil(
    backend
      .run(AbortSignal.timeout(20_000), ctx, async () => {
        try {
          // The shared count includes foreground work. Reserve at least half
          // the total cap (eight by default) for foreground CLI slots.
          await admitBackendWork();
          const capability = await coordinator.tryAcquirePublication(`swr:${cacheKey}`);
          if (capability === undefined) return;
          const owner = startOwnedCacheFill(coordinator, capability);
          try {
            assertBackendWorkActive();
            await refresh();
          } finally {
            await owner.fail();
          }
        } finally {
          // Count even late non-abortable storage until the work actually settles.
          pending.delete(cacheKey);
        }
      })
      .catch(() => console.error("background CI cache refresh failed or admission unavailable")),
  );
}
