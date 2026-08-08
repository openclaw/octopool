# Cache & Public-Repo Guard

Octopool owns a shared edge + D1 read-through cache for `gh` reads, and guards every repo
route with a public-visibility check. Both keep private data out of the shared cache and
reduce load on pooled identities.

Source: `src/cache.ts`, `src/cache-policy.ts`, `src/cache-coalesce.ts`,
`src/edge-cache.ts`, `src/public-repos.ts`, `src/pr-state.ts`,
`src/run-list-superset.ts`, `src/terminal-log-cache.ts`, `src/maintenance.ts`, migrations
`0002`/`0003`/`0006`/`0011`/`0013`.

## Read-through edge + D1 cache

On a cacheable route the relay computes a stable cache key, checks Cloudflare's
data-center-local Cache API, falls back to `github_cache_entries` in D1, and serves a
fresh hit without touching GitHub. D1 hits warm the edge cache. On a miss it first tries
a token-free public web/raw endpoint when one can produce the same shape. A successful
direct repository-resource response also proves that the repository is public, avoiding a
separate repository metadata request; routes that need a pooled identity still run the
explicit public-repository guard first. Successful results write through to both layers.

Expired API-origin entries with an `etag` or `last-modified` validator are conditionally
revalidated through the API before the normal token-free/API/pool fill chain. Anonymous REST
entries are distinguished from web/raw/page entries by their stored `x-ratelimit-resource`
header; identity-backed entries are always API-origin. A `304` reruns cache-hit integrity,
then republishes the stored body with TTLs recomputed from that body. Web-origin validators
are never sent across transports.

### Cache key

SHA-256 (base64url) over a stable, sorted JSON of: pool, method, path, normalized
query, the vary headers, the normalized route key, and any validated state discriminator.
Default pagination
(`page=1`, `per_page=30`) and default JSON `accept` variants are folded together; custom
media types and non-default query values still produce distinct entries. The key is
pool-scoped, so pools never share cache entries.

PR file-list routes may include a validated
`route_hint.pr_head_sha` or closed/merged `route_hint.pr_state` discriminator. Clients
that already know the current PR state can use that to avoid mixing entries across head
SHAs while letting Octopool keep `files` warm longer. Hints are first checked against
GitHub and then cached briefly in `github_pr_state_proofs`, so repeated cache hits do not
need to re-contact GitHub just to validate the hint.

### What is cached

Only successful `2xx` responses on cacheable routes are stored. The edge + D1 cache is
**bypassed** when:

- the route is a large-payload route or `rate_limit` (completed Actions logs use the
  dedicated R2 cache described below), or
- the request carries a conditional header (`if-none-match` / `if-modified-since`).

Cacheable requests can instead bound acceptable staleness with a
`cache-control: max-age=N` header. A fresh entry older than `N` seconds is treated as a
miss and refetched, and the refill writes through to the shared cache, so concurrent
bounded-freshness readers coalesce onto one upstream request rather than each bypassing
the cache. The CLI's `gh pr checks` resolves the PR head SHA this way with `max-age=60`.

### Token-free GitHub reads

Whenever a validated parser exists, Octopool prefers public page/raw and Git smart HTTP
endpoints before the anonymous GitHub API. A parser miss falls back to the anonymous API in
the same request cycle, then to a pooled identity where the route permits one. Successful
direct repository-resource responses are themselves a public visibility proof; ambiguous
search responses still require an explicit repository guard. Token-free-only shaped repo
search uses the public repository page marker for that proof, avoiding both pooled identities
and the configured verification token. The canonical route-by-route inventory is
[Token-Free GitHub Endpoints](token-free.md).

The main transport classes are:

- PR diff/patch media requests (`gh pr diff`, or `GET /pulls/{number}` with a diff or
  patch `Accept` header) via `github.com/{owner}/{repo}/pull/{number}.diff|patch`
- commit diff/patch media requests via `github.com/{owner}/{repo}/commit/{sha}.diff|patch`
- compare diff/patch media requests via `github.com/{owner}/{repo}/compare/{base...head}.diff|patch`
- supported top-level `gh run list/view` summaries (up to 25 results, with branch/status or
  workflow filters) and bounded `gh run view --json jobs` job/step metadata prefer public
  GitHub pages; raw API requests retain exact REST semantics, and log bodies remain
  authenticated
- exact public GitHub API reads without caller credentials for repo metadata, commits,
  compare JSON, contents, README, PRs, issues, checks/statuses, Actions run/workflow
  metadata, branches, tags, labels, milestones, topics, community profiles, forks,
  stargazers, subscribers, deployments, Git object reads, languages, contributors, licenses,
  release assets, GitHub metadata/license/gitignore APIs, org repository lists, org public
  events and members, user/gist reads, user follower/following/event/key lists,
  reactions, assignees, repo-wide issue/PR comments and events, commit pull/check-suite/
  branch/status metadata, network events, repository stats, repository search, and
  repo-scoped issue/commit search
- explicit-ref contents reads prefer `raw.githubusercontent.com`, returned as an API-shaped
  JSON file payload
- branch refs, matching branch prefixes, and annotated-tag refs can use Git smart HTTP
  advertisements with exact REST-compatible IDs and object metadata; ambiguous lightweight
  tags fall back to the API
- supported top-level `gh pr view` summaries and `gh workflow view` metadata can use bounded
  public GitHub page data before the anonymous API
- release list/latest/tag/id/asset reads via unauthenticated `api.github.com` requests so pooled
  credentials never expose draft releases; supported top-level `gh release view` summaries
  prefer public release HTML, while raw API requests retain exact REST semantics

Anonymous API rate snapshots are recorded by GitHub resource from API responses.
When a public-page/raw/Git parser cannot satisfy a request, Octopool falls back to the
anonymous API in the same request cycle.

Successful web reads are cached in the same D1 table with no source identity. A cached
web hit still re-checks that public proof covers the entry before returning it.

### TTLs

Per route kind and response state (`cacheTTLSeconds`):

- base workflow runs and base job lists → 60s even when terminal, because reruns reuse the run ID;
  completed attempt-qualified run/job lists get 1h fresh plus up to 24h bounded stale fallback
- checks, check suites, and commit statuses → 60s while active; terminal payloads get 1h fresh
  plus up to 24h bounded stale fallback
- run/workflow lists → 60s while active, 2m when every returned run is completed; lists
  remain mutable because new runs can appear
- PR files with a validated state discriminator → 5m; PR commits, reviews,
  comments, issue comments/events/timeline, and undiscriminated PR files → 1m..5m
- supported repository-scoped `gh search issues|prs` shim calls use anonymous API before
  any allowed search-bucket identity
- closed PRs/issues → 1h; open PRs → 2m; open issues → 5m
- release lists/latest → 5m; release by tag/id → 1h
- immutable commit objects → 24h; commit lists → 5m; contents → 1h
- repo metadata → 10m; workflow metadata → 1h
- active/unknown-run logs, `rate_limit`, and conditional requests still bypass

## Completed Actions log cache

`job_logs` requests fetch the job endpoint without using edge or D1 metadata cache and
require that fresh job payload's own `status` to be `completed`. A cached completed run can
therefore never make an active job from a re-run terminal. Whole-run log routes likewise
require a fresh uncached run payload whose current status is `completed`, plus a positive
`run_attempt`; the attempt becomes part of the R2 key so a completed re-run cannot receive
an earlier attempt's archive. Active, unknown, attempt-less, or failed metadata probes keep
the previous large-payload bypass behavior. Only a successful 2xx anonymous metadata
response records a public-repository proof. A proven-terminal log uses the dedicated
`ACTIONS_LOGS` R2 bucket, keyed by pool, exact route path, and whole-run attempt when
applicable, so immutable log downloads are shared without putting their large payloads in D1.

R2 stores the raw log bytes, content type, original body encoding, and a retention timestamp.
After the fresh terminal-status proof, an object younger than one hour can be served without
contacting the log endpoint. Older objects also make an authenticated log request without
following its redirect: a validated `302 Location` confirms existence and refreshes the
retention timestamp, while `404` purges the object and returns GitHub's deletion response.
Thus a deletion can remain cached for at most the bounded one-hour no-log-probe window, not
the full retention period.

Objects untouched and unconfirmed for seven days expire. Reads enforce that lifetime from
object metadata: expired objects are treated as misses and removed, so lifecycle cleanup
timing can never cause stale data to be served. R2 read, write, or probe failures never fail
a relay request: Octopool uses the existing authenticated redirect-validation path instead.

Operator provisioning is a one-time bucket plus lifecycle setup. The required lifecycle
rule is: enabled for prefix `github-actions-logs/v1/`, delete objects seven days after
creation. Apply it with Wrangler (or configure the identical rule in the R2 dashboard):

```sh
wrangler r2 bucket create octopool-actions-logs
wrangler r2 bucket lifecycle add octopool-actions-logs octopool-actions-logs-expire github-actions-logs/v1/ --expire-days 7
```

The operator owns this rule; worker code does not scan R2 or manage bucket lifecycle.

As with edge + D1 hits, Octopool runs the public-repository guard before returning an R2
log hit. Successful hits are audited as cacheable `hit` events and count as saved GitHub
requests; active-run log fetches remain non-cacheable `bypass` events.
Requests carrying `If-None-Match` or `If-Modified-Since` skip the completion lookup and
all R2 reads and writes, preserving the normal conditional-request bypass path.

## Actions run-list superset

Repo- and workflow-level run-list requests carrying
`x-octopool-public-shape: actions-summary-v1` can share one canonical cache entry per pool
and exact route path. Common requests for at most 25 runs use an unfiltered
`page=1&per_page=25` entry, which the validated public Actions page can fill without GitHub
API quota. Larger repo-level requests retain the `page=1&per_page=100` API superset;
larger workflow-level requests stay exact. Every entry uses the existing state-aware
run-list TTL policy. Fresh variants filter the cached runs by exact `head_branch`, or by a
`status` value matching either the GitHub run `status` or terminal `conclusion`, then apply
`per_page` and `limit` truncation locally.

The derived response's `total_count` is the number of matching runs found in the cached
canonical page before truncation. Shim consumers ignore totals beyond the returned page; this
is deliberately not a claim about older GitHub pages. If local filtering returns fewer than
the requested limit while GitHub's canonical `total_count` proves that older runs were not
captured, Octopool falls back to the exact upstream filtered request. Page values above 1,
page sizes above 100, workflow-scoped page sizes above 25, unknown query parameters,
unsupported GitHub status values, and requests without the shim shape keep exact upstream
and per-query cache behavior. Conditional shim requests bypass the canonical cache but still translate the
shim-only `limit` into a capped upstream `per_page` and shape successful responses locally.
All other exact shaped requests, including workflow-scoped paths, use the same translation
and never forward `limit` to GitHub. Locally shaped responses omit `ETag`, `Last-Modified`,
`Content-Length`, and `Link` because those validators, lengths, and pagination links describe
the upstream representation, not the transformed body.

## Actions attempt job-list superset

Shaped `gh run view` and `gh run watch` reads resolve the run's current positive
`run_attempt`, then request `/actions/runs/{id}/attempts/{attempt}/jobs`. That attempt-qualified
path is immutable after all returned jobs complete, while the base run and base jobs endpoints
remain short-lived because a rerun can change both after they previously appeared terminal.
Before granting the one-hour job-list TTL, Octopool separately verifies that exact attempt's
run endpoint is completed; a list of currently completed jobs alone is not treated as proof.

Equivalent shaped `page=1`, omitted/`latest` filter, and `per_page` values up to 100 share one
100-job attempt-qualified cache entry. Octopool truncates that complete superset locally and
removes upstream representation validators, lengths, and pagination links. If `total_count`
exceeds the returned jobs—or is missing or invalid—the shaped request fails over to real `gh`
without publishing or returning the partial page. `filter=all`, later pages, unshaped REST
requests, active attempt data, and unsupported query variants retain exact semantics.

## Cache-hit integrity

A fresh or bounded-stale hit is only served if:

- the source identity recorded on the entry is still an active candidate for the route
  (web-origin entries have no identity), and
- the repo's unexpired public-visibility proof still covers the entry (re-checked during
  GitHub outages / secondary-rate-limit — see below).

If the eligible token-free and pooled backends are unavailable, depleted, cooling down,
or rate-limited, Octopool may serve an expired public cache entry for a short route-specific
grace window. Mutable CI
payloads get only minutes; terminal CI payloads get up to a day; PR/issue detail routes
get up to an hour; immutable-ish commit views can get up to a day. Stale serves still run
the public-repo guard and active-identity check before returning.

Cache publication is awaited before returning a miss response, closing the response/write
race for immediate repeat reads. Concurrent identical misses also claim a short pool-scoped
fill lease in the Durable Object; followers wait for the leader's publication and serve
the resulting hit instead of duplicating the GitHub request. Public-repository proof
refreshes use the same coordinator pattern, so simultaneous expired-proof checks share one
GitHub request. Audit writes remain deferred.
An hourly scheduled task deletes cache entries after each entry's route-specific
`stale_expires_at` deadline in bounded batches, preserving every configured stale-serving
window while keeping D1 growth bounded. R2 expiry is handled by the operator-configured
bucket lifecycle rule described above.

Hits are still audited, with the cached identity attributed. Each audit row records cache
status as `hit`, `stale`, `miss`, `bypass`, or `unknown`, which powers `octopool stats` and
the dashboard hit-rate/top-route views. Coalesced followers are marked separately. Stats
count both fresh and stale hits as saved GitHub requests and expose an eligible hit rate
that excludes failed misses and deliberate local fallback responses.
Successful `304` refreshes use the existing `hit` status so current stats and CLI parsers count
the saved request, with `fallback_reason = cache_revalidated` as the distinct audit marker.

## Public-repo guard

The shared cache and pooled identities are **public-repository only**. Before any repo
route uses a pooled identity or a cache entry, `ensurePublicGitHubRepo` confirms the repo
is public.

- An unauthenticated `GET /repos/{owner}/{repo}` is made against GitHub.
- If `OCTOPOOL_GITHUB_ORG_TOKEN` is configured, that server-side token is used for the
  check to avoid shared unauthenticated GitHub quota; Octopool still requires the
  response body to say `private: false`.
- `404` or `private !== false` → `403 repo_not_public`.
- If both authenticated and anonymous API checks are rate-limited or unavailable, Octopool
  can prove visibility from GitHub's public repository page marker without an API token.
- A successful anonymous request for a direct repository resource is also accepted as the
  live public proof, so a cache miss does not need a second GitHub metadata request. Search
  responses still run an explicit visibility check because an empty result does not prove
  that a `repo:` qualifier names a public repository; token-free-only shaped search uses
  the public repository page marker directly.
- A successful public check is recorded in `github_public_repos` with a TTL
  (`PUBLIC_REPO_TTL_SECONDS`, default 30s) and the edge cache; subsequent cache hits reuse
  the fresh proof instead of re-hitting GitHub.

### Historical proof during outages

If the live public check fails with a `5xx`, or a `403` with `x-ratelimit-remaining: 0`
(secondary rate limit), the guard may fall back to a previously recorded proof that was
captured close to the cache entry's creation time (within 5s) and has not expired. There is
no post-expiry grace window: a proof whose expiry equals or precedes the current time is
rejected immediately with `repo_public_check_failed`. This lets cached public data keep
serving through transient GitHub failures without ever relaxing the private-repo block — a
hard `404`/private response always denies.

## Schema

- `github_cache_entries` — cache key, pool, method, path, query/headers JSON, route
  key/kind, status, response headers JSON, body JSON, body encoding, source identity,
  created/fresh/stale expiration timestamps (migrations `0002` and `0011`).
- `github_public_repos` — `owner`, `repo`, `checked_at`, `expires_at` (migration `0003`).
- `github_pr_state_proofs` — short-lived validated PR head/state discriminators for
  state-scoped PR subresource cache keys (migration `0006`).
- `audit_events.cache_status` / `audit_events.cacheable` — per-request cache metrics
  (migration `0005`).
- `audit_events.fallback_reason` / `audit_events.coalesced` — local fallback classification
  and duplicate-fill telemetry (migration `0009`).
- `audit_events.backend` — bounded upstream classification (`github_web`,
  `github_api`, or `github_identity`) for route-level stats (migration `0013`).
- `ACTIONS_LOGS` R2 binding (`octopool-actions-logs`) — raw terminal Actions log objects;
  no D1 migration is required.

Secret values are never written to either cache.
