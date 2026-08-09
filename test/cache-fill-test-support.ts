import { vi } from "vitest";
import type { CacheFillAcquisition, CacheFillCoordinator } from "../src/cache-fill";

export function fakeCacheFillCoordinator(acquisitions: CacheFillAcquisition[]) {
  let index = 0;
  return {
    acquireCacheFill: vi.fn(async () => {
      const acquisition = acquisitions[index++];
      if (acquisition === undefined) {
        throw new Error("unexpected cache-fill acquisition");
      }
      return acquisition;
    }),
    renewCacheFill: vi.fn(async () => true),
    completeCacheFill: vi.fn(async () => true),
  } satisfies CacheFillCoordinator;
}
