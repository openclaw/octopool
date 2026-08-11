# Pooled Identities & Routing

A pool holds one or more GitHub identities. The relay serves cache hits and equivalent
token-free reads first; only the remaining requests select an identity. Routing prefers
healthy identities with available rate budget and avoids piling many callers onto the
same identity.

Source: `src/db.ts` (`loadIdentities`), `src/github-auth.ts` (token minting),
`src/pool-coordinator.ts` (selection), `src/provisioning.ts` (registration).

## Identity kinds

### `pat`

A user/service GitHub Personal Access Token, stored as a Cloudflare Worker secret. The
identity's `secret_ref` is the binding name; the Worker reads the token at request time
and never logs or returns it.

### `github_app`

A GitHub App installation. The identity carries an `installation_id` and a `secret_ref`
that points at the App's **PKCS#8** private key secret. The Worker:

1. Mints a short-lived RS256 JWT for the App (`OCTOPOOL_GITHUB_APP_ID`) using WebCrypto.
2. Exchanges it for an installation access token via
   `POST /app/installations/{id}/access_tokens`.
3. Caches the installation token in memory and refreshes it ~60s before expiry.

The private key must be `BEGIN PRIVATE KEY` (PKCS#8) PEM — `BEGIN RSA PRIVATE KEY`
(PKCS#1) is rejected with `503 github_app_key_format`, because WebCrypto only imports
PKCS#8. For v1 the `octopool-cache` App is installed on selected repositories only
(`openclaw/openclaw`); no private-repo installations.

## Scopes

Each identity has one or more `identity_scopes` rows (`owner`, optional `repo`,
`allow_private`). When a request targets `owner/repo`, only identities scoped to that
owner (with a matching `repo` or an owner-wide `NULL` repo) are candidates. A PAT scoped
to `*` can serve any repository after public proof; scoped PATs and GitHub Apps remain
limited to their configured owner/repository. Routes with no owner (e.g. `/rate_limit`)
consider all active identities in the pool.

`allow_private` exists in the schema but the shared relay is public-repository-only in
v1; the [public-repo guard](cache.md) blocks private routes regardless.

## Selection (PoolCoordinator)

Identity selection runs in a Durable Object partitioned per pool (`pool:<pool_id>`). It
keeps four SQLite tables in DO storage:

- `leases` — sticky route→identity binding, 10s TTL.
- `rate_states` — last seen `remaining`/`reset_at` per identity and resource bucket.
- `cooldowns` — per identity, scoped to `*`, `resource:<r>`, or a route key.
- `cache_fills` — renewable, token-fenced ownership for concurrent identical cache misses;
  completion wakes followers with the confirmed publication outcome.

`selectIdentity` logic:

1. If a live lease for the route key points at a candidate that is not cooling down and
   not quota-exhausted, reuse it (`reason: sticky`).
2. Otherwise score each non-cooling candidate by `remaining + weight` (unknown rate
   assumes a fresh 5000 budget; an exhausted-but-unreset identity is skipped) and take
   the best (`reason: highest_remaining`).
3. If every candidate is cooling down, the Worker returns `503 identities_cooling_down`.

The winning route gets a fresh 10s lease so concurrent callers stick to the same identity
briefly instead of stampeding.

## Health feedback (cooldowns)

After each GitHub call, `recordResult` updates `rate_states` from the response's
`x-ratelimit-*` headers and, on a `401`/`403`/`429`, writes a cooldown:

- `401` → global `*` cooldown (Retry-After, else 120s).
- a `Retry-After` on any error → global `*` cooldown for that duration.
- `403` with budget remaining (secondary/abuse limit) → global `*` cooldown, 120s.
- `429` → `resource:<resource>` cooldown, 120s.
- otherwise → route-key cooldown, 120s.

Cooling-down identities are skipped by selection until their cooldown expires.

## Registration

Identities are created/updated by admins via
`POST /v1/admin/pools/:pool/identities` or `octopool admin identity`. See
[Admin & provisioning](admin.md). `weight` (default 100) biases selection between
otherwise-equal identities.
