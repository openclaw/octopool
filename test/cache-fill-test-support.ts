import { vi } from "vitest";
import type {
  CacheFillAcquisition,
  CacheFillCoordinator,
  CacheFillOutcome,
} from "../src/cache-fill";
import { CACHE_PUBLICATION_EPOCH, type PublicationOwner } from "../src/cache-publication";

export function fixtureOwner(token = "fixture", resource = "cache:cache-key"): PublicationOwner {
  return {
    id: 1,
    protocol_epoch: CACHE_PUBLICATION_EPOCH,
    resource_key: resource,
    owner_token: token,
    lease_until_ms: Date.now() + 8_000,
  };
}

export function fakeCacheFillCoordinator(
  acquisitions: (
    | { kind: "owner"; token: string }
    | { kind: "completed"; outcome: CacheFillOutcome }
    | { kind: "retry" }
  )[],
) {
  let index = 0;
  return {
    acquirePublication: vi.fn(async (resource: string): Promise<CacheFillAcquisition> => {
      const acquisition = acquisitions[index++];
      if (acquisition === undefined) throw new Error("unexpected publication acquisition");
      if (acquisition.kind === "owner")
        return { kind: "owner", owner: fixtureOwner(acquisition.token, resource) };
      return acquisition;
    }),
    tryAcquirePublication: vi.fn(async () => undefined),
    renewPublication: vi.fn(async () => true),
    completePublication: vi.fn(async () => true),
  } satisfies CacheFillCoordinator;
}
