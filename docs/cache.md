# Cache & Public-Repo Guard

Octopool owns a shared, read-through D1 cache for `gh` reads, and guards every repo route
with a public-visibility check. Both keep private data out of the shared cache and reduce
load on pooled identities.

Source: `src/cache.ts`, `src/public-repos.ts`, migrations `0002`/`0003`.

## Read-through D1 cache

On a cacheable route the relay computes a stable cache key, checks
`github_cache_entries`, and serves a fresh hit without touching GitHub. On a miss it
performs the GitHub call and writes the result back.

### Cache key

SHA-256 (base64url) over a stable, sorted JSON of: pool, method, path, query, the
vary headers (`accept`, `x-github-api-version`), and the normalized route key. The key is
pool-scoped, so pools never share cache entries.

### What is cached

Only `200` responses on cacheable routes are stored. The cache is **bypassed** when:

- the route is a log route, large-payload route, or `rate_limit`, or
- the request carries a conditional header (`if-none-match` / `if-modified-since`).

### TTLs

Per route kind (`cacheTTLSeconds`):

- `pr_view`, `issue_view`, `branch_view` → 30s
- `run_view`, `run_jobs`, `commit_check_runs`, `commit_status` → 15s
- everything else → 60s

### Cache-hit integrity

A hit is only served if:

- the source identity recorded on the entry is still an active candidate for the route,
  and
- the repo's public-visibility proof still covers the entry (re-checked, with a small
  historical-proof allowance during GitHub outages / secondary-rate-limit — see below).

Hits are still audited, with the cached identity attributed. Each audit row records cache
status as `hit`, `miss`, `bypass`, or `unknown`, which powers `octopool stats` and the
dashboard hit-rate/top-route views.

## Public-repo guard

The shared cache and pooled identities are **public-repository only**. Before any repo
route uses a pooled identity or a cache entry, `ensurePublicGitHubRepo` confirms the repo
is public.

- An unauthenticated `GET /repos/{owner}/{repo}` is made against GitHub.
- If `OCTOPOOL_GITHUB_ORG_TOKEN` is configured, that server-side token is used for the
  check to avoid shared unauthenticated GitHub quota; Octopool still requires the
  response body to say `private: false`.
- `404` or `private !== false` → `403 repo_not_public`.
- A successful public check is recorded in `github_public_repos` with a TTL
  (`PUBLIC_REPO_TTL_SECONDS`, default 30s); subsequent requests reuse the fresh proof
  instead of re-hitting GitHub.

### Historical proof during outages

If the live public check fails with a `5xx`, or a `403` with `x-ratelimit-remaining: 0`
(secondary rate limit), the guard may fall back to a previously recorded proof that was
captured close to the cache entry's creation time (within 5s). This lets cached public
data keep serving through transient GitHub failures without ever relaxing the
private-repo block — a hard `404`/private response always denies.

## Schema

- `github_cache_entries` — cache key, pool, method, path, query/headers JSON, route
  key/kind, status, response headers JSON, body JSON, body encoding, source identity,
  created/expires timestamps (migration `0002`).
- `github_public_repos` — `owner`, `repo`, `checked_at`, `expires_at` (migration `0003`).
- `audit_events.cache_status` / `audit_events.cacheable` — per-request cache metrics
  (migration `0005`).

Secret values are never written to the cache. R2 is deferred; current routes are bounded
enough to live in D1, and large Actions logs skip the cache entirely.
