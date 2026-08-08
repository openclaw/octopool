# Deployment & Operations

Octopool runs as a Cloudflare Worker (`octopool`) plus a Durable Object class
(`PoolCoordinator`) and a D1 database. The OpenClaw deployment serves the authoritative
data plane at `octopool.openclaw.ai`; a thin `octopool.dev` Worker in the domain's
Cloudflare account forwards into it so both hosts share one cache. Self-hosters can
ignore that proxy and deploy only the main Worker.

The Go CLI is a separate, statically-linked binary released via GoReleaser.

Source: `wrangler.jsonc`, `wrangler.public-proxy.jsonc`, `migrations/`, `package.json`,
`test/e2e.sh`.

## Self-host on Cloudflare

Prerequisites:

- Cloudflare account on the Workers Paid plan (Durable Objects + D1 require it).
- A domain you can route at a Worker — managed by Cloudflare, or with a CNAME you can
  point at the Worker.
- A GitHub org you can verify membership against (`ALLOWED_GITHUB_ORG`).
- At least one GitHub identity to pool — a PAT, or a GitHub App installation on the repos
  you want to serve.

### 1. Clone and configure

```sh
git clone https://github.com/openclaw/octopool.git
cd octopool
pnpm install
```

Edit `wrangler.jsonc`:

- `account_id` — your Cloudflare account id.
- `vars.ALLOWED_GITHUB_ORG` — the GitHub org whose members may mint caller tokens.
- `vars.DEFAULT_ALLOWED_OWNERS` — comma-separated GitHub owners (orgs/users) with scoped
  identity routing. Other public repositories are allowed by the public-repo guard.
- `vars.GITHUB_OAUTH_CLIENT_ID` — OAuth client id of your GitHub App, used for browser
  sign-in. Pair with the `GITHUB_OAUTH_CLIENT_SECRET` secret below.
- `vars.GITHUB_OAUTH_CALLBACK_ORIGIN` — optional HTTPS origin registered as the GitHub
  OAuth callback when browser sign-in starts on a different host.
- `routes[]` — the custom domain you want octopool served on.

If you only need one host, ignore `wrangler.public-proxy.jsonc`. OpenClaw uses it only
because `octopool.dev` lives in a different Cloudflare account from the authoritative
`octopool.openclaw.ai` data plane.

### 2. Create the data plane

```sh
wrangler d1 create octopool
# copy the printed database_id into wrangler.jsonc d1_databases[].database_id

wrangler d1 migrations apply octopool --remote
```

The `PoolCoordinator` Durable Object class is provisioned by the migration tag in
`wrangler.jsonc` on first `wrangler deploy` — no separate step.

### 3. Add secrets

Every credential lives in Cloudflare's secret store. Nothing here ever goes into
`wrangler.jsonc`, D1, or logs.

```sh
wrangler secret put OCTOPOOL_ADMIN_TOKEN              # bearer for /v1/admin/* and octopool admin ...
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET        # browser GitHub login (with GITHUB_OAUTH_CLIENT_ID)
wrangler secret put OCTOPOOL_PROXY_SECRET             # only if you run a second proxy Worker
wrangler secret put OCTOPOOL_GITHUB_ORG_TOKEN         # background org-membership + public-repo proof
wrangler secret put OCTOPOOL_GITHUB_APP_ID            # only if you use GitHub App identities
# one secret per pooled identity, referenced by name from D1:
wrangler secret put OCTOPOOL_PAT_ALICE                # raw PAT value
wrangler secret put OCTOPOOL_GITHUB_APP_PRIVATE_KEY   # PKCS#8 (BEGIN PRIVATE KEY) PEM
```

Keep copies in a real secret manager (1Password, etc.) — Cloudflare's UI does not show
the values back after you set them.

### 4. Deploy the Worker

```sh
wrangler deploy
```

For Cloudflare-managed domains, the `routes[]` entry registers the custom domain
automatically. For external DNS, CNAME the host at the Worker once.

### 5. Register at least one identity

```sh
export OCTOPOOL_ADMIN_TOKEN=...                              # the value you set above
export OCTOPOOL_URL=https://octopool.your-org.dev

octopool admin identity \
  --pool maintainers \
  --id pat_alice --login alice \
  --secret-ref OCTOPOOL_PAT_ALICE \
  --scope your-org

# Optional broad public-repo PAT identity:
octopool admin identity \
  --pool maintainers \
  --id pat_public --login alice \
  --secret-ref OCTOPOOL_PAT_ALICE \
  --scope '*'
```

The first reference to a pool by name (here, `maintainers`) creates it with the default
policy. Verified org members can now `octopool login https://octopool.your-org.dev` and
use the relay; the registered identities serve misses that cache and token-free transports
cannot satisfy. See
[Admin & provisioning](admin.md) for `--scope`, `--kind github_app`, and `--installation-id`
shapes.

### 6. Verify

```sh
curl https://octopool.your-org.dev/.well-known/octopool
# {"service":"octopool","version":1,"api_base":"...","default_pool":"maintainers", ...}

OCTOPOOL_E2E_HOST=octopool.your-org.dev pnpm e2e
octopool stats
```

## Cloudflare resources

- Worker `octopool` — entry `src/index.ts`, `nodejs_compat`, observability on.
- Public-host Worker `octopool` in the personal Cloudflare account (OpenClaw deployment
  only) — entry `src/openclaw-proxy.ts`, custom-domain proxy for `octopool.dev`.
- Durable Object `PoolCoordinator` (binding `POOL_COORDINATOR`, SQLite-backed,
  migration tag `v1`).
- D1 database `octopool` (binding `DB`).
- Custom domain route — `octopool.dev` for OpenClaw; whatever you set in `routes[]` for
  your own deployment.

## Configuration

Plain vars (in `wrangler.jsonc`):

- `ALLOWED_GITHUB_ORG` — the only GitHub org that can mint caller tokens.
- `DEFAULT_ALLOWED_OWNERS` — comma-separated owners served by scoped identity routing.
- `MAX_RESPONSE_BYTES` — 2 MiB default; large-payload routes use this cap.
- `REQUEST_TIMEOUT_MS` — 15s default.
- `ORG_VERIFY_TTL_SECONDS` — 24h default; how long an org-membership verification stays
  fresh before octopool re-checks at request time.
- `GITHUB_OAUTH_CLIENT_ID` — GitHub App OAuth client id used for browser sign-in.

Optional vars (set as needed): `PUBLIC_REPO_TTL_SECONDS` (default 30),
`DEFAULT_LOGIN_POOL` (default `maintainers`).

Secrets (via `wrangler secret put`, never in D1/KV/logs):

- `OCTOPOOL_ADMIN_TOKEN` — admin API auth.
- `GITHUB_OAUTH_CLIENT_SECRET` — website GitHub login.
- `OCTOPOOL_PROXY_SECRET` — shared secret on both Workers so only the public-host proxy
  can assert the original `octopool.dev` host.
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
- `0006_pr_state_proofs.sql` — short-lived validated PR state discriminators for
  state-aware PR subresource cache keys.
- `0007_audit_cache_stale.sql` — stale-cache audit status and cacheability metrics.
- `0008_public_api_rates.sql` — anonymous GitHub API quota snapshots recorded from API
  responses.
- `0009_audit_outcomes.sql` — local-fallback reasons and coalesced-fill telemetry.
- `0010_audit_retention.sql` — audit timestamp index for bounded retention cleanup.
- `0011_cache_stale_retention.sql` — per-entry stale deadlines and indexed cache cleanup.
- `0012_caller_clients.sql` — concurrent per-client caller tokens and audit attribution.
- `0013_audit_backends.sql` — bounded upstream-source attribution for route-level stats.

Apply with `wrangler d1 migrations apply octopool` (add `--remote` for production).

## Build, test, deploy

```sh
pnpm install
pnpm check        # format:check + lint + vitest + build + go test + go vet
pnpm test         # vitest only
pnpm test:e2e:cli-worker # compiled CLI → local Workerd/D1/DO → public GitHub
pnpm run deploy   # authoritative Worker, then octopool.dev proxy Worker
pnpm e2e          # smoke-test the live deployment
```

`pnpm check` is the deterministic TypeScript + Go gate. The networked release gate
`pnpm test:e2e:cli-worker` additionally crosses the compiled CLI, local Workerd, migrated
D1, a real Durable Object, and public GitHub. The Go CLI also builds/tests with
`go build ./cmd/octopool` and `go test ./...`.

`pnpm run deploy` runs both `wrangler deploy` calls. Self-hosters who don't operate the
public-host proxy can run `wrangler deploy` directly. Pushing to `main` does **not**
auto-deploy the Worker — only the docs site has a GitHub Pages workflow. Run
`wrangler deploy` (or `pnpm run deploy`) whenever Worker code or landing-page CSS needs to
ship to production.

## SQL catalog

Runtime SQL lives in `sql/queries/*.sql` with sqlc annotations. `sqlc.yaml` points sqlc at
the D1 migrations plus the Durable Object SQLite schema. `pnpm sql:compile` validates the
catalog without generating an unused Go package. `pnpm sql:generate` updates
`src/generated/sql.ts`, the D1/Durable Object query constants used by the Worker.

Run `pnpm sql:generate` after changing query files. `pnpm check` runs `pnpm sql:check`
first and fails if generated SQL artifacts are stale.

## Smoke test

`test/e2e.sh` resolves `octopool.dev` by default, then asserts:

- `GET /` returns the landing page. On `octopool.dev` it must show the Homebrew install
  command, not the GitHub login CTA.
- `GET /dashboard` redirects to the authoritative app host on `octopool.dev`, and to
  GitHub login on `octopool.openclaw.ai`.
- `GET /` with `Accept: application/json` returns the JSON health body (`"ok":true`, `"service":"octopool"`).
- `GET /.well-known/octopool` returns discovery metadata for CLI self-host login.
- `GET /v1/pools/maintainers/health` without a token returns `401 missing_auth`.
- `POST /v1/github/request` without a token returns `401 missing_auth`.

Override the host/resolver with `OCTOPOOL_E2E_HOST` / `OCTOPOOL_E2E_RESOLVER`.

## Observability

Observability is enabled at full sampling. Every validated request from an authenticated
caller to an existing pool writes an `audit_events` row (caller, client, pool, route key/kind,
identity, status, error/fallback classification, duration, cache hit/miss/bypass status,
and coalesced-fill marker); parse, authentication, and pool-lookup failures occur before
that boundary. Secrets and request bodies are never recorded.

The main Worker has an hourly cron trigger at minute 17. It deletes bounded batches of
cache entries after each entry's route-specific stale deadline and audit rows older than
30 days; this retains every configured stale window and the full supported stats window
without unbounded D1 growth.

`GET /v1/pools/<pool>/stats?since=24h` returns pool-, caller-, and client-specific cache stats,
plus bounded backend-by-route and local-fallback-reason aggregates.
The CLI wraps this as `octopool stats`. The browser dashboard at `/dashboard` exposes the
same data plus identity health, live leases, seven-day normalized request patterns and
outcome causes, and per-caller/client usage — see
[Dashboard](dashboard.md).
