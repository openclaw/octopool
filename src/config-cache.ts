import { AsyncLocalStorage } from "node:async_hooks";

// Process-local TTL cache for hot D1 config lookups: caller auth, pool policy,
// and identity lists. These rows change only on rare admin action, so a warm
// isolate can skip one D1 round trip per lookup during request bursts — the
// exact pattern (sequential paged reads) that made D1 queueing user-visible.
// Bounded staleness contract: a revoked caller token, retired identity, or
// policy edit may keep acting for up to CONFIG_CACHE_TTL_MS in a warm isolate.
// Pooled serving is public-repo-only (the visibility guard runs per request),
// so the staleness window never extends to private data — it briefly extends
// access to public data and pooled quota. Authoritative recheck moments
// (revalidation source-identity proofs) bypass this cache via fresh reads.
const CONFIG_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 256;

type Entry = { expires: number; value: unknown };
const store = new Map<string, Entry>();
let generation = 0;
type Pending = { expires: number; generation: number; promise: Promise<unknown> };
const requestLoads = new AsyncLocalStorage<Map<string, Pending>>();

// Each fetch invocation owns its pending loads, including asynchronous children.
// Callers outside this scope still cache values, but never share pending work.
export function withConfigCacheScope<T>(run: () => T): T {
  return requestLoads.run(new Map(), run);
}

export async function cachedConfigLookup<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit !== undefined && hit.expires > now) {
    return hit.value as T;
  }
  const pending = requestLoads.getStore();
  const existing = pending?.get(key);
  if (existing !== undefined && existing.expires > now && existing.generation === generation) {
    return existing.promise as Promise<T>;
  }
  const entry: Pending = {
    expires: now + CONFIG_CACHE_TTL_MS,
    generation,
    promise: Promise.resolve()
      .then(load)
      .then((value) => {
        // Only settled data crosses request contexts. Clears, invalidations,
        // eviction and another successful load fence late cache publication.
        const settledAt = Date.now();
        if (
          generation === entry.generation &&
          store.get(key) === hit &&
          entry.expires > settledAt
        ) {
          if (store.size >= MAX_ENTRIES) {
            for (const [staleKey, cached] of store) {
              if (cached.expires <= settledAt) store.delete(staleKey);
            }
            if (store.size >= MAX_ENTRIES) clearConfigCache();
          }
          store.set(key, { value, expires: entry.expires });
        }
        return value;
      })
      .finally(() => {
        if (pending?.get(key) === entry) pending.delete(key);
      }),
  };
  // Pending maps are also bounded, without ever affecting another request.
  if (pending !== undefined && pending.size >= MAX_ENTRIES) pending.clear();
  pending?.set(key, entry);
  return entry.promise as Promise<T>;
}

// Auth can reject a locally valid row after its request-specific checks. Do not
// evict a newer row if an older in-flight authentication fails after a clear.
export function invalidateConfigValue(key: string, value: unknown): void {
  const entry = store.get(key);
  if (entry !== undefined && entry.value === value) {
    store.delete(key);
    generation++;
  }
}

// Tests mutate callers/identities/policies mid-run and expect immediate effect.
export function clearConfigCache(): void {
  store.clear();
  generation++;
}
