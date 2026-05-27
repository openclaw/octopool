# Deployment & Operations

Octopool is a single Cloudflare Worker plus a Durable Object and a D1 database, served on
the `octopool.dev` custom domain. The Go CLI is a separate binary.

Source: `wrangler.jsonc`, `migrations/`, `package.json`, `test/e2e.sh`.

## Cloudflare resources

- Worker `octopool` — entry `src/index.ts`, `nodejs_compat`, observability on.
- Durable Object `PoolCoordinator` (binding `POOL_COORDINATOR`, SQLite-backed,
  migration tag `v1`).
- D1 database `octopool` (binding `DB`).
- Custom domain route `octopool.dev`.

## Configuration

Plain vars (in `wrangler.jsonc`):

- `ALLOWED_GITHUB_ORG` = `openclaw`
- `DEFAULT_ALLOWED_OWNERS` = `openclaw`
- `MAX_RESPONSE_BYTES` = `2097152`
- `REQUEST_TIMEOUT_MS` = `15000`
- `ORG_VERIFY_TTL_SECONDS` = `86400`
- `GITHUB_OAUTH_CLIENT_ID` = Octopool GitHub App OAuth client id

Optional vars (set as needed): `PUBLIC_REPO_TTL_SECONDS` (default 30), `DEFAULT_LOGIN_POOL`
(default `maintainers`).

Secrets (via `wrangler secret put`, never in D1/KV/logs):

- `OCTOPOOL_ADMIN_TOKEN` — admin API auth.
- `GITHUB_OAUTH_CLIENT_SECRET` — website GitHub login.
- `OCTOPOOL_GITHUB_ORG_TOKEN` — background org-membership verifier and public-repo
  proof fetcher.
- `OCTOPOOL_GITHUB_APP_ID` — GitHub App id (for App identities).
- One secret per identity `secret_ref` — PAT value, or the App private key as **PKCS#8**
  (`BEGIN PRIVATE KEY`) PEM. Keep a copy in 1Password.

## Migrations

D1 schema lives in `migrations/`:

- `0001_init.sql` — pools, callers, caller_pools, identities, identity_scopes,
  audit_events.
- `0002_github_cache.sql` — `github_user_id` column + production caller backfill, and
  `github_cache_entries`.
- `0003_github_app_public_cache.sql` — `installation_id` column and `github_public_repos`.
- `0004_web_dashboard_sessions.sql` — dashboard role, OAuth states, and hashed website
  sessions.
- `0005_audit_cache_metrics.sql` — per-request cache status and cacheability columns,
  plus stats indexes for route and hit-rate aggregates.

Apply with `wrangler d1 migrations apply octopool` (add `--remote` for production).

## Build, test, deploy

```sh
pnpm install
pnpm check     # format:check + lint + vitest + build + go test + go vet
pnpm test      # vitest only
pnpm deploy    # wrangler deploy
pnpm e2e       # smoke-test the live deployment
```

`pnpm check` is the full gate (TypeScript + Go). The Go CLI also builds/tests with
`go build ./cmd/octopool` and `go test ./...`.

## SQL catalog

Runtime SQL lives in `sql/queries/*.sql` with sqlc annotations. `sqlc.yaml` points sqlc at
the D1 migrations plus the Durable Object SQLite schema, and `pnpm sql:generate` updates:

- `internal/dbquery/` — sqlc's generated Go package, used as a parser/typecheck artifact.
- `src/generated/sql.ts` — generated D1/Durable Object query constants used by the Worker.

Run `pnpm sql:generate` after changing query files. `pnpm check` runs `pnpm sql:check`
first and fails if generated SQL artifacts are stale.

## Smoke test

`test/e2e.sh` resolves `octopool.dev`, then asserts:

- `GET /` returns the landing page.
- `GET /` with `Accept: application/json` returns the JSON health body (`"ok":true`, `"service":"octopool"`).
- `GET /v1/pools/maintainers/health` without a token returns `401 missing_auth`.
- `POST /v1/github/request` without a token returns `401 missing_auth`.

Override the host/resolver with `OCTOPOOL_E2E_HOST` / `OCTOPOOL_E2E_RESOLVER`.

## Observability

Observability is enabled at full sampling. Every routed request writes an `audit_events`
row (caller, pool, route key/kind, identity, status, error code, duration, cache
hit/miss/bypass status); secrets and request bodies are never recorded.

`GET /v1/pools/<pool>/stats?since=24h` returns pool-wide and caller-specific cache stats.
The CLI wraps this as `octopool stats`.
