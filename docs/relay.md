# GitHub Read Relay

The relay is the core of Octopool: a single Worker endpoint that performs read-only
GitHub requests on behalf of a caller. It serves shared cache hits first, then equivalent
token-free reads, and selects a pooled GitHub identity only when needed.

Source: `src/relay.ts`, `src/router.ts`, `src/policy.ts`, `src/route-manifest.ts`,
`src/github.ts`, `src/github-web.ts`.

## `POST /v1/github/request`

Authenticated with a caller bearer token scoped to the target pool (see
[Auth](auth.md)).

Request body:

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

- `pool`, `method`, `path` are required, non-empty strings.
- REST stays `GET`-only. The sole caller-supplied POST read is the validated
  [repository GraphQL](#repository-graphql-reads) envelope below; other methods/paths
  are rejected with `403 method_denied`.
- `query` values are strings or string arrays. Keys are rejected if they look
  secret-bearing (`token`, `secret`, `password`, `api_key`, …).
- `headers` are filtered down to `accept`, `x-github-api-version`, `if-none-match`,
  `if-modified-since`, `cache-control`, and `x-octopool-public-shape`. Everything else is dropped.
- A `cache-control: max-age=N` request directive bounds acceptable cache staleness: a
  fresh shared-cache entry older than `N` seconds is treated as a miss and refilled, and
  the refill writes through to the shared cache, unlike conditional headers, which bypass
  it. Other `cache-control` directives are ignored, and the header never varies the cache
  key or reaches GitHub.
- `route_hint.pr_head_sha` and closed/merged `route_hint.pr_state` are validated cache
  discriminators for PR file lists.
- Legacy `route_hint.owner`, `route_hint.repo`, `route_hint.kind`, `cache_key`, and
  `idempotency_key` input remains accepted for wire compatibility but is discarded during
  validation. It does not enter the trusted request model or affect routing, caching, or policy.

### Path validation

`path` must be an absolute GitHub API path. It is rejected (`400 invalid_path`) if it
contains `://`, `\`, `?`, `#`, `..`, a bare dot segment, or percent-encoded path
traversal (`%2e`, `%5c`). The relay only talks to approved GitHub API, web, raw-content,
and patch hosts.

## Response envelope

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "etag": "...",
    "x-ratelimit-remaining": "4998",
    "x-ratelimit-reset": "1780000000"
  },
  "body": {},
  "body_encoding": "json",
  "identity": { "id": "ghapp_openclaw_openclaw", "kind": "github_app" },
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

- `headers` are filtered to a safe allowlist (content negotiation, caching,
  rate-limit, request id). Authorization and cookies never leave the Worker.
- `body_encoding` is `json`, `text`, or `base64`. Opaque API and public diff/patch
  responses preserve bytes: invalid UTF-8, a leading UTF-8 BOM, or NUL in the first
  1,024 bytes selects base64. Other valid UTF-8 stays text, including literal U+FFFD,
  CRLF, and later NUL bytes. Empty API responses remain null/text; empty public
  diff/patch responses remain empty-string/text. Successful `application/json`
  parsing retains existing JSON value semantics, without promising original JSON
  bytes or whitespace; malformed JSON falls back to lossless opaque encoding.
  The response cap applies to upstream bytes before base64 or envelope expansion.
- `repo_view` returns a fixed public metadata subset before caching so token-specific
  repository fields such as identity permissions are not shared.
- Release list/latest/tag/id reads and top-level `gh release view` summaries use the
  anonymous GitHub API, preserving exact raw Markdown in `body` through cache and JSON
  projection. Rendered HTML is not a source of release bodies. Cache misses consume
  anonymous API quota; unavailable reads retain bounded exact stale-cache and guarded
  local-`gh` fallback. Raw API requests retain exact REST response semantics.
  Octopool does not use pooled credentials for releases, so draft/private release visibility
  is not shared.
- Issue timelines, per-issue events, repository issue-event lists, and individual issue events
  use only the anonymous API, including conditional requests. A public target repository
  does not prove that referenced issues or commits are public. Anonymous failures use bounded
  public stale data or `424 fallback_local` (`web_only_unavailable`); pooled credentials and
  legacy event cache entries cannot widen visibility. Public JSON and response validators
  are preserved, and native fallback uses the caller's own credentials.
- Machine `gh run list/view --json`, including jobs, uses unshaped exact REST through the
  shared cache, with lazy verified workflow-name metadata. Human run views and watch retain
  bounded public-page job/step metadata. Raw `/actions/runs/{id}/jobs` requests retain exact
  REST response semantics, and log bodies still require authenticated API access. See the
  [CLI export contract](cli.md) for native defaults, safe-integer limits and acquisition bounds.
- Public org repository/member/event reads, user/gist collection reads, global metadata reads,
  and public repository metadata collections can be served from unauthenticated GitHub API
  responses before spending pooled identity quota.
- `GET /user` is relayed as the caller's public profile: Octopool rewrites it to
  `GET /users/:login` for the authenticated caller and serves it through the anonymous API,
  falling through to a pooled identity only when anonymous quota is exhausted. Private
  `/user` fields (plan, private repo counts, email visibility) are not included; callers that
  need them fall back to real `gh`.
- `GET /orgs/:org` is intentionally not relayed because authenticated GitHub responses can
  include additional org fields that are not present in unauthenticated public API responses.
- `GET /users/:login/starred` and `/subscriptions` are intentionally not relayed because
  authenticated responses can include private repositories visible to the caller.
- `cache` is `hit`, `stale`, `miss`, or `bypass` (conditional, log, large-payload, or
  otherwise non-cacheable request).
- `stale_ok: true` means an expired public cache entry was served because all eligible
  identities were depleted, cooling down, missing, or rate-limited, or because a token-free-only
  route lost its public backend (`web_only_unavailable`). `stale_reason` and
  `cache_expires_at` are included on those responses.
- `backend` is present as `web` or `github_public` when a cache miss or identity-less cache hit
  was served without a pooled API identity.
  Audit backend separately describes the resource fetch/verifier: anonymous API replacements
  and `304` validations count as `github_api`; a cache-only hit has no audit backend.
- Repository statistics `202` responses are returned unchanged without body caching. Each
  later poll can reach upstream readiness; old pending entries cannot serve hits, revalidate,
  or supply outage stale data. A forced pending refresh preserves any ready entry's original
  lifetime, and unrelated routes keep their existing `202` behavior.
- `lease_reason` is `sticky` or `highest_remaining` — see
  [Identities & routing](identities.md).

## Supported routes

Routes are defined in `src/route-manifest.ts` and enforced by `src/policy.ts`. Only the
following read-only shapes are enabled. A safe CLI-shaped request outside this set gets
`424 fallback_local` with reason `route_denied`, so the shim can delegate to real `gh`:

<!-- supported-route-kinds:start -->

- `user_view`
- `user_repo_list`
- `user_org_list`
- `user_gist_list`
- `user_follower_list`
- `user_following_list`
- `user_event_list`
- `user_received_event_list`
- `user_key_list`
- `user_gpg_key_list`
- `org_repo_list`
- `org_event_list`
- `org_public_member_list`
- `org_public_member_view`
- `gist_view`
- `emoji_list`
- `github_meta`
- `license_list`
- `license_view`
- `gitignore_template_list`
- `gitignore_template_view`
- `repo_view`
- `commit_list`
- `commit_view`
- `commit_view_ref`
- `commit_comments`
- `commit_pulls`
- `commit_branches_where_head`
- `commit_statuses`
- `commit_statuses_ref`
- `repo_comment`
- `compare`
- `contents`
- `repo_readme`
- `pr_view`
- `pr_list`
- `pr_files`
- `pr_commits`
- `pr_review_comments`
- `pr_review_comment_list`
- `pr_review_comment_view`
- `pr_review_comment_reactions`
- `pr_reviews`
- `pr_review_view`
- `pr_review_comments_for_review`
- `pr_requested_reviewers`
- `commit_check_runs`
- `commit_check_runs_ref`
- `commit_check_suites`
- `commit_check_suites_ref`
- `commit_status`
- `commit_status_ref`
- `ref_statuses`
- `run_list`
- `run_view`
- `run_jobs`
- `run_artifacts`
- `job_view`
- `job_logs`
- `check_run_annotations`
- `issue_view`
- `issue_list`
- `issue_comments`
- `issue_comment_list`
- `issue_comment_view`
- `issue_comment_reactions`
- `issue_events`
- `issue_event_list`
- `issue_event_view`
- `issue_labels`
- `issue_reactions`
- `issue_timeline`
- `assignee_list`
- `assignee_view`
- `label_list`
- `label_view`
- `milestone_list`
- `milestone_view`
- `branch_list`
- `branch_view`
- `branch_protection`
- `repo_ruleset_list`
- `repo_ruleset_view`
- `branch_rules`
- `tag_list`
- `repo_languages`
- `repo_contributors`
- `repo_license`
- `repo_topics`
- `community_profile`
- `fork_list`
- `stargazer_list`
- `subscriber_list`
- `deployment_list`
- `repo_event_list`
- `network_event_list`
- `repo_stats_contributors`
- `repo_stats_commit_activity`
- `repo_stats_code_frequency`
- `repo_stats_participation`
- `repo_stats_punch_card`
- `git_blob`
- `git_commit`
- `git_tag`
- `git_tree`
- `git_ref`
- `git_matching_refs`
- `workflow_list`
- `workflow_view`
- `workflow_run_list`
- `release_list`
- `release_latest`
- `release_view`
- `release_assets`
- `release_asset`
- `search_issues`
- `search_code`
- `search_commits`
- `search_repositories`
- `rate_limit`

<!-- supported-route-kinds:end -->

`job_logs` is a large-payload, log-class route: it follows GitHub's signed redirect to
`*.actions.githubusercontent.com` / `*.blob.core.windows.net`, caches immutable logs in R2
for seven days only after the owning run completes, and is gated by the pool's `allow_logs`
policy. Cached logs get at most a one-hour zero-contact window before an authenticated
existence probe honors upstream deletion; active-run and failed-preflight logs retain the
direct-fetch bypass.

### Fixed public GraphQL landing reads

`GET /repos/{owner}/{repo}/pulls/{number}` supports five additional
`x-octopool-public-shape` values. The Worker constructs the exact upstream query
from its allowlist in `src/github-public-shapes.ts`; these shapes do not accept caller GraphQL.
The existing `pr_view` owner routes these projections through the pool's `graphql`
budget instead of REST's `core` budget.

| Shape                  | Public response                                                                                             | Query parameters  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------- |
| `pr-ci-summary-v1`     | PR state, mergeability, head, rollup state and check/status counts                                          | None              |
| `pr-ci-rollup-v1`      | PR state, mergeability, head and up to 100 rollup contexts, including check suite/workflow IDs              | Optional `cursor` |
| `pr-merge-snapshot-v1` | Repository identity, main ref, PR identity/head/base, mergeability, merge commit and auto-merge/queue state | None              |
| `pr-comments-v1`       | PR identity and up to 100 public comments, without viewer fields                                            | Optional `cursor` |
| `pr-commits-v1`        | PR identity/head and up to 100 commits with the first 100 authors                                           | Optional `cursor` |

The envelope's `body` is the unchanged GraphQL JSON response, including `data` and
any `errors`. Successful non-null PR responses cache for 60 seconds without stale
fallback; `cache-control: max-age=0` refreshes one projection through the pool.
GraphQL errors keep their upstream HTTP status and never populate the body cache.
Consumers must inspect `errors` even on HTTP 200, as the CLI does.
The PR-view CLI reads comment and commit projections live and reconstructs the
[native export contract](pr-details.md). Reviews remain native because pending
reviews depend on the requesting account.

Only default JSON media is accepted. Conditional validators, extra query parameters,
non-scalar/empty cursors, cursors longer than 512 characters or containing control
characters, and cursors on other shapes are refused before upstream dispatch. The
public-repository guard, caller/pool policy, string protection, response caps and
pooled identity eligibility still apply. There is no anonymous REST or page substitute
for these GraphQL projections. `viewerMergeBodyText` and mutations remain native.
Other eligible repository queries use the separate scoped-token route below.

### Repository GraphQL reads

`POST /v1/github/request` also accepts this envelope:

```json
{
  "pool": "maintainers",
  "method": "POST",
  "path": "/graphql",
  "graphql": {
    "query": "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid}}}",
    "variables": { "owner": "openclaw", "name": "openclaw", "pr": 42 }
  },
  "headers": { "cache-control": "max-age=0" }
}
```

The Worker parses the document with `graphql-js` before dispatch. Exactly one query
operation must select exactly one `repository(owner:,name:)` root, optionally aliased,
plus optional `__typename` fields. Owner/name must be string literals or supplied
string variables; variable defaults do not establish scope. Optional `operationName`
must match the sole operation. Fragments are expanded for root and depth checks;
missing, duplicate, cyclic, or excessively expanded fragments are refused. All field
names, including unused fragments, are checked for `viewer*`, `__schema`, and `__type`.
Only `@include` and `@skip` directives are accepted. Other roots (including `viewer`,
`rateLimit`, `node`, `nodes`, `search`, organization/user and enterprise lookups),
mutations, subscriptions, and schema definitions are refused.

Query and variables are independently capped at 16 KiB; selection and JSON variable
depth are capped at 12, with 4,000 document tokens and expanded selections. Variables
may contain JSON scalars, lists, or objects. Only default JSON Accept and cache-control
headers are supported; query-string fields and conditional validators are refused.
The owner must occur in `allowed_owners`, even when `allow_public_repos` is enabled.
The existing public-repository proof guard must authorize the repository before any
App token or cached response is used. Private or unknown visibility returns
`424 fallback_local` (`repo_not_public` / `repo_public_check_failed`).

**The credential is the primary security boundary.** Only active, route-eligible GitHub
App identities can execute these queries. The Worker verifies the installation account
matches the repository owner, then mints with `repositories: [name]` and an explicit
read-only subset of granted `metadata`, `contents`, `pull_requests`, `issues`, `actions`,
`checks`, and `statuses` permissions. Organization and other permissions are excluded.
The mint response must confirm exactly that repository and those read-only permissions.
Nested traversal such as `owner.repositories` or `author.repositories` can therefore
see only the selected repository and public GitHub data, not unrelated private org
repositories. AST restrictions are defense in depth, not the confinement mechanism.
The normal public-proof lifetime still bounds detection of a repository becoming private.

Scoped tokens use a separate bounded per-repository memory cache, refreshed at least
60 seconds before expiry. Installation-wide tokens and PATs are never substituted.
Missing access, invalid scope/permissions, missing credentials, or mint failure returns
`424 fallback_local` with `github_app_repo_token_unavailable`; unavailable App candidates
use the existing pool fallback reasons. A query needing an ungranted permission retains
GitHub's GraphQL errors. Only `https://api.github.com/graphql` receives the query POST;
redirects are denied. Installation metadata/token exchange remains internal auth traffic.

The response uses lossless `body_encoding: "text"` JSON bytes through the ordinary
envelope, preserving whitespace, escape spelling, large numbers, and HTTP-200 `errors`.
The existing sanitation policy still applies; a body requiring sanitation is re-encoded.
Response caps, timeouts, authoritative string protection (including decoded GraphQL
string literals and variable values), backend-work admission, and audit remain enforced.
Audit uses `route_kind: graphql_read`, `route_key: POST /graphql repository-read`, the App
identity, and `requested_max_age`. Rate headers update the App's GraphQL resource;
HTTP-200 secondary-limit errors also enter the identity cooldown without changing the body.

The pool/repository, canonically printed AST, recursively sorted variables, operation
name, and source App identity partition cache entries. Error-free JSON data caches for
60 seconds with no stale fallback. `max-age=0` always fetches upstream; positive maximum
ages allow bounded reuse and identical misses use existing coalescing/publication ownership.
The CLI defaults this route to live reads: quota placement is the main benefit.
Upgrade both Worker and CLI; older Workers trigger guarded native fallback. No schema
migration, permission expansion, or cache purge is required.

### Native protection reads

The following exact GET routes are recognized by the canonical manifest but always return
`424 fallback_local` with reason `local_credentials_required`. After caller authentication
and fresh authoritative string-rewrite and pool-policy checks, the Worker hands them off
before cache reads/writes, repository visibility probes, anonymous requests, or pooled
credentials. The CLI checks current policy again before dispatching the user's native `gh`.
`OCTOPOOL_NO_FALLBACK=1` therefore refuses these reads.

<!-- native-read-routes:start -->

```text
GET /repos/{owner}/{repo}/branches/{branch}/protection
GET /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins
GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks
GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts
GET /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews
GET /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures
GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions
GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps
GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams
GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users
GET /repos/{owner}/{repo}/rulesets
GET /repos/{owner}/{repo}/rulesets/{id}
GET /repos/{owner}/{repo}/rules/branches/{branch}
```

<!-- native-read-routes:end -->

GitHub's [branch-protection API](https://docs.github.com/en/rest/branches/branch-protection)
requires Administration repository read permission, including these subresources.
The [rules API](https://docs.github.com/en/rest/repos/rules) permits anonymous public reads
and otherwise uses Metadata read permission, but ruleset details include `bypass_actors`
only when the caller has write access to the ruleset. All these routes conservatively use
the caller's native credentials, even for public repositories, preserving complete
authenticated response semantics. This does not grant permissions or change GitHub's errors.
Applicable branch rules include active rules from repository and higher levels; they exclude
disabled/evaluate rulesets and do not require an existing branch. They are not a substitute
for reading classic branch protection.

Only the listed paths join the strict read allowlist: no org/admin routes, rule suites/history,
arbitrary protection suffixes, or mutations. Branch names remain percent-encoded in the native
request; strict preparation accepts encoded slashes only in these manifest-owned branch
parameters after decoded structural checks. Traversal, unresolved placeholders, structural
policy matches, and unsafe headers still fail closed on the modeled path. Safe unmodeled
native routes or flags retain the CLI's [best-effort filtering](cli.md#outbound-string-rewrite-protection);
the Worker remains GET-only and does not relay those neighboring routes.

## Policy gates

`classifyRoute` enforces, per pool:

- `allowed_owners` — owners with scoped identity routing. Defaults to
  `DEFAULT_ALLOWED_OWNERS` (`openclaw`).
- `allow_public_repos` — public repositories from other owners are allowed after the
  public-repo guard proves `private: false` (default `true`). These routes use broad PAT
  identities from the pool rather than repo-scoped GitHub App installation tokens.
- `allow_logs` — log routes require it (default `true`), else `424 fallback_local` with
  reason `logs_denied`.
- `allow_search` — search routes require it (default `false`). Issue, code, and commit searches
  require exactly one `repo:owner/name` qualifier plus plain terms and optional
  `type:issue|pr` / `state:open|closed`. Every token must match this grammar: additional,
  quoted, bare, or malformed repo qualifiers, `OR`/`NOT`, and negated terms are rejected
  before upstream dispatch or cache reuse. Qualifier names and filter values are lowercase;
  owner/repository casing and whitespace between tokens are accepted without rewriting the
  query sent upstream. Repository search keeps its separate plain-term grammar. Invalid
  queries return `424 fallback_local` with reason `search_denied`. The supported token-free
  issue-search shape can run with `allow_search: false`, subject to the same grammar and
  owner/public-repository gates, and never falls through to pooled credentials.

Stored policy must be a JSON object. Missing fields, including an explicit `{}`, retain
the defaults above; present boolean fields must be booleans and `allowed_owners` must
contain only strings. Invalid JSON, roots, or known fields return
`503 pool_policy_unavailable` with a generic message, before cache access or pooled
identity selection. Authentication and deployment-wide string protection still run first.
This configuration error does not authorize native fallback; valid policy denials and
caller-owned native reads retain their existing `424 fallback_local` behavior.

Valid policies may remain cached in an isolate for 30 seconds after a database edit.
Cold and expired lookups reject corrupt storage, and failed parses are never cached as
successful configuration; a corrected value can be read on the next lookup. There is no
persistent last-known-good policy fallback.

Recognized transient D1 and Durable Object failures during relay reads return
`424 fallback_local` with `details.reason: relay_storage_unavailable`. Signals include
Cloudflare's network-loss, reset, storage-timeout and overload messages, and DO errors
with `retryable === true` or `overloaded === true`. The shim delegates to native `gh`
without a CLI upgrade. Original errors remain in Workers Logs; authenticated relay audit
rows record `error_code: fallback_local` and `fallback_reason: relay_storage_unavailable`
when the audit write succeeds. Other runtime messages matching the existing `is overloaded`
or `queued for too long` matcher retain `424 fallback_local` with reason `relay_overloaded`.
Unknown errors retain `500 internal_error`; GitHub
responses, explicit authentication/policy errors, admin endpoints and write rejection
retain their existing behavior. This mapping adds no storage retries.

When a client's backend-work allowance is full or its permit expires, the relay returns
`424 fallback_local` with reason `relay_overloaded`. The default is eight concurrent backend-work requests per authenticated caller/client
in each pool, configurable with `CLIENT_BACKEND_CONCURRENCY`. Fresh cache-only hits bypass
admission, including eligible identity-cache entries; misses, revalidations, and live
probes require a permit. See [backend-work admission](operations.md#backend-work-admission)
for lease deadlines, cancellation, upgrade requirements, and client-attributed stats.

Every repo route additionally passes a public-visibility check before a pooled identity
or cache entry is used — see [Cache & public-repo guard](cache.md).
An eligible wildcard PAT also covers explicitly allowed owners. Missing local bindings
do not widen scopes or bypass policy, native-only, private-repository, or token-free
release/event boundaries. Credentials are resolved only after identity selection; a
classified local configuration failure records shared health and tries another eligible
identity. If every selected credential fails locally, the first generic typed `503` is
returned without binding names or secret contents, rather than serving stale bytes.
The existing clean anonymous local fallback is preserved when opportunistic pooling
cannot help; string-protection denials and credential-feedback infrastructure failures
still propagate. See [identities](identities.md) for per-observation cooldowns, cached App
token prerequisites, and mixed-version method availability.

An aggregate already in progress does not restart or splice pages from another identity
if a later App refresh lacks credentials. It refuses the incomplete result without partial
publication or new local credential health; page-fetch and refresh string-protection
denials remain hard `403` failures.

The complete list of relay paths eligible for anonymous API or public web/raw/Git
transport is in [Token-Free GitHub Endpoints](token-free.md).

`route_hint.pr_head_sha` and `route_hint.pr_state` are validated, optional cache
discriminators for PR file lists. They do not bypass policy or visibility checks; they
only let clients that already know current PR state keep `/files` cache entries separate
across head SHAs or closed/merged state.

## Safety limits

- Redirects from `api.github.com` are denied (`502 github_redirect_denied`) except the
  log-download flow above.
- Response bodies on every route use the single `MAX_RESPONSE_BYTES` cap (2 MiB default;
  the hosted deployment sets 4 MiB). Over-cap responses return `424 fallback_local` with
  reason `github_response_too_large` so callers can retry with local credentials.
- Requests time out after `REQUEST_TIMEOUT_MS` (15s default).

## Audit

Every validated request from an authenticated caller to an existing pool writes an
`audit_events` row with request id, caller, pool, route key, route kind, identity id,
status, error code, bounded backend classification, and duration. Backend values distinguish
public web pages from anonymous GitHub API and pooled-identity responses without storing URLs,
query values, request bodies, or credentials. Parse, authentication, and pool-lookup failures occur
before the audit boundary.
Audit writes happen via `ctx.waitUntil` and never block the response.
The hourly maintenance task deletes audit rows older than 30 days in bounded batches,
matching the maximum stats query window.
