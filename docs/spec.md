# Octopool Spec

## Product contract

Octopool is a self-hosted, Cloudflare-hosted GitHub read relay and shared cache. Trusted
users and agents share explicitly managed GitHub identities without receiving the pooled
credentials. The service centralizes read policy, public-repository enforcement, caching,
rate-budget routing, and audit data.

## Goals

- Route supported read-only GitHub requests through one authenticated relay.
- Serve fresh edge/D1 cache entries and equivalent token-free GitHub transports before
  spending pooled PAT or GitHub App quota.
- Select healthy identities by resource budget; apply sticky leases and cooldowns.
- Coalesce concurrent identical cache misses.
- Keep GitHub credentials out of client config, D1, responses, caches, and audit rows.
- Expose compact health, cache, rate, caller, and outcome data to operators.
- Delegate unsafe commands locally before relay contact and safe-but-unserviceable reads
  only after an explicit `fallback_local` response.

## Non-goals

- General-purpose HTTP proxy or multi-tenant SaaS.
- Shared private-repository reads or caching.
- GitHub mutations or GraphQL in the current protocol.
- Bypassing GitHub authorization, permissions, rate limits, or abuse controls.
- Replacing project-specific mirrors, indexes, or triage stores.

## Trust and security model

Pools and identities are explicit and admin-managed. PATs and GitHub App private keys are
Cloudflare Worker secrets referenced by stable names in D1. Installation tokens are minted
server-side and cached in Worker memory.

The shared relay is public-repository-only. Repository routes require a live or narrowly
bounded historical public proof before pooled credentials or cached data can be used. A
hard private/404 result always denies. Broad `*` PAT scopes may serve any proven-public
repository; scoped PATs and GitHub Apps remain limited to their configured owner/repository.

Only approved GitHub API, web, raw-content, Git smart HTTP, and signed Actions-log hosts
are reachable. Requests have strict path/query/header validation, timeouts, redirect rules,
response-size caps, and safe response-header projection. Authorization and cookies never
leave the Worker response boundary.

## Architecture

- `src/index.ts`: Worker lifecycle, security headers, scheduled maintenance, Durable Object export.
- `src/router.ts`: ordered HTTP endpoint dispatch.
- `src/relay.ts`: typed relay preparation, cache, backend, success, error, and audit stages.
- Feature modules: auth, provisioning, route policy, cache, public proof, token-free GitHub
  adapters, dashboard read models, stats, and browser sessions.
- `PoolCoordinator`: one SQLite-backed Durable Object per pool; identity leases, rate state,
  cooldowns, and cache-fill leases.
- D1: pools, callers, identity metadata/scopes, sessions, proofs, cache entries, anonymous
  rate snapshots, and audit events.
- Cloudflare Cache API: data-center-local cache ahead of D1.
- `octopool` Go CLI: login/admin/stats commands, safe `gh` translation, strict envelope
  decoding, and real-`gh` delegation.

Durable Object partition key: `pool:<pool_id>`.

## Relay flow

1. Parse and validate the normalized relay request.
2. Authenticate the hashed caller token and pool grant; load the pool policy.
3. Classify the route, enforce policy, validate optional PR-state hints, and derive a
   normalized route/cache key.
4. For cacheable routes, read the edge cache then D1. Validate cached identity eligibility
   and public-repository proof before serving.
5. Acquire renewable, token-fenced cache-fill ownership. Followers wait on coordinator
   completion (`shared`, `edge_only`, or `failed`) rather than polling cache storage.
6. Try an exact token-free adapter: anonymous API, public page/raw content, or Git smart HTTP.
7. Establish public-repository proof from the direct response or the explicit guard.
8. If the route requires credentials, select a scoped identity through the pool coordinator,
   call GitHub, record rate state/cooldowns, and retry another candidate when appropriate.
9. Sanitize and publish eligible `200` responses to D1 and the edge cache.
10. Return the relay envelope; asynchronously record the authenticated/validated outcome.
11. If a safe read cannot be served, return `424 fallback_local` with a reason. The CLI
    reruns the original command with real `gh` unless local fallback is disabled.
12. Complete the owned fill immediately after publication; every other owned exit completes
    `failed`, while lost/stale tokens cannot release a newer owner.

Conditional, log, large-payload, `rate_limit`, and otherwise non-cacheable requests bypass
cache. A `cache-control: max-age=N` request directive instead treats fresh entries older
than `N` seconds as coalesced misses whose refills write through to the shared cache.
Route-specific bounded stale entries may be served for quota/depletion/cooldown
failures after the same identity and public-proof checks.

## Relay API

### `POST /v1/github/request`

Bearer-authenticated primary endpoint.

```json
{
  "pool": "maintainers",
  "method": "GET",
  "path": "/repos/openclaw/openclaw/pulls/123",
  "query": { "per_page": "100" },
  "headers": { "accept": "application/vnd.github+json" },
  "route_hint": {
    "pr_head_sha": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

Only `GET` and no request body are supported. Query values are strings or string arrays;
secret-shaped keys are rejected. Forwarded request headers are limited to content
negotiation/API version and conditional cache headers.

Validated `route_hint.pr_head_sha` and closed/merged `route_hint.pr_state` may partition PR
subresource cache entries. Legacy `route_hint.owner/repo/kind`, `cache_key`, and
`idempotency_key` inputs remain accepted and discarded solely for wire compatibility.

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": {},
  "body_encoding": "json",
  "identity": { "id": "pat_primary", "kind": "pat" },
  "relay": {
    "pool": "maintainers",
    "request_id": "...",
    "cacheable": true,
    "cache": "miss",
    "stale_ok": false,
    "route_kind": "pr_view",
    "lease_reason": "highest_remaining"
  }
}
```

`body_encoding` is exactly `json`, `text`, or `base64`. `identity` is omitted for
token-free results and contains only `id`/`kind` when present. `relay.backend` identifies
`web` or `github_public` token-free results. Unsupported/policy-denied safe routes are
normalized to `424 fallback_local` with the original denial in `details.reason`.

The generated route inventory in [GitHub Read Relay](relay.md) and transport matrix in
[Token-Free GitHub Endpoints](token-free.md) are canonical. GraphQL and mutations remain
deferred.

### Other APIs

- `POST /v1/login/github-cli`: validate a local GitHub token/org membership and mint a
  one-time plaintext token for a named client; only its SHA-256 hash is stored, and
  rotating one client does not invalidate the caller's other clients. Each caller retains
  at most 16 named clients; a new name retires the least recently updated other session.
- `GET /v1/pools/:pool/health`: `pool`, `identities_total`, `identities_healthy`,
  `policy_version`.
- `GET /v1/pools/:pool/stats`: pool/caller/client request, outcome, cache, coalescing, and
  route aggregates for a bounded time window.
- `POST /v1/admin/callers`: verify/provision a caller and pool grant.
- `POST /v1/admin/pools/:pool/identities`: create/update identity metadata and replace scopes.
- `/login/github`, callback, logout, `/dashboard`, `/v1/dashboard`: signed OAuth state,
  hashed web sessions, admin role, and pool-grant-gated operator views.

## Identity routing

Selection inputs are route key, GitHub resource bucket, scoped active candidates, their
weights, persisted rate state, and active cooldowns. A valid 10-second route lease wins
first. Otherwise the highest `remaining + weight` candidate wins; unknown rate state starts
from the default 5000 budget. Exhausted or cooling candidates are skipped.

Results update `rate_states` and create global, resource, or route cooldowns for auth,
secondary-limit, retry-after, and quota failures. Selection reasons are `sticky` or
`highest_remaining`.

## Storage model

D1 tables:

- `pools`, `callers`, `caller_pools`, `caller_tokens`
- `identities`, `identity_scopes`
- `web_sessions`
- `github_cache_entries`, `github_public_repos`, `github_pr_state_proofs`
- `github_public_api_rates`
- `audit_events`

PoolCoordinator SQLite tables:

- `leases`: 10-second route-to-identity bindings.
- `rate_states`: last GitHub remaining/reset state by identity/resource.
- `cooldowns`: global/resource/route exclusions.
- `cache_fills`: renewable, token-fenced ownership for duplicate misses and follower wake-up.

Runtime SQL lives in `sql/queries/*.sql`, is validated against `migrations/` and
`sql/schema/coordinator.sql`, and generates `src/generated/sql.ts`. Secret values are not
stored in either database.

## Authentication and authorization

- Caller API: per-client bearer token hash, active caller, matching org, fresh membership,
  pool grant.
- Admin API: separate constant-time-compared `OCTOPOOL_ADMIN_TOKEN`.
- Browser: signed OAuth state plus opaque, hashed, expiring `octopool_session`; dashboard
  additionally requires `dashboard_role = 'admin'`.
- GitHub: PAT secret or App PKCS#8 private-key secret; short-lived App tokens minted in Worker.

Audit starts after request validation, caller authentication, and pool lookup. Each later
success/failure records caller, client, pool, normalized route, identity when used, status, error/
fallback reason, duration, cache state, cacheability, and coalescing. Parse/auth/missing-pool
failures occur before audit context exists. Bodies, credentials, and raw tokens are excluded.

## CLI contract

- `octopool gh ...` and a binary named `gh` translate supported safe reads.
- Mutations, bodies, unsafe headers/queries, unsupported flags, and unknown commands delegate
  locally without contacting Octopool.
- With active rewrite rules, modeled local commands use strict structural snapshots; unmodeled
  delegated commands receive bounded best-effort filtering of visible argv, explicitly declared stdin, and
  `--input` snapshots rather than failing solely because their shape is unknown.
- Safe requests contact Octopool first and delegate only on explicit `fallback_local` or
  stale/invalid Octopool auth. `OCTOPOOL_NO_FALLBACK` disables delegation.
- The canonical relay client loop retries selected transient pool fallbacks and
  `5xx internal_error` responses plus malformed 502/503/504 gateway responses with bounded
  backoff; exhausted service failures do not delegate to local GitHub quota.
- Relay envelopes require a known body encoding; upstream status and CLI exit semantics are
  preserved.
- Bounded pagination delegates instead of returning partial PR details/checks/issue lists.
- Invalid numeric limits fail explicitly.

Configuration: `OCTOPOOL_URL`, `OCTOPOOL_TOKEN`, `OCTOPOOL_POOL`, `OCTOPOOL_GH_PATH`,
`OCTOPOOL_NO_FALLBACK`.

## Operations and observability

The stats API and dashboard expose request/error/fallback counts, cache hit/miss/stale/
bypass metrics, successful-eligible hit rate, coalesced fills, top routes, normalized route
patterns, outcome causes, per-caller/client use, identity health, rate snapshots, cooldowns, leases,
cache size, and public-proof counts.

Hourly maintenance deletes cache entries after persisted route-specific stale deadlines and
audit events older than the 30-day stats window in bounded batches.

Repository layout:

```text
cmd/octopool/                 Go CLI and generated route contracts
docs/                         product, API, deployment, and generated route docs
migrations/                   D1 schema history
scripts/                      route, SQL, and docs generators
sql/queries/                  canonical runtime SQL
sql/schema/coordinator.sql    Durable Object SQLite schema
src/                          modular Worker runtime
test/e2e/                     real workerd/D1/Durable Object integration suite
```

`pnpm check` is the deterministic local gate: generated route/SQL drift, formatting, lint,
unit and controlled-workerd E2E tests, TypeScript build, Go tests, and Go vet.
`pnpm test:e2e:cli-worker` is the networked compiled-CLI → local-Workerd/D1/DO release gate;
`pnpm e2e` is the live deployment smoke test.
