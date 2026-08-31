import type { PublicationOwner } from "./cache-publication";

export type CacheFillOutcome = "shared" | "edge_only" | "failed" | "rejected" | "unknown";

export type CacheFillAcquisition =
  | { kind: "owner"; owner: PublicationOwner }
  | { kind: "completed"; outcome: CacheFillOutcome; publicationId?: number }
  | { kind: "retry" };

type Awaitable<T> = T | Promise<T>;

export interface CacheFillCoordinator {
  acquirePublication(resource: string): Awaitable<CacheFillAcquisition>;
  tryAcquirePublication(resource: string): Awaitable<PublicationOwner | undefined>;
  renewPublication(owner: PublicationOwner): Awaitable<boolean>;
  completePublication(
    owner: PublicationOwner,
    outcome: CacheFillOutcome,
    publicationId?: number,
  ): Awaitable<boolean>;
}

export type PublicationResult = {
  storage: CacheFillOutcome;
  completion: "accepted" | "lost" | "unknown";
};

const CACHE_FILL_RENEW_MS = 3_000;

export type OwnedCacheFill = {
  readonly capability: PublicationOwner;
  renew(): Promise<boolean>;
  complete(outcome: CacheFillOutcome, publicationId?: number): Promise<boolean>;
  fail(): Promise<boolean>;
  publish(publisher: () => Promise<CacheFillOutcome>): Promise<PublicationResult>;
};

export async function acquireOwnedCacheFill(
  coordinator: CacheFillCoordinator,
  cacheKey: string,
): Promise<
  { kind: "owner"; owner: OwnedCacheFill } | Exclude<CacheFillAcquisition, { kind: "owner" }>
> {
  let acquisition: CacheFillAcquisition;
  try {
    acquisition = await coordinator.acquirePublication(cacheKey);
  } catch {
    // A Durable Object restart rejects its in-memory waiting RPCs. Re-entering
    // the durable acquisition state either waits on the surviving owner or
    // returns retry at its persisted expiry.
    acquisition = await coordinator.acquirePublication(cacheKey);
  }
  if (acquisition.kind !== "owner") {
    return acquisition;
  }
  return {
    kind: "owner",
    owner: startOwnedCacheFill(coordinator, acquisition.owner),
  };
}

export function startOwnedCacheFill(
  coordinator: CacheFillCoordinator,
  capability: PublicationOwner,
): OwnedCacheFill {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<boolean> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const deactivate = (): void => {
    active = false;
    clearTimer();
  };
  const scheduleRenewal = (): void => {
    clearTimer();
    if (!active) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void renew();
    }, CACHE_FILL_RENEW_MS);
  };
  const renew = (): Promise<boolean> => {
    if (!active) {
      return Promise.resolve(false);
    }
    clearTimer();
    if (renewal !== undefined) {
      return renewal;
    }
    const current = (async () => {
      try {
        return await coordinator.renewPublication(capability);
      } catch {
        console.error("cache fill renewal failed");
        return false;
      }
    })();
    renewal = current;
    void current.then((renewed) => {
      if (renewal === current) {
        renewal = undefined;
      }
      if (!renewed) {
        deactivate();
      } else if (active) {
        scheduleRenewal();
      }
    });
    return current;
  };
  const complete = async (outcome: CacheFillOutcome, publicationId?: number): Promise<boolean> => {
    if (!active) {
      return false;
    }
    clearTimer();
    const pending = renewal;
    if (pending !== undefined && !(await pending)) {
      return false;
    }
    if (!active) {
      return false;
    }
    deactivate();
    try {
      return await coordinator.completePublication(capability, outcome, publicationId);
    } catch {
      completionUnknown = true;
      console.error("cache fill completion failed");
      return false;
    }
  };
  let completionUnknown = false;
  const publish = async (
    publisher: () => Promise<CacheFillOutcome>,
  ): Promise<PublicationResult> => {
    if (!(await renew())) {
      return { storage: "rejected", completion: "lost" };
    }
    try {
      const outcome = await publisher();
      const accepted = await complete(outcome, outcome === "shared" ? capability.id : undefined);
      return {
        storage: outcome,
        completion: accepted ? "accepted" : completionUnknown ? "unknown" : "lost",
      };
    } catch (error) {
      await complete("failed");
      throw error;
    }
  };

  scheduleRenewal();
  return {
    capability,
    renew,
    complete,
    fail: () => complete("failed"),
    publish,
  };
}
