export type CacheFillOutcome = "shared" | "edge_only" | "failed";

export type CacheFillAcquisition =
  | { kind: "owner"; token: string }
  | { kind: "completed"; outcome: CacheFillOutcome }
  | { kind: "retry" };

type Awaitable<T> = T | Promise<T>;

export interface CacheFillCoordinator {
  acquireCacheFill(cacheKey: string): Awaitable<CacheFillAcquisition>;
  renewCacheFill(cacheKey: string, ownerToken: string): Awaitable<boolean>;
  completeCacheFill(
    cacheKey: string,
    ownerToken: string,
    outcome: CacheFillOutcome,
  ): Awaitable<boolean>;
}

const CACHE_FILL_RENEW_MS = 3_000;

export type OwnedCacheFill = {
  readonly token: string;
  renew(): Promise<boolean>;
  complete(outcome: CacheFillOutcome): Promise<boolean>;
  fail(): Promise<boolean>;
  publish(publisher: () => Promise<CacheFillOutcome>): Promise<CacheFillOutcome | undefined>;
};

export async function acquireOwnedCacheFill(
  coordinator: CacheFillCoordinator,
  cacheKey: string,
): Promise<
  { kind: "owner"; owner: OwnedCacheFill } | Exclude<CacheFillAcquisition, { kind: "owner" }>
> {
  let acquisition: CacheFillAcquisition;
  try {
    acquisition = await coordinator.acquireCacheFill(cacheKey);
  } catch {
    // A Durable Object restart rejects its in-memory waiting RPCs. Re-entering
    // the durable acquisition state either waits on the surviving owner or
    // returns retry at its persisted expiry.
    acquisition = await coordinator.acquireCacheFill(cacheKey);
  }
  if (acquisition.kind !== "owner") {
    return acquisition;
  }
  return {
    kind: "owner",
    owner: startOwnedCacheFill(coordinator, cacheKey, acquisition.token),
  };
}

function startOwnedCacheFill(
  coordinator: CacheFillCoordinator,
  cacheKey: string,
  token: string,
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
        return await coordinator.renewCacheFill(cacheKey, token);
      } catch (error) {
        console.error("cache fill renewal failed", error);
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
  const complete = async (outcome: CacheFillOutcome): Promise<boolean> => {
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
      return await coordinator.completeCacheFill(cacheKey, token, outcome);
    } catch (error) {
      console.error("cache fill completion failed", error);
      return false;
    }
  };
  const publish = async (
    publisher: () => Promise<CacheFillOutcome>,
  ): Promise<CacheFillOutcome | undefined> => {
    if (!(await renew())) {
      return undefined;
    }
    try {
      const outcome = await publisher();
      await complete(outcome);
      return outcome;
    } catch (error) {
      await complete("failed");
      throw error;
    }
  };

  scheduleRenewal();
  return {
    token,
    renew,
    complete,
    fail: () => complete("failed"),
    publish,
  };
}
