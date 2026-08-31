import { bodyPublicationResource } from "./cache-publication";
import {
  readEdgeGitHubCache,
  readGitHubCacheWithSource,
  type CachedGitHubResponse,
  type GitHubCacheRead,
} from "./cache";
import {
  acquireOwnedCacheFill,
  type CacheFillCoordinator,
  type OwnedCacheFill,
} from "./cache-fill";

export async function coalesceGitHubCacheMiss(
  env: Env,
  coordinator: CacheFillCoordinator,
  cacheKey: string,
  options: {
    ctx?: ExecutionContext;
    maxAgeSeconds?: number;
    acceptCached?: (cached: CachedGitHubResponse) => Promise<boolean>;
    readShared?: () => Promise<GitHubCacheRead | undefined>;
    readEdge?: () => Promise<CachedGitHubResponse | undefined>;
  } = {},
): Promise<{ owner?: OwnedCacheFill; cached?: CachedGitHubResponse }> {
  const readShared =
    options.readShared ??
    (() => readGitHubCacheWithSource(env, cacheKey, options.ctx, options.maxAgeSeconds));
  const readEdge = options.readEdge ?? (() => readEdgeGitHubCache(cacheKey, options.maxAgeSeconds));
  const accepted = options.acceptCached ?? (async () => true);

  for (;;) {
    const acquisition = await acquireOwnedCacheFill(coordinator, bodyPublicationResource(cacheKey));
    if (acquisition.kind === "owner") {
      try {
        const rechecked = await readShared();
        if (rechecked !== undefined && (await accepted(rechecked.cached))) {
          await acquisition.owner.complete(rechecked.source === "shared" ? "shared" : "edge_only");
          return { cached: rechecked.cached };
        }
        return { owner: acquisition.owner };
      } catch (error) {
        await acquisition.owner.fail();
        throw error;
      }
    }

    let cached: CachedGitHubResponse | undefined;
    if (acquisition.kind === "completed" && acquisition.outcome === "shared") {
      cached = (
        await (options.readShared?.() ??
          readGitHubCacheWithSource(env, cacheKey, options.ctx, options.maxAgeSeconds, true))
      )?.cached;
    } else if (acquisition.kind === "completed" && acquisition.outcome === "edge_only") {
      cached = await readEdge();
    }
    if (cached !== undefined && (await accepted(cached))) {
      return { cached };
    }
    // Failed publication, owner expiry, or an unexpectedly absent completed
    // result always returns to the coordinator before any upstream work.
  }
}
