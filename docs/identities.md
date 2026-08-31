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
- `rate_states` — newest reset window and lowest observed remaining budget within that
  window, per identity and resource bucket.
- `cooldowns` — per identity, scoped to `*`, `resource:<r>`, or a route key.
- `cache_fills` — renewable, token-fenced ownership for concurrent identical cache misses;
  completion wakes followers with the confirmed publication outcome.

`selectIdentity` logic:

1. If a live lease for the route key points at a candidate that is not cooling down and
   not quota-exhausted, reuse it (`reason: sticky`).
2. Otherwise score each non-cooling candidate by `remaining + weight` (unknown rate
   assumes a fresh 5000 budget; an exhausted-but-unreset identity is skipped) and take
   the best (`reason: highest_remaining`).
3. If every candidate is cooling down or quota-exhausted, selection reports
   `identities_cooling_down`; the relay uses its existing stale-cache or typed
   `424 fallback_local` response.

The winning route gets a fresh 10s lease so concurrent callers stick to the same identity
briefly instead of stampeding.

## Health feedback (cooldowns)

After an identity-backed GitHub resource call, `recordResult` merges complete, valid
`x-ratelimit-remaining`/`x-ratelimit-reset` observations into `rate_states`. A greater
reset timestamp starts a new window; an equal reset keeps the minimum remaining count;
an older reset cannot change the row. Same-window limit metadata remains the first
accepted value, so differing limits are not order-independent. A newer window updates
the limit, using the existing 5000 default when it is absent.

Numeric headers must be whole-decimal nonnegative safe integers. Reset must be positive
and remain safe when converted from seconds to milliseconds. Invalid supplied quota
fields or an incomplete remaining/reset pair leave known rate state untouched, including
exhaustion. RPC inputs are also validated. A newer complete positive observation or
wall-clock time equal to the reset restores quota eligibility; a sticky lease cannot
bypass live exhaustion. This is conservative feedback, not quota reservation: requests
already in flight can still consume the same last unit, and same-window quota increases
remain suppressed until reset.

Only `401`/`403`/`429` write cooldowns, independently of quota validation:

- `401` → global `*` cooldown (usable Retry-After, otherwise 120s).
- `403` or `429` with usable Retry-After → global `*` cooldown for that duration.
- `403` without usable Retry-After → route-key cooldown, 120s, including permission/SSO
  failures. A complete zero-budget observation also excludes that resource until reset.
- `429` without usable Retry-After → `resource:<resource>` cooldown, 120s.

Retry-After supports integer seconds only, with a one-second minimum. HTTP dates,
malformed numbers, and durations whose absolute deadline is unsafe use the defaults
above; there is no additional duration cap. Other statuses, including `404`/`422` and
`5xx`, can update valid quota observations but do not create cooldowns. A `403` with zero
remaining and no usable reset creates only the route cooldown: it does not establish
resource-wide exhaustion or invent a reset.

Each cooldown key retains its greatest expiry and the status/reason attached to that
deadline. Equal or shorter updates do nothing. Route, resource and global keys remain
independent; a success or newer rate window does not clear a live cooldown. Selection
and snapshots ignore expired rows at exact deadline equality, without deleting them.
Rate and cooldown writes for one result use a synchronous storage transaction, so a
failed second write cannot leave a partially accepted observation.

The trusted route determines the identity's `core`/`search` bucket; the response resource
header cannot override it. Anonymous API snapshots and App token-exchange responses do
not update identity budgets. State survives Durable Object eviction. Replaying the same
absolute SQL observation is idempotent; replaying the relative-duration `recordResult`
RPC can extend a cooldown. Feedback errors do not initiate retries or compensating state
deletion. No schema migration or state reset is required; previously overwritten
observations cannot be reconstructed by this repair.

## Registration

Identities are created/updated by admins via
`POST /v1/admin/pools/:pool/identities` or `octopool admin identity`. See
[Admin & provisioning](admin.md). `weight` (default 100) biases selection between
otherwise-equal identities.
