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
- Only `GET` is enabled. Any other method is rejected with `403 method_denied`.
- `query` values are strings or string arrays. Keys are rejected if they look
  secret-bearing (`token`, `secret`, `password`, `api_key`, …).
- `headers` are filtered down to `accept`, `x-github-api-version`, `if-none-match`,
  `if-modified-since`, `cache-control`. Everything else is dropped.
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
- `body_encoding` is `json`, `text`, or `base64`. Binary responses are base64-encoded.
- `repo_view` returns a fixed public metadata subset before caching so token-specific
  repository fields such as identity permissions are not shared.
- Release list/latest/tag/id reads use unauthenticated public GitHub API reads; supported
  top-level `gh release view` summaries prefer public GitHub release HTML. Raw API requests
  retain exact REST response semantics.
  Octopool does not use pooled credentials for releases, so draft/private release visibility
  is not shared.
- Supported top-level `gh run view --json jobs` reads prefer job and step metadata composed
  from public GitHub pages. Raw `/actions/runs/{id}/jobs` requests retain exact REST response
  semantics, and log bodies still require authenticated API access.
- Public org repository/member/event reads, user/gist collection reads, global metadata reads,
  and public repository metadata collections can be served from unauthenticated GitHub API
  responses before spending pooled identity quota.
- `GET /user` is relayed as the caller's public profile: Octopool rewrites it to
  `GET /users/:login` for the authenticated caller and serves it token-free, so identity
  probes never spend pooled or local quota. Private `/user` fields (plan, private repo
  counts, email visibility) are not included; callers that need them fall back to real `gh`.
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
- `lease_reason` is `sticky`, `highest_remaining`, or `fallback` — see
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
  `type:issue|pr` / `state:open|closed`; repository search accepts plain terms only. Invalid
  queries return `424 fallback_local` with reason `search_denied`.

Every repo route additionally passes a public-visibility check before a pooled identity
or cache entry is used — see [Cache & public-repo guard](cache.md).
The complete list of relay paths eligible for anonymous API or public web/raw/Git
transport is in [Token-Free GitHub Endpoints](token-free.md).

`route_hint.pr_head_sha` and `route_hint.pr_state` are validated, optional cache
discriminators for PR file lists. They do not bypass policy or visibility checks; they
only let clients that already know current PR state keep `/files` cache entries separate
across head SHAs or closed/merged state.

## Safety limits

- Redirects from `api.github.com` are denied (`502 github_redirect_denied`) except the
  log-download flow above.
- Response bodies are capped: 1 MiB default, up to `MAX_RESPONSE_BYTES` (2 MiB) for
  large-payload routes and Actions run lists. Run lists remain cacheable; over-cap
  responses fail with `502 github_response_too_large`.
- Requests time out after `REQUEST_TIMEOUT_MS` (15s default).

## Audit

Every validated request from an authenticated caller to an existing pool writes an
`audit_events` row with request id, caller, pool, route key, route kind, identity id,
status, error code, and duration. Parse, authentication, and pool-lookup failures occur
before the audit boundary.
Audit writes happen via `ctx.waitUntil` and never block the response.
The hourly maintenance task deletes audit rows older than 30 days in bounded batches,
matching the maximum stats query window.
