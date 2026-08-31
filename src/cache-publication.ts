import { queries } from "./generated/sql";

// Restore/rebuild of the allocator behind issued IDs requires a new epoch.
export const CACHE_PUBLICATION_EPOCH = "publication-v1";
export const PUBLICATION_LEASE_MS = 8_000;
export const PUBLICATION_ACQUIRE_GC_LIMIT = 16;

export type PublicationOwner = Readonly<{
  id: number;
  protocol_epoch: string;
  resource_key: string;
  owner_token: string;
  lease_until_ms: number;
}>;

export function publicationBinding(owner: PublicationOwner): [string, string, number, string] {
  return [owner.protocol_epoch, owner.resource_key, owner.id, owner.owner_token];
}

export function bodyPublicationResource(cacheKey: string): string {
  return `cache:${cacheKey}`;
}

export function proofPublicationResource(owner: string, repo: string): string {
  return `public-repo:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export async function tryPublicationOwner(
  env: Env,
  resource: string,
): Promise<PublicationOwner | undefined> {
  const results = await env.DB.batch<PublicationOwner>([
    env.DB.prepare(queries.deleteExpiredPublicationOwners).bind(PUBLICATION_ACQUIRE_GC_LIMIT),
    env.DB.prepare(queries.acquirePublicationOwner).bind(
      CACHE_PUBLICATION_EPOCH,
      resource,
      crypto.randomUUID(),
      PUBLICATION_LEASE_MS,
    ),
  ]);
  const owner = results[1]!.results[0];
  if (
    owner !== undefined &&
    (!Number.isSafeInteger(owner.id) ||
      owner.id < 1 ||
      owner.protocol_epoch !== CACHE_PUBLICATION_EPOCH ||
      owner.resource_key !== resource)
  ) {
    throw new Error("Invalid publication grant");
  }
  // No capability escapes until the whole binding transaction committed.
  return owner;
}

export async function pruneExpiredPublicationOwners(env: Env, limit = 500): Promise<number> {
  const result = await env.DB.prepare(queries.deleteExpiredPublicationOwners).bind(limit).all();
  return result.results.length;
}
