import { deleteEdgeJSON } from "../../src/edge-cache";
import { observeAnonymousPublicRepo } from "../../src/public-repos";
import { writeGitHubCache } from "../../src/cache";
import { acquireOwnedCacheFill } from "../../src/cache-fill";
import { bodyPublicationResource } from "../../src/cache-publication";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import type { GitHubRelayResponse, Identity, RelayRequest, RouteInfo } from "../../src/types";

// Synthetic fixture evidence is observed only after the real grant commits.
export async function writeOwnedGitHubCache(
  env: Env,
  key: string,
  request: RelayRequest,
  route: RouteInfo,
  response: GitHubRelayResponse,
  identity?: Identity,
) {
  const acquired = await acquireOwnedCacheFill(
    poolCoordinatorStub(env, request.pool),
    bodyPublicationResource(key),
  );
  if (acquired.kind !== "owner") throw new Error("Fixture publication resource is busy");
  try {
    const result = await acquired.owner.publish(() =>
      writeGitHubCache(env, key, request, route, response, acquired.owner.capability, identity),
    );
    return result.storage;
  } finally {
    await acquired.owner.fail();
  }
}

export async function seedPublicRepoProof(env: Env, route: RouteInfo): Promise<void> {
  await observeAnonymousPublicRepo(env, { ...route, kind: "repo_view" }, async () => ({
    status: 200,
    headers: {},
    body: { private: false },
  }));
}

export async function expireGitHubCache(env: Env, key: string, ageSeconds = 1): Promise<void> {
  await env.DB.prepare(
    "UPDATE github_cache_entries SET expires_at = datetime('now', ?), stale_expires_at = datetime('now', '+1 hour') WHERE cache_key = ?",
  )
    .bind(`-${ageSeconds} seconds`, key)
    .run();
  await deleteEdgeJSON("github-publication-v1", key);
}
