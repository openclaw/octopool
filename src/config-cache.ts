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

type Entry = { value: unknown; expires: number };
const store = new Map<string, Entry>();

export async function cachedConfigLookup<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit !== undefined && hit.expires > now) {
    return hit.value as T;
  }
  const value = await load();
  if (store.size >= MAX_ENTRIES) {
    for (const [staleKey, entry] of store) {
      if (entry.expires <= now) {
        store.delete(staleKey);
      }
    }
    if (store.size >= MAX_ENTRIES) {
      store.clear();
    }
  }
  store.set(key, { value, expires: now + CONFIG_CACHE_TTL_MS });
  return value;
}

// Tests mutate callers/identities/policies mid-run and expect immediate effect.
export function clearConfigCache(): void {
  store.clear();
}
