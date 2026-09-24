# Cache & Public-Repo Guard

Octopool owns a shared edge + D1 read-through cache for `gh` reads, and guards every repo
route with a public-visibility check. Both keep private data out of the shared cache and
reduce load on pooled identities.

Source: `src/cache.ts`, `src/cache-policy.ts`, `src/cache-coalesce.ts`,
`src/edge-cache.ts`, `src/public-repos.ts`, `src/pr-state.ts`,
`src/run-list-superset.ts`, `src/terminal-log-cache.ts`, `src/maintenance.ts`, migrations
`0002`/`0003`/`0006`/`0011`/`0013`/`0020`.

## Configuration lookups

Caller authentication and membership results, pool policies, and identity lists share a
bounded, 256-entry isolate cache of settled values. Entries expire 30 seconds after their
load starts; a slow load never extends that deadline. Revoked caller tokens, retired
identities, and pool policy edits may therefore take up to 30 seconds to reach a warm
isolate. Authoritative identity rechecks use fresh D1 reads and bypass both settled and
pending lookups. String-rewrite policy itself always reads the D1 primary and is not
stored in this cache; its caller authentication still uses the configuration cache.

Identical concurrent loads coalesce only within one Worker request, using an asynchronous
context created at the fetch boundary. Different requests load cold entries independently
and reuse successful values once available. No request waits on another request's pending
promise: that request may finish or be canceled before its load settles. Failed loads are
not cached, and clearing or invalidating a value prevents older pending loads from
repopulating it. This keeps the hot-cache D1 savings without coupling request lifetimes.

## Read-through edge + D1 cache

On a cacheable route the relay computes a stable cache key, checks Cloudflare's
data-center-local Cache API, falls back to `github_cache_entries` in D1, and serves a
fresh hit without touching GitHub. D1 hits warm the edge cache. On a miss it first tries
a token-free public web/raw endpoint when one can produce the same shape. A successful
direct repository-resource response also proves that the repository is public, avoiding a
separate repository metadata request; routes that need a pooled identity still run the
explicit public-repository guard first. Successful results write through to both layers.

Fresh identity-specific entries are checked before conditional revalidation and
token-free resource fetches. Reuse still verifies the identity's current pool/scope
eligibility, public visibility, and the caller's maximum age; a missing credential or
quota cooldown does not invalidate an otherwise eligible cached body. This prevents a
warm pooled response from needlessly hitting GitHub again just because the shared
anonymous key is empty.

### Public PR landing snapshots

The fixed `pr-ci-summary-v1`, `pr-ci-rollup-v1`, `pr-merge-snapshot-v1`,
`pr-comments-v1`, and `pr-commits-v1` projections use pooled GraphQL reads after the normal public-repository guard.
The shape and detail cursor vary the existing cache key; a raw REST PR response,
a different projection, and another cursor can never satisfy the request.
The merge snapshot includes `headRefName` so a landing can bind the observed source
branch to its acquired source facts. Its cache representation includes the exact canonical
GraphQL document in the existing hashed key. Older projections lacking that field cannot
be reused from edge, D1, identity caches, or concurrent fills. Future changes to that
document retire its prior representation automatically; unchanged CI and raw REST keys
stay warm. No schema, publication-epoch change, or cache purge is required.

Snapshots stay fresh for at most 60 seconds, including completed CI and merged PRs.
They have no stale fallback: a previous merge snapshot cannot authorize a later landing.
The CLI's recognized landing queries request a live read by default; callers must
explicitly opt into a positive maximum age to reuse a snapshot for advisory work.

`cache-control: max-age=0` performs one fresh pooled GraphQL query for that
projection and writes its result through the normal cache. It does not disable caching
for subsequent requests or bypass the pool. Repository visibility verification remains
an independent requirement and can issue a separate guarded metadata read. GraphQL
POSTs never use REST/page substitutes or conditional response validators. HTTP-200
GraphQL errors and null repository/PR results are returned without caching; quota
headers update the identity's GraphQL budget, independently of REST's core budget.

Expired API-origin entries with an `etag` or `last-modified` validator are conditionally
revalidated through the API before the normal API/pool fill chain; available no-quota page
transports run first, with conditional API revalidation retained when the page fails. Anonymous REST
entries are distinguished from web/raw/page entries by their stored `x-ratelimit-resource`
header; identity-backed entries are always API-origin. A `304` reruns cache-hit integrity,
then republishes the stored body with TTLs recomputed from that body. Web-origin validators
are never sent across transports. Successful GitHub REST `304` validations consume primary
rate-limit quota, for both anonymous and authenticated requests; they save body bytes, not quota.

If token-free API revalidation reports a rate limit (`429`, exhausted `403`, or a valid
`Retry-After` classified by the existing fallback policy), that request skips a second
anonymous API attempt in its normal web fallback. Public HTML alternatives remain available,
and pooled reads still require the live public-repository guard and identity selection.
The observation lasts only for the current relay request; later requests try the anonymous
API normally. Persisted anonymous rate snapshots remain advisory. Ordinary permission
refusals, transport/server failures without rate-limit evidence, and policy denials keep
their existing handling.

### Cache key

SHA-256 (base64url) over a stable, sorted JSON of: pool, method, path, normalized
query, the vary headers, the normalized route key, any validated state discriminator, and
the server-owned publication protocol epoch (`publication-v1`). Every body key, including
raw REST, identity, canonical, stale, and conditional-revalidation candidates, changes
with this epoch. Readers never fall back to a previous epoch.
Default pagination
(`page=1`, `per_page=30`), default JSON `accept` variants, and an explicit
`x-github-api-version: 2022-11-28` (the transport default) are folded together; custom
media types, non-default API versions and non-default query values still produce distinct entries. The key is
pool-scoped, so pools never share cache entries.

For raw REST reads, omitted `filter` and explicit `filter=latest` also share an entry
for commit check-run lists and the base workflow-run jobs endpoint. GitHub defines `latest` as the default
on these routes. `filter=all`, repeated filter parameters, attempt-qualified jobs,
and filters on unrelated routes retain separate keys. This normalization changes no
upstream query, freshness bound, or cache lifetime.

Shaped Actions run lists with non-default JSON media carry
`query_semantics: actions-run-list-filter-v1`. Older pooled revalidation could publish
an unfiltered canonical body under a filtered request key; this marker retires those
entries and validators across shared, identity, edge, stale and coalesced reads.
Default-JSON shaped lists and unshaped REST keys remain warm. New revalidation always
keys the normalized request it actually fetches and publishes.

Non-default JSON `Accept` variants also carry `body_codec: lossless-v1`, using the
same normalization as the vary headers. Raw blob/contents/README, octet-stream,
diff/patch, and other custom media cannot reuse old opaque bodies or validators in
edge, D1, identity caches, stale fallback, or fill coalescing. This field composes with
the representation generations below. Default JSON keys stay warm: this is bounded
media retirement, not a purge of hypothetical malformed non-JSON responses previously
returned to default-JSON requests. Future opaque decoding is lossless regardless of
the request's negotiation.

Default-JSON contents reads with a nonempty scalar `ref` carry `contents-rest-v2`.
This retires raw-origin file objects that cannot represent symlinks and submodules
correctly, including earlier `contents-self-links-v1` bodies, across shared and
identity keys, edge/D1 hits, validators, stale fallback, and late old fills. All new
JSON contents fills use exact REST responses. The predicate covers plain filenames;
it does not guess which paths are symlinks. Contents without a scalar ref, custom
media (including their `body_codec`), blobs, README routes, and unrelated
representations retain their keys. No publication epoch, public-repository proof,
or R2 generation changes or cache purge are required.

Default JSON `git_ref` and `git_matching_refs` keys include `git-refs-framing-v1`.
This retires older potentially incomplete ref objects and arrays for exact and matching
heads/tags across shared and identity entries, edge/D1 hits, stale fallback, validators,
and fill coalescing. Complete API-origin entries may also miss once; stored provenance
is not guessed. Branch lists/views, Git objects, custom media, contents, Actions, R2,
and public-repository proof keys retain their existing generations. No purge or schema
change is needed.

The contents and Git-ref representation predicates follow their JSON
eligibility, including missing, empty, and whitespace-only `Accept`. Explicit blank
values keep their existing distinct vary-header keys and `body_codec: lossless-v1`;
they are not folded into absent headers or into each other. This also retires old
blank-Accept reconstructed contents responses. Raw/custom
non-JSON media and contents without a nonempty scalar ref retain their keys.

Actions summaries also include a server-controlled representation generation
(`actions-summary-metadata-v3`) in this common key. Run views, attempt-qualified views,
and repository/workflow run lists, including canonical supersets and identity-specific
entries, cannot reuse summaries from `actions-summary-owned-v2` or earlier generations. Existing
`actions-summary-v1` clients keep the same wire format but miss those old entries in
edge, D1, stale fallback, fill coalescing, and conditional revalidation. Raw REST and
unrelated shapes have no Actions representation discriminator; the common publication
epoch still applies. No cache purge is needed.

The generation also isolates late old writers and their validators; new readers never
join old summary fills or revive old bodies through `304` revalidation. Actions jobs,
raw REST, public-repository proofs, and terminal-log R2 keys retain their existing
representations.

Release views and latest-release reads with `release-summary-v1` similarly include
`release-summary-raw-v2`. Existing clients cannot reuse the old HTML-derived bodies
from edge, D1, stale fallback, fill coalescing, or conditional revalidation. This
discriminator applies to `release-summary-v1`; raw REST entries still carry the common
publication epoch. Existing clients retain this generation even for metadata-only
projections, since their shape can also request the full response body.

Release views selecting only `tagName`, `url`, `isDraft`, `isPrerelease`, and `publishedAt`
use the separate `release-metadata-v1` shape. Its public-page response contains only
those proven fields; the shape header keeps its cache entries separate from exact
release summaries and raw REST in every cache path. HTML validators are omitted from
the derived JSON, so an API `304` cannot revive page-derived metadata. Existing release
TTLs, age bounds, visibility checks, and cache publication still apply. Forced-fresh
reads fetch the page again. Mixed selections containing `name`, `body`, or `createdAt`
keep the exact API shape; metadata never supplies those fields or a list response.

Issue timelines and the three issue-event list/view routes include `issue-events-public-v2`
for every representation, including raw REST and identity-specific keys. Older pooled bodies
may retain private cross-reference details, even after anonymous revalidation removed their
identity attribution. All old keys are retired across edge, D1, stale fallback, fill coalescing,
and revalidation. Only anonymous responses populate the new generation. Caller conditionals
bypass storage and use the anonymous API; a `304` never revives an old server-cached body.
Repository/network activity feeds and unrelated routes do not carry the issue-event
discriminator; they still carry the common publication epoch.

PR summary versions vary by `x-octopool-public-shape`: `pr-summary-v1`, `pr-summary-v2`,
and unshaped REST requests cannot reuse each other's entries. V2 adds bounded merge,
draft, and actor projections; a requested value omitted by the page causes one exact
relay retry without the shape header. The retry preserves the caller's freshness bound,
and neither summary version changes TTLs or the CLI's live-read field rules. Older CLIs
retain v1 support; no cache purge is needed.

PR file-list routes may include a validated
`route_hint.pr_head_sha` or closed/merged `route_hint.pr_state` discriminator. Clients
that already know the current PR state can use that to avoid mixing entries across head
SHAs while letting Octopool keep `files` warm longer. Hints are first checked against
GitHub and then cached briefly in `github_pr_state_proofs`, so repeated cache hits do not
need to re-contact GitHub just to validate the hint.

PR-state metadata uses the same `MAX_RESPONSE_BYTES` cap as response bodies: exactly the
cap is accepted, and the first chunk crossing it cancels the read before JSON parsing or
proof storage. Failed metadata reads, parsing, or matching do not insert or refresh a
proof; the request continues with the ordinary unhinted files cache key. Proofs last
300 seconds. If a fresh proof's keyed body is missing, live verification is required
before filling it. A failed live check ignores that discriminator for the current request,
including stale-cache selection, while leaving the stored proof intact. A failed proof
storage attempt also returns no newly trusted hint; an unknown write acknowledgment does
not establish whether the write committed. These metadata failures preserve the unhinted
route fallback; an oversized actual files response still uses the existing
`424 fallback_local` / `github_response_too_large` handoff.

The `gh pr view --json files` shim resolves the head with `max-age=0`, sends a dedicated
`pr-files-v1` shape plus the verified head on every bounded page, and resolves the head
again after all hydration. If the head moved, the entire command falls back to real `gh`
instead of returning pages that may span revisions. Missing heads and lists beyond the
bounded pagination window also fall back.

### What is cached

Only successful `2xx` responses on cacheable routes are stored, except pending `202`
responses on repository statistics routes (`contributors`, `commit_activity`,
`code_frequency`, `participation`, and `punch_card`). These responses reach the caller
unchanged and store no body, so the next poll can reach GitHub's completed result.
Concurrent followers reacquire fill ownership before fetching; there is no retry timer.
A successful anonymous pending response may still warm the separate public-repository proof.

Readers also reject existing statistics `202` entries from edge, D1, identity-specific keys,
coalesced completions, revalidation and outage stale fallback, including late old writes.
No generation change or purge is needed. A forced refresh that returns pending leaves any
ready body's original timestamps and contents intact. Statistics `200`/`204`, their validators
and bounded stale windows, and unrelated routes' `202` behavior remain unchanged.

The edge + D1 cache is
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
Zero-age reads skip body-cache lookups that cannot satisfy the age bound, while retaining
validator discovery and serialized fill ownership, including waiting for an existing fill.

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
- human `gh run list/view` summaries (up to 25 results, with branch/status or workflow
  filters) and human/watch job/step metadata prefer public GitHub pages; machine run JSON
  and raw API requests use exact REST semantics, and log bodies remain authenticated
- exact public GitHub API reads without caller credentials for repo metadata, commits,
  compare JSON, contents, README, PRs, issues, checks/statuses, Actions run/workflow
  metadata, branches, tags, labels, milestones, topics, community profiles, forks,
  stargazers, subscribers, deployments, Git object reads, languages, contributors, licenses,
  release assets, GitHub metadata/license/gitignore APIs, org repository lists, org public
  events and members, user/gist reads, user follower/following/event/key lists,
  reactions, assignees, repo-wide issue/PR comments and events, commit pull/check-suite/
  branch/status metadata, network events, repository stats, repository search, and
  repo-scoped issue/commit search
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

Run status comes only from the recognized status prefix before the first colon on the
owned run link (or the owned status icon on a run page). Workflow names, display titles,
and branch prose cannot supply status or conclusion. A list card's trigger belongs only
to its workflow metadata region. The older sibling-timestamp forms remain supported:
`#N: pull request`, `#N: schedule`/`scheduled`, `#N: workflow dispatch`, and
`#N: Commit <owned commit link> pushed`; commit-link text cannot supply an event.
Current cards put trigger prose in a separate span and repeat timestamps for responsive
layouts. The copies must agree; manual dispatch and commit-push prose are parsed there,
and ambiguous event prose is hydrated from the owning run page. Its disjoint `Workflow run
graph` region supplies an exact `on: <event>` label beside the workflow link; the graph's
`graph_partial` URL and workflow link must both belong to the requested run, and the event
must be a documented GitHub event name. When the graph is absent, only confirmed summary
prose `push` and `pull request` maps to `push` and `pull_request`. Ambiguous prose such as
`issue` or `issue comment` is not canonical event evidence. Missing, conflicting, or
unknown ownership falls back to REST. A list containing even one hydrated run whose event
remains ambiguous falls back to REST as a whole, preserving exactness over page coverage.
Manual summaries accept the owned `Manually triggered` timestamp only with a matching
`workflow_dispatch` graph label. PR pages without an owned historical commit SHA still
require REST, including queued or completed runs.
Before any enrichment, a page with more than eight cards needing an event or full SHA
falls back to REST, counting the whole page before request-limit truncation. At most
eight run pages are hydrated concurrently, each capped at five seconds or the configured
request timeout, whichever is shorter. The list page fetch keeps the normal configured
transport timeout. After parsing and the card-count check, a separate shared 2500 ms
hydration deadline covers all run pages, redirects, body reads and commit patches.
List fetching and parsing do not consume that deadline. A failed hydration or deadline
aborts siblings; no partial list reaches cache publication. Failed hydration adds at
most roughly 2.5 seconds after the list page, plus synchronous parsing/scheduling overhead.
These bounds also apply to canonical 25-card fills; cache TTLs and machine JSON paths are unchanged.
This deliberately bounded markup contract can cost more API reads when GitHub changes
its layout. Valid known cards retain the existing wire fields, filters, and state-based
TTLs; fresh job/attempt metadata still independently governs terminal caching.

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
- checks, check suites, and commit statuses → 60s fresh plus up to 5m bounded stale fallback,
  even when terminal: reruns and new statuses can change results for the same commit SHA
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

Commit CI aggregate keys carry a server-owned policy generation, so existing hour-long
entries cannot survive the shorter TTL rollout through edge, D1, revalidation, or stale
fallback. Completed attempt-qualified runs/jobs and individual job IDs retain their longer
retention. Ordinary reads remain bounded cache reads; use `OCTOPOOL_FRESH=1` for live evidence.

## Completed Actions log cache

`job_logs` requests fetch the job endpoint without using edge or D1 metadata cache and
require that fresh job payload's own `status` to be `completed`. A cached completed run can
therefore never make an active job from a re-run terminal. Whole-run log archives are
not admitted by the relay route manifest and remain native GitHub CLI fallback; only
job-log routes use this cache. Active, unknown, or failed job metadata probes keep
the previous large-payload bypass behavior. Only a successful 2xx anonymous metadata
response records a public-repository proof. A proven-terminal log uses the dedicated
`ACTIONS_LOGS` R2 bucket, keyed by pool and exact job route path, so immutable log
downloads are shared without putting their large payloads in D1. Jobs from separate
run attempts retain their distinct job IDs.

R2 stores the raw log bytes, content type, original body encoding, and a retention timestamp.
Corrected writers also set the exact `body-codec: lossless-v1` object metadata marker.
Objects with a missing or different marker are misses before serving or existence-only
renewal. The Worker downloads the original bytes after fresh completion proof, then
replaces the object; a failed download or write leaves the previous object intact.
Legacy base64 objects were already reversible but also miss once under this format
contract. A late old writer produces another marker miss. The bucket prefix and
seven-day lifecycle are unchanged; no purge or bucket migration is required.

After the fresh terminal-status proof, an object younger than one hour can be served without
contacting the log endpoint. Older objects also make an authenticated log request without
following its redirect: a validated `302 Location` confirms existence and refreshes the
retention timestamp, while `404` purges the object and returns GitHub's deletion response.
Thus a deletion can remain cached for at most the bounded one-hour no-log-probe window, not
the full retention period.

An explicit `cache-control: max-age=N` also bounds this no-log-probe window. A log older
than that bound requires the same authenticated existence check before reuse;
`max-age=0` always checks, even immediately after a fill. Larger bounds never extend
the one-hour default. A failed check retains the existing backend/fallback behavior
instead of serving an unvalidated cached success.

Objects untouched and unconfirmed for seven days expire. Reads enforce that lifetime from
object metadata: expired objects are treated as misses and removed, so lifecycle cleanup
timing can never cause stale data to be served. R2 read, write, or probe failures never fail
a relay request: Octopool uses the existing authenticated redirect-validation path instead.

API and log redirect bodies are released before following an allowed log URL or completing
an existence probe. Rejected redirects, including invalid locations and chained downloads,
also release their bodies. Cleanup failures preserve the original result; the redirect
allowlist, credential stripping, quota headers, and log bytes are unchanged.

Operator provisioning is a one-time bucket plus lifecycle setup. The required lifecycle
rule is: enabled for prefix `github-actions-logs/v1/`, delete objects seven days after
creation. Apply it with Wrangler (or configure the identical rule in the R2 dashboard):

```sh
wrangler r2 bucket create octopool-actions-logs
wrangler r2 bucket lifecycle add octopool-actions-logs octopool-actions-logs-expire github-actions-logs/v1/ --expire-days 7
```

The operator owns this rule; worker code does not scan R2 or manage bucket lifecycle.

As with edge + D1 hits, Octopool runs the public-repository guard before returning an R2
log hit. Successful hits are audited as cacheable `hit` events and count as cache-served
responses; active-run log fetches remain non-cacheable `bypass` events. Neither outcome
counts upstream requests, including visibility and log-existence probes.
Requests carrying `If-None-Match` or `If-Modified-Since` skip the completion lookup and
all R2 reads and writes, preserving the normal conditional-request bypass path.

## Workflow metadata reuse

A raw, queryless numeric workflow view can reuse its matching object from a fresh raw
`page=1&per_page=100` workflow-list cache entry. This avoids fetching the same workflow
metadata again when a machine-readable run list hydrates workflow names before a run
view. Reuse requires one unambiguous numeric ID and API URL match; the complete REST
object is returned unchanged. Plain `.yml`/`.yaml` filenames can reuse the catalogue too,
but only when it is complete (`total_count` matches its rows and there is no pagination
link), exactly one row has that `.github/workflows/` path, and that row is active with a
valid numeric ID and matching repository API URL. Partial lists and ambiguous or inactive
filename mappings retain the ordinary view fetch. A missing item never proves that the
workflow is absent, and a cold catalogue is not fetched just to answer a view.

The lookup preserves the pool, API version, JSON media key, source expiry, requested
maximum age, current identity eligibility, and public-repository guard. Anonymous entries
are checked before loading pooled identities. It publishes no view alias and does not
refresh the source. List validators, lengths, and pagination links are omitted from the
derived view. Shaped/HTML metadata, custom media, query parameters,
conditionals, and forced-live reads retain their existing paths. Optional lookup failures
continue through the ordinary view fill; policy and visibility denials still propagate.

## Actions run-list superset

Machine run JSON does not request this shaped superset. It uses existing unshaped REST
cache keys and validates the returned page against the effective CLI limit before any
lazy workflow-name hydration. This increases API/cache cost in exchange for native field
semantics; it does not change cache generations or the human/watch page adapters.

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
Public Actions pages with exact totals must expose at least `min(total_count, per_page)`
parseable cards. Capped totals are lower bounds and require at least `per_page` cards
(page requests are bounded to 25);
otherwise Octopool discards the page and falls back to exact anonymous API JSON.
Branch/status-filtered public pages are never treated as exact: GitHub can report only the
visible matching card count while older API matches still exist. Underfilled canonical filters
therefore go directly to the exact anonymous API/pool fallback chain.

Before fetching a missing or expired canonical page, the relay checks for a fresh exact
filtered entry, then a fresh shaped 100-run entry with the same pool, route path, media,
API version, and eligible source identity. A larger entry must contain at least 25 runs,
or be a complete shorter API page whose `total_count` exactly matches its returned runs
and which has no pagination `Link` header. This includes a confirmed empty list. Only its
first 25 participate in the smaller page's filtering, derived total, and underfill
check. Reuse keeps the source expiry and requested maximum age without publishing a
25-run alias or refreshing either entry. Unshaped REST entries remain separate.
Exact entries preserve GitHub's total count and may legitimately contain
fewer runs than the requested limit. A failed exact lookup leaves the canonical fill
unchanged, including ordinary storage/configuration failures; explicit policy and visibility
denials still propagate. Larger-page lookups follow the same optional-probe rules.
Both probes check anonymous entries before loading pooled identities.
Coalesced and revalidation recovery hits apply the same completeness check as
ordinary fresh hits. During an outage, an underfilled canonical page cannot become an
empty or partial success: the relay uses an eligible exact stale entry or retains the
normal typed failure. Both cache paths keep the existing identity, public-visibility,
retention and explicit maximum-age checks; `max-age=0` still requires upstream validation.

## Actions attempt job-list superset

Shaped human `gh run view` and `gh run watch` reads resolve the run's current positive
`run_attempt`, then request `/actions/runs/{id}/attempts/{attempt}/jobs`. That attempt-qualified
path is immutable after all returned jobs complete, while the base run and base jobs endpoints
remain short-lived because a rerun can change both after they previously appeared terminal.
Before granting the one-hour job-list TTL, Octopool verifies that exact attempt is completed;
a list of currently completed jobs alone is not treated as proof. A fresh cached run-view
response can supply that proof when its run ID and attempt match and its source identity
and public-repository guard remain eligible. Both the base run view and the exact attempt
view qualify, including pooled responses when anonymous metadata is unavailable. The
existing cache owner and expiry remain authoritative; no separate completion store is created.
Anonymous proof is checked before loading pooled identities, so an identity lookup outage
does not discard usable public metadata. Pooled proof still requires an eligible source identity.
Explicit age bounds apply to this lookup, and live or conditional requests still require
the direct attempt check. An active run, a different attempt, expired metadata or a revoked
source cannot extend the jobs' lifetime. Without an eligible cached proof, Octopool keeps
the existing public-page/anonymous-API check and conservative 60-second fallback.

Equivalent shaped `page=1`, omitted/`latest` filter, and `per_page` values up to 100 share one
attempt-qualified cache entry, filled from at most three 100-job API pages. Octopool slices
that complete superset locally and removes upstream representation validators, lengths,
and pagination links. All pages must have consistent valid `total_count` metadata and the
merged list must match that count. A remaining `Link: rel="next"` also prevents completion,
even when the count matches; the first page's link is removed only after a complete merge.

Merged API job lists also discard the first page's `ETag`, `Last-Modified`, and
`Content-Length` before storage. A page-one `304` cannot validate later pages of the
cached aggregate. Revalidation recognizes older merged entries with more than 100 jobs
and ignores their page validators, so an expired or forced refresh fetches every page
again. Single-page validators, fresh cache hits, and bounded outage stale reads retain
their existing behavior. No cache-key or TTL change is needed. This protects the complete
stored aggregate; each shaped response still returns at most 100 jobs, and human run view and watch
fetch later pages separately.

If a partial rerun exposes count metadata that disagrees with the returned job set, a count
disagreement alone does not establish another page or prove which successful jobs were
reused. Octopool rejects that ambiguous shaped response with `pagination_exhausted`, without
caching it, inventing jobs, or treating a short page as a complete summary. Supported
`gh run watch` stops with an explicit error on that refusal and never starts real `gh`;
ordinary run-view fallback remains available. `filter=all`, later pages, unshaped REST
requests, and unsupported query variants retain exact upstream semantics.

Machine run-view jobs use up to 10 unshaped canonical returned-attempt pages of 100, with
completeness/identity validation before output. Human run view and watch share that CLI
collection bound; the Worker's 3×100 shaped superset remains separate. Requested attempts qualify machine output
URLs while returned attempts own jobs acquisition; [CLI documentation](cli.md) describes
the native defaults, explicit safe-integer boundary, lazy names and whole-command fallback.

Raw default-JSON first-page jobs requests with a smaller page size can reuse a fresh
raw `per_page=100` entry for the same path and equivalent filter (omitted and `latest`
are equivalent on the base jobs endpoint). Its `total_count` must equal
the jobs array length, the entire array must fit the requested page, and it must have no
`Link` header. This includes empty lists. Octopool returns the complete REST body unchanged,
including extra fields, while omitting source representation validators and lengths.
It keeps the source timestamps and expiry without publishing an alias or extending its TTL.

The optional lookup checks one larger page for the shared cache, then one per eligible
identity; it never fetches a cold larger page. Requests for 100 jobs skip this probe.
Pool, run, attempt, filter, API version, media type, current identity eligibility,
public visibility, and positive maximum-age bounds still apply. Shaped responses,
custom media, later pages, unsupported queries, conditionals, and forced-live requests
retain their existing paths. Lookup failures fall through to the exact request;
policy and visibility denials still propagate.

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

Transient GitHub server responses (`500`, `502`–`504`, and `520`–`524`) and recognized
fetch/response-stream network or timeout failures can also use that existing stale
window. This does not renew the cached body's timestamps, extend retention, or bypass
an explicit age bound. HTTP response quota observations are still recorded for the
selected pooled identity; transport failures do not invent quota or cooldown feedback.
Without an eligible cached body, the original response or error is preserved. Terminal
HTTP responses, response-size refusals, policy denials, and local response-body ownership
errors retain their existing behavior.
The same recovery applies when a later page of a shaped jobs collection is unavailable:
only a complete eligible cached aggregate can replace the failed refresh. Otherwise the
existing `pagination_exhausted` refusal remains; partial pages are never published.

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

Storage (`shared`, `edge_only`, `none`, `failed`, `rejected`, `unknown`) and completion acknowledgment
(`accepted`, `lost`, `unknown`) are distinct internal results. A zero-row write is rejected
unless an exact immutable already-committed receipt recovers a replay/lost acknowledgment.
Intentional statistics nonpublication uses `none` without a publication ID; it revokes the
exact owner, including expired cleanup, without claiming that absent data is shared.
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
count fresh and stale hits as `cache_served_responses`, including bodies reused after a
successful `304` refresh. Revalidated hits measure body reuse, not avoided upstream requests
or saved GitHub quota. Miss and bypass rows count as `uncached_outcomes`, including
failed requests and local fallbacks. The body-reuse rate retains the historical
`cache_hit_rate` field; its eligible variant excludes failed misses and deliberate local
fallback responses. Successful `304` refreshes retain `hit` with
`fallback_reason = cache_revalidated` as their distinct audit marker.
These are relay-audited outcomes, not actual or avoided GitHub requests: one outcome can
include several upstream attempts, and cache serves can require visibility, membership,
or revalidation checks. Unknown cache outcomes are counted separately.
The deprecated JSON fields `saved_github_requests` and `backend_requests` remain historical
aliases for `cache_served_responses` and `uncached_outcomes` for shipped clients; they do
not measure GitHub savings or fetch totals. New consumers must use the canonical fields.
Audit backend describes the resource fetch or verifier for that request: anonymous API
`200` replacements and `304` validations use `github_api`, regardless of the cached body's
source. Request-only verifier metadata does not alter stored identity, body encoding, delivered
status, or the broad relay backend label. A following cache-only hit has no audit backend;
an ancillary visibility probe does not supply one or spend pooled identity quota.

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
