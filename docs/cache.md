# Cache & Public-Repo Guard

Octopool owns a shared edge + D1 read-through cache for `gh` reads, and guards every repo
route with a public-visibility check. Both keep private data out of the shared cache and
reduce load on pooled identities.

Source: `src/cache.ts`, `src/cache-policy.ts`, `src/cache-coalesce.ts`,
`src/edge-cache.ts`, `src/public-repos.ts`, `src/pr-state.ts`,
`src/run-list-superset.ts`, `src/terminal-log-cache.ts`, `src/maintenance.ts`, migrations
`0002`/`0003`/`0006`/`0011`/`0013`/`0020`.

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
query, the vary headers, the normalized route key, any validated state discriminator, and
the server-owned publication protocol epoch (`publication-v1`). Every body key, including
raw REST, identity, canonical, stale, and conditional-revalidation candidates, changes
with this epoch. Readers never fall back to a previous epoch.
Default pagination
(`page=1`, `per_page=30`) and default JSON `accept` variants are folded together; custom
media types and non-default query values still produce distinct entries. The key is
pool-scoped, so pools never share cache entries.

Actions summaries also include a server-controlled representation generation
(`actions-summary-owned-v2`) in this common key. Run views, attempt-qualified views,
and repository/workflow run lists, including canonical supersets and identity-specific
entries, cannot reuse summaries cached before the ownership fix. Existing
`actions-summary-v1` clients keep the same wire format but miss those old entries in
edge, D1, stale fallback, fill coalescing, and conditional revalidation. Raw REST and
unrelated shapes have no Actions representation discriminator; the common publication
epoch still applies. No cache purge is needed.

Release views and latest-release reads with `release-summary-v1` similarly include
`release-summary-raw-v2`. Existing clients cannot reuse the old HTML-derived bodies
from edge, D1, stale fallback, fill coalescing, or conditional revalidation. Only shaped releases carry this representation discriminator; raw REST entries still
carry the common publication epoch. The generation applies
to metadata-only projections too, since they share the same response body.

Issue timelines and the three issue-event list/view routes include `issue-events-public-v2`
for every representation, including raw REST and identity-specific keys. Older pooled bodies
may retain private cross-reference details, even after anonymous revalidation removed their
identity attribution. All old keys are retired across edge, D1, stale fallback, fill coalescing,
and revalidation. Only anonymous responses populate the new generation. Caller conditionals
bypass storage and use the anonymous API; a `304` never revives an old server-cached body.
Repository/network activity feeds and unrelated routes do not carry the issue-event
discriminator; they still carry the common publication epoch.

PR file-list routes may include a validated
`route_hint.pr_head_sha` or closed/merged `route_hint.pr_state` discriminator. Clients
that already know the current PR state can use that to avoid mixing entries across head
SHAs while letting Octopool keep `files` warm longer. Hints are first checked against
GitHub and then cached briefly in `github_pr_state_proofs`, so repeated cache hits do not
need to re-contact GitHub just to validate the hint.
The `gh pr view --json files` shim resolves the head with `max-age=0`, sends a dedicated
`pr-files-v1` shape plus the verified head on every bounded page, and resolves the head
again after all hydration. If the head moved, the entire command falls back to real `gh`
instead of returning pages that may span revisions. Missing heads and lists beyond the
bounded pagination window also fall back.

### What is cached

Only successful `2xx` responses on cacheable routes are stored. The edge + D1 cache is
**bypassed** when:

- the route is a large-payload route or `rate_limit` (completed Actions logs use the
  dedicated R2 cache described below), or
- the request carries a conditional header (`if-none-match` / `if-modified-since`).

Bodies whose serialized JSON exceeds 256 KiB (paged run lists, check-run sweeps) are
stored only in the data-center-local edge cache, not in D1: megabyte-class row writes
were the dominant cause of `D1 DB is overloaded` queueing under paged bursts. Oversized
entries lose cross-colo sharing and D1 stale fallback but keep the hot same-client
repoll pattern warm. A same-colo follower serves the confirmed edge publication directly;
a follower in a cold colo reacquires coordinator ownership and performs one serialized
takeover fill. This can produce one fill per cold colo, but never overlapping ownerless
upstream requests.

Cacheable requests can bound cache age with a `cache-control: max-age=N` header.
The bound applies to both fresh hits and outage stale fallback: an older entry cannot
be served without successful upstream revalidation. `max-age=0` always requires an
upstream fetch or conditional revalidation, including when a cached timestamp equals
the current time. Old entries remain eligible for conditional requests; a successful
`304` confirms and republishes the stored body. Successful refills write through to
the shared cache. Positive bounds let concurrent readers share an acceptable refill;
zero-bound readers each require upstream validation. The CLI's `gh pr checks` resolves
the PR head SHA with `max-age=60`.

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
  credentials never expose draft releases; top-level `gh release view` also uses exact API
  data, preserving raw Markdown strings through fills, cache reads, and revalidation
- issue timeline and issue-event list/view reads via the anonymous API, so cross-repository
  issue and commit references retain public visibility; outages can use only the new cache
  generation with the existing age, retention, and repository-proof checks

Release bodies are never reconstructed from rendered HTML or replaced with changelog
text. Whitespace, line endings, and Markdown syntax remain exactly as returned by the
API. This costs anonymous API quota on release cache misses, including metadata-only
views. If the API is unavailable, eligible exact stale data or the existing guarded
local-`gh` fallback applies; pooled identities remain excluded.

Anonymous API rate snapshots are recorded by GitHub resource from API responses.
When a public-page/raw/Git parser cannot satisfy a request, Octopool falls back to the
anonymous API in the same request cycle.

Actions run pages must identify the requested repository and run in both the summary
region and embedded job navigation, with a matching attempt when requested. The head
SHA must come from a commit link inside that run's summary; document titles and links
elsewhere cannot supply it. List cards end at their own closing element, so a following
card or region cannot lend its SHA. Missing or conflicting ownership falls back to exact
anonymous REST, then the existing pool path. In particular, title-only pages use REST's
historical top-level `head_sha`, never the mutable `pull_requests[].head.sha`.

These ownership regions use parse5's HTML DOM and source locations, not markup
stripping or regular-expression boundaries. Scripts, comments, styles, templates,
raw-text elements, and foreign content cannot supply commit links. Embedded job
navigation is read only as JSON from its unique script element. HTML element and
attribute names follow browser case rules, and entities are decoded only by the
HTML parser. Parse errors, inferred or overlapping ownership boundaries, unusual
element names, and duplicate identity evidence fall back to REST. Only bare
fragments with an implicit document scaffold may omit the doctype; full documents
must declare it. This conservative policy can increase API fallback for malformed
or changed GitHub markup.

An abbreviated summary commit link can still expand without API quota, but only from
a single well-formed patch with a full 40-character SHA matching that abbreviation.
Merge patch series, mismatched headers, and ambiguous or incomplete patches fall back
to REST. This deliberately uses more API reads for pages that cannot prove ownership.

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
- merged PRs and closed issues → 1h; open or closed-unmerged PRs → 2m; open issues → 5m
- release lists/latest → 5m; release by tag/id → 1h
- immutable commit objects → 24h; commit lists → 5m; contents → 1h
- repo metadata → 10m; workflow metadata → 1h
- active/unknown-run logs, `rate_limit`, and conditional requests still bypass

REST issue state `closed` and page-derived `CLOSED` both receive the one-hour TTL;
classification preserves cached bodies and raw response states.

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
the requested limit, Octopool falls back to the exact upstream filtered request because a
bounded public page cannot prove that older matching runs do not exist. Page values above 1,
page sizes above 100, workflow-scoped page sizes above 25, unknown query parameters,
unsupported GitHub status values, and requests without the shim shape keep exact upstream
and per-query cache behavior. Conditional shim requests bypass the canonical cache but still translate the
shim-only `limit` into a capped upstream `per_page` and shape successful responses locally.
All other exact shaped requests, including workflow-scoped paths, use the same translation
and never forward `limit` to GitHub. Locally shaped responses omit `ETag`, `Last-Modified`,
`Content-Length`, and `Link` because those validators, lengths, and pagination links describe
the upstream representation, not the transformed body.
Public Actions pages must also expose at least `min(total_count, per_page)` parseable cards;
otherwise Octopool discards the page and falls back to exact anonymous API JSON.
Branch/status-filtered public pages are never treated as exact: GitHub can report only the
visible matching card count while older API matches still exist. Underfilled canonical filters
therefore go directly to the exact anonymous API/pool fallback chain.

## Actions attempt job-list superset

Shaped `gh run view` and `gh run watch` reads resolve the run's current positive
`run_attempt`, then request `/actions/runs/{id}/attempts/{attempt}/jobs`. That attempt-qualified
path is immutable after all returned jobs complete, while the base run and base jobs endpoints
remain short-lived because a rerun can change both after they previously appeared terminal.
Before granting the one-hour job-list TTL, Octopool separately verifies that exact attempt's
run endpoint is completed; a list of currently completed jobs alone is not treated as proof.

Equivalent shaped `page=1`, omitted/`latest` filter, and `per_page` values up to 100 share one
attempt-qualified cache entry, filled from at most three 100-job API pages. Octopool slices
that complete superset locally and removes upstream representation validators, lengths,
and pagination links. All pages must have consistent valid `total_count` metadata and the
merged list must match that count. A remaining `Link: rel="next"` also prevents completion,
even when the count matches; the first page's link is removed only after a complete merge.

If a partial rerun exposes count metadata that disagrees with the returned job set, a count
disagreement alone does not establish another page or prove which successful jobs were
reused. Octopool rejects that ambiguous shaped response with `pagination_exhausted`, without
caching it, inventing jobs, or treating a short page as a complete summary. Supported
`gh run watch` stops with an explicit error on that refusal and never starts real `gh`;
ordinary run-view fallback remains available. `filter=all`, later pages, unshaped REST
requests, and unsupported query variants retain exact upstream semantics.

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
get up to an hour; immutable-ish commit views can get up to a day. Requests without an
age bound retain this outage fallback; an explicit bound must also be satisfied.
Otherwise the existing typed failure/local-fallback flow applies. Stale serves still
run the public-repo guard and active-identity check before returning.

Cache publication is awaited before returning a miss response. D1 grants renewable
publication authority: `(protocol epoch, resource key, global AUTOINCREMENT ID, random token)`.
The capability comes only from a successfully committed `RETURNING` result. D1's execution
clock sets/checks the eight-second lease; owners renew every three seconds, never shorten
a later persisted deadline, and retain the final renewal before publication. Neither a DO waiter map nor a pre-write
renewal grants permission to publish: the **actual INSERT/UPDATE** requires the exact live
D1 owner and the original unexpired evidence deadline. Both absent-row insertion and
replacement are guarded. IDs remain unique after completion/GC because `sqlite_sequence`
is retained. No payload has an owner foreign key or deletion cascade.

Pool DOs notify/coalesce body waiters; one reserved global proof DO coordinates normalized
repository names across pools and both verdicts. A nonblocking attempt precedes each of the
three existing anonymous observations. Busy/unknown acquisition still fetches normally but
never persists that observation opportunistically. The scope releases before explicit proof
guards, body-key switches, finalization, or canonical/exact continuation. Body ownership may
precede proof ownership; proof ownership never waits for a body owner. Anonymous `304`
revalidates a body, never repository visibility.

Body fetch/304 validation time is captured with the initial response, before awaited proof
publication, explicit guards or first-page aggregation. Internal response/time metadata
keeps that evidence and its original expiry through SQL acknowledgment without adding fields
to the relay payload or stored user body.

Storage (`shared`, `edge_only`, `failed`, `rejected`, `unknown`) and completion acknowledgment
(`accepted`, `lost`, `unknown`) are distinct internal results. A zero-row write is rejected
unless an exact immutable already-committed receipt recovers a replay/lost acknowledgment.
A stored denial completes successfully before returning `repo_not_public`. Shared proof
completions identify the actual published or reused proof, not the notifier's newer ownership
ID. Ownership-only completion does not fabricate a publication receipt. Shared waiters
reread authoritative D1; a waiting proof follower cannot use an older positive edge entry to
supersede the completed denial. Missing results and expired owners return to acquisition
before upstream work. Failure to obtain D1 authority cannot create a local/shared owner.
Every lost/unknown completion rereads authoritative proof before authorizing from a probe,
including when storage history is unknown. Only a receipt from the same or a newer owner can
supersede that observation; an older positive proof cannot override a newly observed denial.
That request-local evidence floor survives retries, other owners' reuse notifications, and
historical-proof fallback without adding persistent state or a hot-hit lookup.
Revocation can clean an expired exact owner,
but that cleanup is not an accepted live completion. Persistence failure alone can still
permit the direct request when its exact owner completes live and the observed evidence
has not expired; it does not mint a shared proof.
Receipts and capability tokens stay internal, outside relay envelopes and health snapshots.

D1 acceptance precedes the edge put for D1-sized bodies and proofs. Oversized bodies still
store only at the edge, but require a small guarded D1 authorization statement. Each edge
entry embeds an immutable absolute expiry and protocol epoch; D1 warming preserves that
expiry. Edge storage has **bounded freshness, not CAS or linearizable latest-value semantics**:
a delayed accepted put can replace a newer edge entry until its original expiry. It does not
extend that expiry, and failed/stale publication never deletes a replacement edge entry.
Independent hot body-plus-covering-proof hits add no publication D1/DO calls. Existing
identity eligibility/auth-cache reads and audit writes retain their own contracts.

Completed owners are deleted immediately. Every durable acquisition attempt batches an
indexed atomic deletion of at most 16 expired owner rows with acquisition: one D1 binding
operation, two SQL statements, including on contention. The same-statement busy prefilter
avoids allocator advancement for a known-live owner. Each attempt can abandon at most one
new owner; once expired, traffic can remove up to sixteen. This bounds per-attempt work,
not absolute storage during an arbitrary burst or outage. Idle backlog has a separate
hourly fallback of at most 20 × 500 owner deletions. Payload and expired-proof pruning have
independent 20 × 500 budgets and never reset the sequence or delete live ownership.

Native local D1 measurements for a short body fill, including the final renewal, were
four binding operations / five SQL statements and 13 rows read / 11 written (empty owner
backlog). A 16-row owner GC read 80 rows and wrote 16 using the expiry index. Three attempts
removed an expired backlog of 33 as 17 → 1 → 0. Proof warming measured four binding operations / five statements and 14 rows read /
10 written in the same fixture, including acquisition, final renewal, proof write and completion; long observations add one renewal statement
per active owner every three seconds. A 3.2-second renewable body fill measured five binding operations / six statements,
15 rows read / 13 written, including its periodic and final renewals. These are local
runtime counters and logical calls, not hosted D1 billing or a throughput claim. See [operations](operations.md#cache-publication-upgrade-and-restore)
for rollout, restore, and backlog monitoring requirements.

Hits are still audited, with the cached identity attributed. Each audit row records cache
status as `hit`, `stale`, `miss`, `bypass`, or `unknown`, which powers `octopool stats` and
the dashboard hit-rate/top-route views. Coalesced followers are marked separately. Stats
count both fresh and stale hits as saved GitHub requests and expose an eligible hit rate
that excludes failed misses and deliberate local fallback responses.
Successful `304` refreshes use the existing `hit` status so current stats and CLI parsers count
the saved request, with `fallback_reason = cache_revalidated` as the distinct audit marker.

Identity availability feedback is separate from cache-source eligibility. Overlapping
identity responses merge quota and cooldown observations conservatively in the pool
coordinator, including conditional requests that bypass cache storage. A delayed success
cannot reopen a known exhausted window or shorten a live cooldown. Fresh cache reuse
still checks active route eligibility and public proof; see [identity feedback](identities.md#health-feedback-cooldowns).

## Public-repo guard

The shared cache and pooled identities are **public-repository only**. Before any repo
route uses a pooled identity or a cache entry, `ensurePublicGitHubRepo` confirms the repo
is public.

- An unauthenticated `GET /repos/{owner}/{repo}` is made against GitHub.
- If `OCTOPOOL_GITHUB_ORG_TOKEN` is configured, that server-side token is used for the
  check to avoid shared unauthenticated GitHub quota; Octopool still requires the
  response body to say `private: false`.
- `404` or `private !== false` → `403 repo_not_public`.
- Definitive non-public results are cached separately for
  `PUBLIC_REPO_NEGATIVE_TTL_SECONDS` (default 3600s), avoiding repeated GitHub checks
  while never authorizing cached repository content. Rate limits, upstream failures,
  and inconclusive page checks are not cached as negative proofs.
- If both authenticated and anonymous API checks are rate-limited or unavailable, Octopool
  can prove visibility from GitHub's public repository page marker without an API token.
- A successful anonymous request for a direct repository resource is also accepted as the
  live public proof, so a cache miss does not need a second GitHub metadata request. Search
  responses still run an explicit visibility check because an empty result does not prove
  that a `repo:` qualifier names a public repository; token-free-only shaped search uses
  the public repository page marker directly.
- A successful public check is recorded in `github_public_repo_proofs` with a TTL
  (`PUBLIC_REPO_TTL_SECONDS`, default 30s; the hosted deployment sets 900s) and the edge
  cache; subsequent cache hits reuse the fresh proof instead of re-hitting GitHub. A
  proof refresh stalls concurrent requests for that repo behind one probe, so a short
  TTL puts a periodic GitHub round trip on the cache-hit path — the trade against it is
  how long a repo that flips private can keep serving already-cached content.

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
  created/fresh/stale expiration timestamps and internal publication receipt (migrations `0002`, `0011`, `0020`).
- `cache_publication_owners` — live/abandoned capabilities, global AUTOINCREMENT fence, unique epoch/resource, indexed D1-clock expiry (`0020`); retain its `sqlite_sequence`.
- `github_public_repo_proofs` — epoch-isolated positive/negative evidence, immutable timestamps and internal publication receipt (`0020`). Legacy `github_public_repos` is ignored by new readers.
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

Upstream credentials are never written to either cache. Internal publication capability
tokens are stored only in ownership/receipt metadata; they are not public response fields.
