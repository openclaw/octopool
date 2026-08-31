import { evictDurableObject, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { restoreD1Baseline, type D1Baseline } from "./d1-baseline";
import { OwnedWork } from "./owned-work";

// All caches stay native. Only puts forwarded through this ledger are owned;
// this is deliberately not a purge of arbitrary, untracked Cache API contents.
export class CacheWriteLedger {
  readonly caches: CacheStorage;
  private readonly writes = new OwnedWork();
  private readonly entries = new Map<Cache, Request[]>();
  private readonly wrapped = new WeakMap<Cache, Cache>();

  constructor(native: CacheStorage) {
    const receivers = new WeakMap<Cache, Cache>();
    const wrap = (cache: Cache): Cache => {
      const existing = this.wrapped.get(cache);
      if (existing) return existing;
      const { writes, entries: ownedEntries } = this;
      const methods = new Map<PropertyKey, unknown>();
      const proxy = new Proxy(cache, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value !== "function" || !["put", "match", "delete"].includes(String(key)))
            return value;
          if (methods.has(key)) return methods.get(key);
          const method = function (this: unknown, ...args: unknown[]) {
            const receiver = receivers.get(this as Cache) ?? this;
            const result: unknown = Reflect.apply(value, receiver, args);
            if (key === "put") {
              return writes.track(
                (result as Promise<void>).then(() => {
                  const request = new Request(args[0] as RequestInfo | URL);
                  const entries = ownedEntries.get(receiver as Cache) ?? [];
                  entries.push(request);
                  ownedEntries.set(receiver as Cache, entries);
                }),
              );
            }
            return result;
          };
          methods.set(key, method);
          return method;
        },
      });
      receivers.set(proxy, cache);
      this.wrapped.set(cache, proxy);
      return proxy;
    };
    let open: CacheStorage["open"] | undefined;
    const proxy = new Proxy(native, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (key === "default") return wrap(value as Cache);
        if (key !== "open" || typeof value !== "function") return value;
        open ??= function (this: unknown, ...args: unknown[]) {
          const receiver = this === proxy ? target : this;
          const result: unknown = Reflect.apply(value, receiver, args);
          return (result as Promise<Cache>).then(wrap);
        };
        return open;
      },
    });
    this.caches = proxy;
  }

  async drain(): Promise<void> {
    await this.writes.drain();
  }

  async clear(): Promise<void> {
    await this.drain();
    for (const [cache, requests] of this.entries) {
      // Retain each request's headers for native Vary matching. Failed deletes
      // must keep their ledger entries so cleanup cannot silently lose ownership.
      for (const request of requests) await cache.delete(request);
      this.entries.delete(cache);
    }
  }
}

export async function clearCoordinators(namespace: Env["POOL_COORDINATOR"]): Promise<void> {
  // listDurableObjectIds enumerates persisted .sqlite files, including IDs whose
  // instances are dormant and absent from native reset's live-actor map.
  for (const id of await listDurableObjectIds(namespace)) {
    const stub = namespace.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
    // deleteAll removes SQL but not the instance's cached state/timers/waiters.
    // A new instance must rerun the constructor before its next SQL access.
    await evictDurableObject(stub);
  }
}

export async function clearActionLogs(bucket: R2Bucket, pageSize = 1_000): Promise<void> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("R2 cleanup page size must be between 1 and 1000");
  }
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: pageSize, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) await bucket.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor)
      throw new Error("R2 cleanup received a truncated page without a cursor");
  } while (cursor);
}

export async function restoreStorage(
  env: Pick<Env, "DB" | "POOL_COORDINATOR" | "ACTIONS_LOGS">,
  baseline: D1Baseline,
  caches: CacheWriteLedger,
): Promise<void> {
  await caches.clear();
  await clearCoordinators(env.POOL_COORDINATOR);
  await clearActionLogs(env.ACTIONS_LOGS);
  await restoreD1Baseline(env.DB, baseline);
}
