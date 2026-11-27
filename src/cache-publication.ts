// Restore/rebuild of the allocator behind issued IDs requires a new epoch.
export const CACHE_PUBLICATION_EPOCH = "publication-v1";
export const PUBLICATION_LEASE_MS = 8_000;

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
