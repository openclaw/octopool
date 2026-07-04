import { readGitHubCache, type CachedGitHubResponse } from "./cache";
import type { PoolCoordinator } from "./pool-coordinator";

const CACHE_FILL_WAIT_MS = 4_000;
const CACHE_FILL_POLL_MS = 100;

type CacheFillCoordinator = Pick<
  DurableObjectStub<PoolCoordinator>,
  "claimCacheFill" | "finishCacheFill"
>;

export async function coalesceGitHubCacheMiss(
  env: Env,
  coordinator: CacheFillCoordinator,
  cacheKey: string,
  options: {
    waitMs?: number;
    pollMs?: number;
    maxAgeSeconds?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ leaseToken?: string; cached?: CachedGitHubResponse }> {
  const leaseToken = await coordinator.claimCacheFill(cacheKey);
  if (leaseToken !== null) {
    return { leaseToken };
  }
  const waitMs = options.waitMs ?? CACHE_FILL_WAIT_MS;
  const pollMs = options.pollMs ?? CACHE_FILL_POLL_MS;
  const wait = options.sleep ?? sleep;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await wait(pollMs);
    const cached = await readGitHubCache(env, cacheKey, undefined, options.maxAgeSeconds);
    if (cached !== undefined) {
      return { cached };
    }
  }
  return {};
}

export async function finishGitHubCacheFill(
  coordinator: CacheFillCoordinator,
  cacheKey: string,
  leaseToken: string | undefined,
): Promise<void> {
  if (leaseToken === undefined) {
    return;
  }
  try {
    await coordinator.finishCacheFill(cacheKey, leaseToken);
  } catch (error) {
    console.error("github cache fill cleanup failed", error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
