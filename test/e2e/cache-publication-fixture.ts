import { storePublicRepoProof } from "../../src/public-repos";
import { writeGitHubCache } from "../../src/cache";
import { acquireOwnedCacheFill } from "../../src/cache-fill";
import { bodyPublicationResource, proofPublicationResource } from "../../src/cache-publication";
import { poolCoordinatorStub, publicProofCoordinatorStub } from "../../src/pool-coordinator";
import { sqliteTimestamp } from "../../src/sqlite-time";
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
  if (route.owner === undefined || route.repo === undefined) return;
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  // Fixture seeding needs new evidence even when optional production warming would skip it.
  const acquired = await acquireOwnedCacheFill(
    publicProofCoordinatorStub(env),
    proofPublicationResource(owner, repo),
  );
  if (acquired.kind !== "owner") throw new Error("Fixture proof resource is busy");
  try {
    const result = await acquired.owner.publish(() =>
      storePublicRepoProof(
        env,
        owner,
        repo,
        true,
        sqliteTimestamp(Date.now()),
        acquired.owner.capability,
      ),
    );
    if (result.storage !== "shared" || result.completion !== "accepted") {
      throw new Error("Fixture proof publication failed");
    }
  } finally {
    await acquired.owner.fail();
  }
}
