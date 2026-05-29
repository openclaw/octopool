# GitHub Read Relay

The relay is the core of Octopool: a single Worker endpoint that performs read-only
GitHub REST requests on behalf of a caller, using a pooled GitHub identity selected by
the pool coordinator.

Source: `src/index.ts` (`relayGitHub`), `src/policy.ts`, `src/github.ts`.

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
    "owner": "openclaw",
    "repo": "openclaw",
    "kind": "pr_files",
    "pr_head_sha": "0123456789abcdef0123456789abcdef01234567"
  },
  "cache_key": "...",
  "idempotency_key": "..."
}
```

- `pool`, `method`, `path` are required, non-empty strings.
- Only `GET` is enabled. Any other method is rejected with `403 method_denied`.
- `query` values are strings or string arrays. Keys are rejected if they look
  secret-bearing (`token`, `secret`, `password`, `api_key`, …).
- `headers` are filtered down to `accept`, `x-github-api-version`, `if-none-match`,
  `if-modified-since`. Everything else is dropped.
- `route_hint.owner`, `route_hint.repo`, and `route_hint.kind` are currently advisory.
  `route_hint.pr_head_sha` and closed/merged `route_hint.pr_state` are validated cache
  discriminators for PR file lists.
- `cache_key` and `idempotency_key` are accepted and currently advisory.

### Path validation

`path` must be an absolute GitHub API path. It is rejected (`400 invalid_path`) if it
contains `://`, `\`, `?`, `#`, `..`, a bare dot segment, or percent-encoded path
traversal (`%2e`, `%5c`). The relay only ever talks to `api.github.com`.

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
- Release routes are not relayed because authenticated draft visibility changes
  list, lookup, and not-found semantics.
- `cache` is `hit`, `miss`, or `bypass` (route not cacheable).
- `lease_reason` is `sticky`, `highest_remaining`, or `fallback` — see
  [Identities & routing](identities.md).

## Supported routes

Routes are classified in `src/policy.ts`. Only the following read-only shapes are
enabled; anything else returns `403 route_denied`:

- `pr_view`, `pr_files`, `pr_review_comments`, `pr_reviews`
- `pr_list`
- `commit_list`, `commit_view`, `commit_check_runs`, `commit_status`
- `run_list`, `run_view`, `run_jobs`, `run_artifacts`
- `job_view`, `job_logs`, `check_run_annotations`
- `issue_list`, `issue_view`, `issue_comments`, `issue_timeline`
- `branch_view`
- `repo_view`
- `workflow_list`, `workflow_view`
- `rate_limit`

`job_logs` is a large-payload, log-class route: it follows GitHub's signed redirect to
`*.actions.githubusercontent.com` / `*.blob.core.windows.net`, is not cached, and is
gated by the pool's `allow_logs` policy.

## Policy gates

`classifyRoute` enforces, per pool:

- `allowed_owners` — the route owner must be allowlisted, else `403 owner_denied`.
  Defaults to `DEFAULT_ALLOWED_OWNERS` (`openclaw`).
- `allow_logs` — log routes require it (default `true`), else `403 logs_denied`.
- `allow_search` — search routes require it (default `false`), else `403 search_denied`.

Every repo route additionally passes a public-visibility check before a pooled identity
or cache entry is used — see [Cache & public-repo guard](cache.md).

`route_hint.pr_head_sha` and `route_hint.pr_state` are validated, optional cache
discriminators for PR file lists. They do not bypass policy or visibility checks; they
only let clients that already know current PR state keep `/files` cache entries separate
across head SHAs or closed/merged state.

## Safety limits

- Redirects from `api.github.com` are denied (`502 github_redirect_denied`) except the
  log-download flow above.
- Response bodies are capped: 1 MiB default, up to `MAX_RESPONSE_BYTES` (2 MiB) for
  large-payload routes. Over-cap responses fail with `502 github_response_too_large`.
- Requests time out after `REQUEST_TIMEOUT_MS` (15s default).

## Audit

Every routed request — success or failure — writes an `audit_events` row with request
id, caller, pool, route key, route kind, identity id, status, error code, and duration.
Audit writes happen via `ctx.waitUntil` and never block the response.
