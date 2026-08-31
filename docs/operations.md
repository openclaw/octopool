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

If you only need one host, ignore `wrangler.public-proxy.jsonc`. OpenClaw uses it to
forward `octopool.dev` to the authoritative `octopool.openclaw.ai` data plane. Both
Workers run in the OpenClaw Services Cloudflare account.

### 2. Create the data plane

```sh
# pick the location hint nearest your callers (e.g. wnam, enam, weur);
# D1 location is fixed at creation and cannot be changed later
wrangler d1 create octopool --location wnam
# copy the printed database_id into wrangler.jsonc d1_databases[].database_id

wrangler d1 migrations apply DB --remote
```

The pool coordinator's location hint in `src/pool-coordinator.ts`
(`poolCoordinatorStub`) should match the D1 location so per-request coordinator
calls do not cross regions.

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

The hosted OpenClaw deployment keeps both Workers in the OpenClaw Services account
(`91b59577e757131d68d55a471fe32aca`):

- Authoritative Worker `octopool` — config `wrangler.jsonc`, entry `src/index.ts`,
  `nodejs_compat`, observability on, custom domain `octopool.openclaw.ai`.
- Public-host Worker `octopool-public-proxy` — config `wrangler.public-proxy.jsonc`, entry
  `src/openclaw-proxy.ts`, custom-domain proxy for `octopool.dev`.
- Durable Object `PoolCoordinator` (binding `POOL_COORDINATOR`, SQLite-backed,
  migration tag `v1`).
- D1 database `octopool-wnam` (binding `DB`).

Both hosted Worker deploys use the Molty item `OpenClaw Services Cloudflare API Token`;
the proxy does not use a personal-account Cloudflare credential. The shared
`OCTOPOOL_PROXY_SECRET` still has to exist on both Workers. Self-hosted deployments use
whatever account and routes they configure.

## Configuration

Plain vars (in `wrangler.jsonc`):

- `ALLOWED_GITHUB_ORG` — the only GitHub org that can mint caller tokens.
- `DEFAULT_ALLOWED_OWNERS` — comma-separated owners served by scoped identity routing.
- `MAX_RESPONSE_BYTES` — single response-body cap for every route (2 MiB default; the hosted
  deployment sets 4 MiB).
- `REQUEST_TIMEOUT_MS` — 15s default.
- `ORG_VERIFY_TTL_SECONDS` — 24h default; how long an org-membership verification stays
  fresh before octopool re-checks at request time.
- `GITHUB_OAUTH_CLIENT_ID` — GitHub App OAuth client id used for browser sign-in.

Optional vars (set as needed): `PUBLIC_REPO_TTL_SECONDS` (default 30; the hosted
deployment sets 900 — see the public-repo guard notes in `cache.md` for the trade),
`PUBLIC_REPO_NEGATIVE_TTL_SECONDS` (default 3600), `DEFAULT_LOGIN_POOL` (default
`maintainers`).

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

### Cache publication upgrade and restore

Apply additive `0020_cache_publication.sql` after `0019` and before routing traffic to
the publication-fenced Worker. Verify the owner table's AUTOINCREMENT primary key,
safe-integer CHECK, unique epoch/resource index and expiry index, the body receipt
columns, and the new `github_public_repo_proofs` table. The migration does not copy
legacy positive proofs, purge bodies, alter identity feedback, or apply itself remotely.

The server-owned `publication-v1` epoch composes with every existing representation
generation. New readers refuse old bodies/proofs, including stale and 304 candidates.
Warm-up therefore costs fresh upstream observations; no global purge is necessary.
Old Workers still in flight can call the retained legacy cache-fill RPCs and publish
only to their old key/proof namespaces. Each new acquisition also drains at most 16
expired `cache_fills` rows in its contacted DO using a local expiry index; live fills,
identity leases, cooldowns and rate feedback remain intact. Dormant old DOs retain their
rows until contacted. Remove the legacy RPC/table surface only after old Worker routing
and in-flight requests are demonstrably drained. Rolling back to old readers restores
the old publication defect, regardless of the new schema.

Never reset, drop/recreate, or restore `cache_publication_owners.sqlite_sequence` behind
issued capabilities within the same epoch. Backup/export must retain its high-water mark.
If restore/import/rebuild can lower it, deploy a **new isolated server epoch** before
resuming new-reader publication, covering body keys, proof keys and edge namespaces.
Do not reuse an epoch name or copy old positives into it. The final safe ID is
9007199254740991; exhaustion fails closed, rather than rounding, wrapping, or recycling.
There is no dynamic epoch registry: retired code may still write its own old namespace.
Drain its routing before claiming every request is repaired.

Owner completion deletes immediately. Each D1 acquisition batches indexed GC of at most
16 expired owners plus allocation (two SQL statements, one binding call). The hourly
idle fallback is at most 10,000 expired owners, separately from proof/body/audit pruning.
Traffic cleanup has sixteen removals per attempt versus at most one newly abandoned
grant; the eight-second expiry, bursts, outages and no-traffic periods still determine
transient occupancy. Monitor expired count and oldest expiry rather than claiming a
fixed cardinality or treating a bounded batch as a bounded backlog. DELETE makes pages
reusable and does not guarantee that the allocated SQLite file shrinks.

The following operator diagnostics are aggregate-only; they do not expose capability
tokens. Run them only through the operator's normal authorized database workflow:

```sql
SELECT count(*) AS owners,
       sum(lease_until_ms <= unixepoch('now') * 1000) AS expired_owners,
       min(CASE WHEN lease_until_ms <= unixepoch('now') * 1000
                THEN lease_until_ms END) AS oldest_expired_ms
FROM cache_publication_owners;
SELECT seq, 9007199254740991 - seq AS remaining_safe_ids
FROM sqlite_sequence WHERE name = 'cache_publication_owners';
```

These approximate monitoring timestamps have second resolution; publication and renewal
use the millisecond D1 execution clock. Local native D1 tests establish generated-query
behavior, retained sequence, commit receipts, expiry/GC, DO eviction, and Cache API
lifecycle. They do not establish hosted retry timing, globally ordered edge puts, D1
billing, or an atomic D1/DO/Cache API commit. An accepted delayed edge put can remain
visible until its original immutable expiry; hot hits add no new authority lookup.

### Migration inventory

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
- `0014_public_repo_negative_proofs.sql` — cached definitive private-repository proofs.
- `0015_drop_oauth_states.sql` — remove obsolete database-backed OAuth state.
- `0016_string_rewrites.sql` — authoritative deployment-wide singleton string policy;
  seeds explicit empty rules at revision 1.
- `0017_org_identity_verification.sql` — add a separate nullable identity-bound proof timestamp without backfill or changes to old data;
  apply before the [rolling Worker upgrade](auth.md#immutable-membership-upgrade). Old timestamp writes cannot authorize new Workers.
- `0018_active_caller_enrollment.sql` — unique active immutable GitHub ID plus case-insensitive org;
  refuses ambiguous duplicates without changing caller history. Apply before the updated enrollment Worker.
- `0019_client_name_guards.sql` — schema guards for normalized client-name aliases.
- `0020_cache_publication.sql` — committed publication ownership, body receipts, and isolated repository proofs.

Apply with `wrangler d1 migrations apply DB` (add `--remote` for production).

## Atomic enrollment upgrade

Before applying `0018_active_caller_enrollment.sql`, run this aggregate-only, read-only
preflight on the intended database. Rerun it at deployment: an earlier clean observation
is not a lock. Do not include caller names, IDs, hashes, or credentials in public proof.

```sql
WITH enrollment_groups AS (
  SELECT github_user_id, org_login COLLATE NOCASE AS org,
         COUNT(*) AS n, SUM(status = 'active') AS active_n
  FROM callers
  WHERE github_user_id IS NOT NULL
  GROUP BY github_user_id, org_login COLLATE NOCASE
)
SELECT
  (SELECT COUNT(*) FROM enrollment_groups WHERE active_n > 1)
    AS blocking_active_duplicate_groups,
  (SELECT COALESCE(SUM(active_n - 1), 0) FROM enrollment_groups WHERE active_n > 1)
    AS excess_active_rows,
  (SELECT COUNT(*) FROM enrollment_groups WHERE n > 1 AND active_n <= 1)
    AS nonblocking_historical_groups,
  (SELECT COUNT(*) FROM callers WHERE github_user_id IS NULL) AS null_id_rows,
  (SELECT COUNT(*) FROM callers WHERE github_user_id IS NULL AND status = 'active')
    AS active_null_id_rows,
  (SELECT COUNT(*) FROM callers WHERE github_user_id IS NOT NULL AND
    (typeof(github_user_id) <> 'integer' OR github_user_id <= 0
     OR github_user_id > 9007199254740991)) AS invalid_nonnull_id_rows;
```

A nonzero active-duplicate or malformed-ID count blocks deployment for operator review.
Historical/NULL counts are inventory, not evidence of ownership or permission to merge.
The index covers only active nonnull immutable IDs and uses `COLLATE NOCASE` for orgs;
malformed-ID review is a preflight gate, not a new schema constraint.

Apply schema first, including `0017_org_identity_verification.sql`, then verify the
migration record and the actual `idx_callers_active_github_org` definition before deploying
the Worker. Index creation is the authoritative uniqueness gate and fails unchanged if a
new duplicate appeared after preflight. Never automatically choose an oldest/newest row,
union grants, promote roles, or move tokens, sessions, or audit history. An operator must
explicitly decide which ambiguous rows to retire in place before retrying. Retired rows
must not be re-enabled as a recovery shortcut; that can revive attached credentials.

Existing singletons, disabled history, and NULL-ID records survive unchanged. Migration
0012's named `legacy` tokens are preserved without replaying that migration or adding a
bootstrap-hash authentication fallback. Same-client rotation retains token row IDs and
audit links. Ordinary cap pruning keeps the audit event, caller ID, and recorded client
name while the deleted token's audit FK becomes NULL. Browser sessions remain attached
to their original caller. Historical noncanonical client names (for example `host.local`
versus `host`) are not changed by migration 0018; see the client-name upgrade below for
verified singleton reconciliation and the remaining ambiguity decision.

During rollout, old code against the new index can reject a competing initial login;
new code without the index fails enrollment closed. Coordinate an enrollment quiet window
if transient errors matter. Keep the index on a Worker rollback. A failed migration leaves
the old enrollment race unresolved and must block rollout, not trigger a fallback. The
normal 30-second cross-isolate auth-cache window still applies after rotation or row
revocation. The deployment operator owns production preflight and deployment.

## Client-name upgrade

Apply `0019_client_name_guards.sql` before deploying the client-name Worker fix. Verify the
migration record and both `caller_tokens_canonical_insert` and `caller_tokens_canonical_update`
trigger definitions. Keep these guards on rollback. This schema-only migration never rewrites
existing token names, hashes, audit labels or foreign keys, and deliberately permits existing
ambiguous families to remain authenticated. It adds no per-relay write or history backfill.

The policy removes every trailing `.local` suffix, case-insensitively, preserving base case.
It treats compound spellings as aliases, not evidence of their original intent or physical
host identity. Verified login resolves the immutable caller inside the existing atomic batch,
renames an unambiguous singleton in place, rotates its token, then applies the normal cap.
The row ID, creation time and audit links survive; unrelated clients, roles, grants and browser
sessions are preserved. A family with multiple stored rows refuses with `409 client_name_ambiguous`;
no new credential, profile refresh, grant or pruning commits. Existing credentials keep working.

An operator must review each refused family and explicitly decide which credentials, if any,
to retire. Do not choose by age, recent use or display label, union privileges, reparent audit
history, or globally backfill names. Deleting a token clears its audit token FK under the existing
schema; retaining every retired token identity would require a separately approved retirement
design. The deployment operator owns production inventory and that unresolved decision.

The triggers reject new noncanonical names and canonical inserts conflicting with a historical
alias. Old Workers may therefore reject compound-name or historical-alias login during rollout;
they cannot reintroduce a raw alias after corrected rotation. Old canonical writes still rotate
an already reconciled singleton. Coordinate an enrollment quiet window if transient old-Worker
errors matter. Deploy schema first and drain old Workers; new code without the guards is not a
supported deployment. Upgrade CLIs and re-login to refresh saved labels. The 30-second
cross-isolate auth-cache window and issuing-isolate invalidation remain unchanged.

Login adds one indexed, caller-scoped reconciliation statement and bounded trigger checks over
that caller's tokens (normally at most 16). Stats filters compare canonical aliases within the
existing pool/time window; client groups project distinct recorded labels for the caller/window
before aggregating and limiting results. Audit writes and stored history remain unchanged.
Stats grouping cannot resolve credential ambiguity or establish that two labels were one machine.

## Activating string protection

Apply migration 0016 before deploying the updated Worker. The seeded empty policy
preserves existing behavior, but the new Worker requires the row to exist even when no
rules are configured. Install an updated CLI for local publication protection, then
import a private UTF-8 rules file with `octopool admin string-rewrites set --file <path>`.
See [Admin](admin.md#deployment-wide-string-protection) for the exact file/API contract,
portable regex subset, limits, and revision conflict handling. This is a deployment-wide
setting, not a per-pool override.

Each protected CLI operation downloads a fresh policy; the Worker separately reads the
D1 primary and compiles the policy for each relay request after authentication and
normalization, before classification, repository probes, caches, upstream calls, or
audit metadata. A policy change therefore affects the next request even in a warm
isolate or on a cache hit. An in-flight operation uses the snapshot checked before its
dispatch; changing a policy does not recall an already dispatched request. During a
rolling deployment, old Worker instances and older CLIs retain their old behavior.

This costs a CLI-to-Worker round trip plus a primary D1 read for the policy download,
another primary read for server-relayed traffic, and bounded regex compilation/matching.
Even empty policies require the authoritative read. There is no persistent policy cache,
stale-read window, read-replica shortcut, or offline fallback. Measure latency and CPU
with representative rules and request sizes before broad activation, especially when
callers are far from the D1 primary or approach the 128-rule limit.

For reads the Worker inspects the normalized path and its segments, query keys and all
values, and allowed forwarded header names/values. The JSON envelope is decoded once
with strict UTF-8 and duplicate-key validation. The guard checks literal and once
percent-decoded text, including decoded segment boundaries and query `+` as space.
Residual `%HH` after decoding (such as `%2569`), malformed percent/UTF-8 encoding, and
embedded backslash escape layers are rejected while rules are active. This conservative
boundary may refuse legitimate literal percent/backslash searches; it prevents common
double encoding from revealing an unchecked name downstream. Read inspection is bounded
in aggregate, and the raw relay envelope is capped at 1 MiB. Inputs are never silently
rewritten into different repository or search semantics.

Matching reads return `403 string_rewrite_denied` with no content in the error. Policy
load/corruption/overload returns `503 string_rewrite_policy_unavailable`, not a
`424 fallback_local` instruction. These failures stop before request audit/cache writes
and do not log patterns, matched text, or backend exception messages. API responses,
including errors, are `no-store`. Protect policy GET access and D1 backups: rules can
contain private names even though error responses and normal import output do not.

If policy storage is missing or corrupt, restore the migration/schema and last reviewed
valid singleton row through the operator's controlled D1 recovery process. PUT cannot
repair an unreadable current policy, and a deleted row is not a supported way to clear
rules. For a healthy policy, deliberate deactivation is an authenticated revision-checked
PUT with `rules: []`. Do not remove the guard, suppress load failures, or treat a D1 outage
as an empty policy. No live rollout or credentials are required for the unit and local
Workerd integration tests; the ordinary Worker suite applies migration 0016 explicitly
through the migration runner and exercises the same production checks.

The Worker remains GET-only. Local GitHub writes use the caller's own credentials and
need the updated CLI's supported content preparation. Direct real `gh`, browsers, Git
pushes, old local-write clients, unsupported obfuscation, and other programs are outside
this boundary. Previously published content and existing stored cache/audit records are
not retroactively purged by importing a policy.

## Build, test, deploy

```sh
pnpm install
pnpm check        # format:check + lint + vitest + build + go test + go vet
pnpm test         # vitest only
pnpm test:e2e:cli-worker # compiled CLI → local Workerd/D1/DO → public GitHub
pnpm run deploy                 # authoritative Worker, then public proxy
pnpm run deploy:authoritative   # authoritative Worker only
pnpm run deploy:public-proxy    # octopool.dev proxy Worker only
pnpm e2e                        # smoke-test the live deployment
```

`pnpm check` is the deterministic TypeScript + Go gate. The networked release gate
`pnpm test:e2e:cli-worker` additionally crosses the compiled CLI, local Workerd, migrated
D1, a real Durable Object, and public GitHub. The Go CLI also builds/tests with
`go build ./cmd/octopool` and `go test ./...`.

The hosted deployment runs both commands with `CLOUDFLARE_API_TOKEN` loaded from the
Molty item `OpenClaw Services Cloudflare API Token`; both Worker configs are pinned to the
same Services account. Use the config-qualified `deploy:public-proxy` command when proving
proxy deploy access so Wrangler cannot target the authoritative Worker by accident.
Self-hosters who don't operate the public-host proxy can run `deploy:authoritative` only.
Pushing to `main` does **not** auto-deploy the Workers — only the docs site has a GitHub
Pages workflow. Run `pnpm run deploy` whenever Worker code or landing-page CSS needs to
ship to production.

### Worker integration test isolation

`pnpm test:e2e` runs real Workerd storage with a test-owned lifecycle in
`test/e2e/setup.ts`. Each isolated file applies the actual migrations once in
`beforeAll`, verifies that D1 was pristine, and captures an immutable migrated
baseline. The original 10-second hook deadline, 15-second test deadline and default
file parallelism remain in effect; migration initialization still has to finish
within its hook deadline.

Before each test, D1 restoration discovers the **current** application schema and
foreign-key dependencies, removes views/triggers and child tables before parent
tables, then replays the baseline in one atomic batch. This covers renamed or
dropped tables and unexpected schema objects as well as rows. The ordinary path
uses three D1 requests: schema discovery, batched foreign-key discovery, and the
atomic teardown/replay. SQLite/Cloudflare internals are preserved; the export
restores application AUTOINCREMENT sequences, migration records and the original
string-policy seed timestamp. Unsupported foreign-key cycles (including self
references), virtual tables and SQLite statistics tables fail explicitly before
destructive restoration.

`test/e2e/d1-baseline.ts` isolates a version-specific local runtime contract:
Miniflare `5.20260804.0-alpha` implements
`PRAGMA miniflare_d1_export(?,?,?);`, also used by Wrangler `4.120.1`. The D1 binding
accepts numeric flags `bind(0, 0)` for schema plus data with no table filter. Its
single result row is an array of **complete SQL statements**, which the adapter
validates and submits individually through `D1.batch`. It must never be joined
and fed to newline-splitting `D1.exec`, replaced by `D1.dump`, or used as a
production API. Dependency updates must revalidate this export/replay contract.

Storage cleanup owns the configured `POOL_COORDINATOR`, `ACTIONS_LOGS` and native
Cache API writes. It enumerates persisted coordinator IDs, including dormant
objects, deletes their alarms and storage inside each real object, then evicts
each instance so the constructor recreates SQL and discards memory/timers/waiters.
R2 cleanup lists every page and deletes at most 1,000 keys per call. The Cache API
ledger forwards default/named cache operations to the native implementations,
waits for owned puts, and deletes their recorded keys. It only owns writes made
through that ledger; it cannot purge arbitrary untracked cache entries. Tests
that explicitly provide mock caches retain their own cache semantics.

The harness tracks requests and scheduled calls, draining their execution
contexts even when handlers throw. `callWorker` retains its cold-config-cache
behavior; `callWarmWorker` explicitly preserves a warm isolate. Concurrency tests
register gate releases with `ownedWork` and also release/drain in `finally`.
After each test, gates are released and requests, contexts and cache writes drain
**before** mocks/globals are restored. A failed cleanup or timed-out hook/body
poisons the file lifecycle: subsequent test bodies fail rather than racing the
old promise. The deadline watchdog does not cancel Workerd operations or extend
Vitest's timeouts. Test code must register owned async work and release gates;
arbitrary untracked timers/writes are outside this lifecycle's ownership.

The lifecycle never calls the native global storage `reset()`. The regression uses
the official global `abortAllDurableObjects()` to reproduce a dormant internal D1
actor; natural 11-second idle independently reproduces the same retained-storage
failure in the pinned runtime. `evictAllDurableObjects()` only reaches the current
Worker's explicit Durable Object bindings and does **not** establish D1 dormancy
through its service binding. Per-stub eviction remains appropriate for testing
the coordinator's constructor and storage cleanup.

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
and coalesced-fill marker); parse, authentication, string-protection, and pool-lookup
failures occur before that boundary. Secrets and request bodies are never recorded.

The main Worker has an hourly cron trigger at minute 17. It deletes bounded batches of
cache entries after each entry's route-specific stale deadline and audit rows older than
30 days; this retains every configured stale window and the full supported stats window
without unbounded D1 growth.

`GET /v1/pools/<pool>/stats?since=24h` returns pool-, caller-, and client-specific cache stats,
plus bounded backend-by-route and local-fallback-reason aggregates.
Anonymous API conditional replacements and `304` verifications are attributed to `github_api`
prospectively. Existing misattributed history is not backfilled and expires under normal audit
retention. This correction requires no schema or cache-generation change. During a rolling
upgrade, old Workers may still emit the former attribution and serve cached statistics `202`;
new readers reject pending entries, including late writes, without purging valid ready data.
The CLI wraps this as `octopool stats`. The browser dashboard at `/dashboard` exposes the
same data plus identity health, live leases, seven-day normalized request patterns and
outcome causes, and per-caller/client usage — see
[Dashboard](dashboard.md).
