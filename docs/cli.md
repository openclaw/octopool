# Octopool CLI

The `octopool` Go CLI is the product entrypoint. It logs in against the relay, stores a
caller token locally, and acts as a drop-in `gh` shim for the read-only GitHub commands
Octopool supports — falling through to the real `gh` for everything else.

Source: `cmd/octopool/`.

The compiled-in default endpoint is `https://octopool.dev`. No config is required for
normal OpenClaw use, and self-hosted servers are selected at login time.

## Install modes

Install with Homebrew:

```sh
brew install openclaw/tap/octopool
```

Or install from source:

```sh
go install github.com/openclaw/octopool/cmd/octopool@latest
```

The binary inspects `argv[0]` and behaves as a `gh` shim when invoked as `gh` or
`octopool-gh`:

- `octopool gh ...` — explicit subcommand.
- symlink `octopool` as `gh` — transparent shim on `PATH`.
- symlink `octopool` as `octopool-gh` — side-by-side shim.

### `octopool install-shim [--shell zsh] [--dry-run]`

Installs the transparent `gh` shim for interactive, login, and non-interactive zsh
processes. The command:

- resolves and pins the real GitHub CLI as `OCTOPOOL_GH_PATH`, preventing fallback loops;
- creates an isolated `gh` symlink under `$XDG_DATA_HOME/octopool/bin` (or
  `~/.local/share/octopool/bin`);
- adds or replaces a clearly marked managed block in `$ZDOTDIR/.zshenv` (or
  `~/.zshenv`) so the shim directory stays first on `PATH`; and
- verifies the result with non-interactive `zsh -c` and login `zsh -lc` processes, failing
  when a later startup file shadows the shim.

Re-running the command is idempotent. Existing shell configuration outside the managed
block is preserved. `--dry-run` validates the plan and prints its paths without writing.
Only zsh is currently supported because it has a startup file that every interactive
and non-interactive invocation reads.

```sh
octopool install-shim --dry-run
octopool install-shim
zsh -c 'command -v gh'
```

## Commands

### `octopool login [server]`

Reads a local GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`), exchanges it
with `POST /v1/login/github-cli`, and saves the returned caller token. The server can be
passed as a positional argument, `--server`, or the older `--url` flag:

```sh
octopool login
octopool login https://octopool.your-org.dev
octopool login --server https://octopool.your-org.dev
octopool login --client build-mac
```

- If `gh auth token` fails, the CLI prints the exact real-`gh` web reauthentication and
  Octopool retry commands instead of returning only the subprocess exit status.
- The login URL must be HTTPS. `http://` is allowed only for loopback hosts, or when
  `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` is set for local development.
- The CLI fetches `GET /.well-known/octopool`, verifies `service: "octopool"`, uses the
  discovered `api_base`, and defaults to the discovered `default_pool` unless `--pool` is
  passed.
- If discovery points `api_base` at a different host, login fails unless
  `--trust-discovery-redirect` is passed. This keeps a mistyped or compromised discovery
  host from silently receiving your local GitHub token.
- The token is stored 0600 at `<user-config-dir>/octopool/auth.json` (URL, pool, token,
  login, client, timestamp).
- The default client name is the local hostname. `--client` overrides it; re-login rotates
  only that named client's caller token and leaves the user's other clients active.
  macOS `.local` suffixes are normalized away at login and audit time so the same host does
  not split usage across Bonjour and short hostname spellings.
- Each caller retains up to 16 named clients. Adding another retires the least recently
  updated session, which bounds abandoned hostname and ephemeral-runner credentials.
- Octopool validates the GitHub identity and OpenClaw org membership during login, and
  binds the caller by immutable GitHub user id. See [Auth](auth.md).
- Verified members of `ALLOWED_GITHUB_ORG` self-enroll into `DEFAULT_LOGIN_POOL`.
  Admin provisioning remains available for non-default pools and manual token issuance.

```sh
octopool login
# logged in to https://octopool.dev as steipete for pool maintainers from steipete-mbp
```

### `octopool whoami [--json]`

Prints the saved login target:

```sh
octopool whoami
# server: https://octopool.dev
# pool: maintainers
# login: steipete
# client: steipete-mbp
```

Use `--json` for scripts.

### `octopool gh api <GET path> [--paginate] [--slurp] [--jq <expr>]`

Relays a read-only `gh api` call through Octopool's cache and pool. Prints the GitHub
response body exactly like `gh api`, optionally piping it through `jq -r <expr>`.
GET reads using `--paginate` and `--slurp` stay relay-cached for up to 10 pages.
When present, GitHub's Link header authoritatively selects the next page; header-less
web-synthesized and legacy-cached responses fall back to array-length and `total_count`
shape heuristics. Longer result sets and unprovable header-less shapes fall through
to the real `gh` for a complete response.

```sh
octopool gh api repos/openclaw/openclaw/pulls/85341 --jq .number
# 85341
```

The exact `gh api user --jq .login` identity probe first validates the saved caller token
against Octopool's pool-health endpoint, then prints the saved login without spending GitHub
API or pooled-identity quota. Token/URL overrides, other projections, headers, queries, and
full user-profile reads retain the normal relay or real-`gh` behavior.

### `octopool gh pr|issue|run|repo|release ...`

The shim also handles common top-level GitHub CLI read commands by translating them to
safe relay routes:

```sh
octopool gh pr view 85341 -R openclaw/openclaw --json number,title,url
octopool gh pr view 85341 -R openclaw/openclaw --json number,files,commits,comments,reviews
octopool gh pr list -R openclaw/openclaw --state open --limit 20 --json number,title,url
octopool gh pr diff 85341 -R openclaw/openclaw --patch
octopool gh pr checks 85341 -R openclaw/openclaw --json name,state,bucket,link,workflow
octopool gh pr checks 85341 -R openclaw/openclaw --watch --fail-fast
octopool gh search issues cache regression -R openclaw/openclaw --state open --json number,title,url
octopool gh search prs rate limit -R openclaw/openclaw --state open --json number,title,url
octopool gh issue view 80490 -R openclaw/openclaw --json number,title,state,url
octopool gh issue list -R openclaw/openclaw --state open --label bug --limit 20 --json number,title,url
octopool gh run list -R openclaw/openclaw --branch main --limit 10 --json databaseId,workflowName,status,conclusion,url
octopool gh run view 26360397003 -R openclaw/openclaw --json databaseId,workflowName,status,conclusion,url
octopool gh run view 26360397003 -R openclaw/openclaw --json status,conclusion,jobs
octopool gh run watch 26360397003 -R openclaw/openclaw --exit-status
octopool gh repo view openclaw/openclaw --json nameWithOwner,defaultBranchRef,url
octopool gh workflow list -R openclaw/octopool --json id,name,path,state
octopool gh workflow view ci.yml -R openclaw/octopool --json id,name,path,state
octopool gh label list -R openclaw/octopool --json name,color,description
octopool gh gist view abc123 --json id,url,isPublic
octopool gh search repos octopool relay --json name,nameWithOwner,url
octopool gh release list -R openclaw/octopool --limit 10 --json tagName,name,url
octopool gh release view v0.3.0 -R openclaw/octopool --json tagName,name,url
octopool gh api repos/openclaw/octopool/contents/README.md?ref=main --jq .content
```

Top-level commands relay machine-readable `--json` shapes and selected non-interactive
human-format reads. Supported `--json` fields are intentionally conservative. Common
`gh` field names are mapped where the REST API uses different
names, such as `url`, `author`, `headRefName`, `headRefOid`, `baseRefName`,
`baseRefOid`, `isDraft`, `databaseId`, `workflowName`, and `nameWithOwner`.
Run views also support the nested `jobs` field; Octopool composes its job/step metadata from
the cache, exact API responses, or bounded public GitHub pages.
`gh search issues|prs` is translated to a repo-scoped, cacheable GitHub Search request
for the common plain-term `-R owner/repo --state ... --json ...` shape. Cache hits cost
zero GitHub Search quota. All supported search fields use the anonymous GitHub Search API;
this path remains available when pooled search is disabled and never uses a pooled identity
or local token. Qualified search syntax
such as `author:` or custom sort/match flags falls through to the real `gh`. PR search
supports the issue-like fields returned by GitHub Search; PR-list-only fields such as
`headRefName` fall through. Hydrated `gh pr view --json files,...` requests send the
verified PR head SHA, allowing file pages to share a five-minute state-scoped cache.
`gh pr checks` uses the shared cache throughout: its PR
head-SHA lookup sends `cache-control: max-age=60` so concurrent CI-polling sessions share
one upstream PR read at most 60 seconds old, and the check/status reads for that SHA use
the normal cache TTLs. Native `gh run watch` and `gh pr checks --watch` polling also stays
on the relay, floors intervals at 30 seconds, and backs off to 120 seconds. If the relay
explicitly returns `fallback_local` during an active watch, the shim prints one handoff
boundary and continues the original command with real `gh`; real `gh` then owns output and
the exact exit status. Its first snapshot may repeat the last relay-rendered state. Client-side
incompleteness, auth reinterpretation, transport/decode failures, and ordinary relay service
errors remain terminal after progress and do not spend local GitHub quota. Ask for raw `gh api`
conditional requests only when instant freshness matters more than quota.
`--jq` runs after `--json` filtering, matching the usual agent workflow for small
machine-readable reads.

#### Human-format reads

When stdout is not a terminal, the shim renders `pr view`, `pr checks`, `pr list`,
`run view`, `run list`, `issue view`, and `issue list` from the same relay-backed REST
responses used by their `--json` forms. Their supported flags, filters, required numeric
view identifiers, pagination bounds, and fallback behavior are identical to the existing
`--json` interception paths. Terminal stdout still delegates to the real `gh`, preserving
its interactive decoration. Unsupported presentation flags such as `--web`, `--comments`,
and `--template` also delegate.

The native output follows real `gh` 2.x non-terminal formatting with these REST-driven
differences:

- PR authors show the login only, without the display name lookup; PR projects are empty.
- PR reviewers come from the cached pull-review route, with each reviewer's latest state
  rendered in title case.
- Issue projects, issue type, parent, sub-issue counts, blocked-by, and blocking fields are
  empty because the REST issue payload does not provide them.
- Run-view headers use `<head branch> <workflow name>`, matching the verified GitHub run
  payload behind real `gh`; relative timestamps use coarse minute, hour, and day buckets.
- Run views render jobs and their failed steps only; real `gh`'s ANNOTATIONS and ARTIFACTS
  sections are omitted (those routes are not relay-backed), and the footer always points at
  the first job instead of varying by conclusion and job count. `--log-failed` and other log
  flags delegate to real `gh`.
- Enabled auto-merge renders as `enabled` without the enabling user and merge method.

All relay-controlled single-line text has terminal control characters removed. PR and
issue bodies preserve newlines and tabs while removing other control characters and
invalid UTF-8.

The command falls through to the real `gh` without contacting Octopool when any of these
hold:

- method is not `GET`, or mutating field flags are present (`-f`, `-F`, `--field`,
  `--raw-field`).
- a query key looks secret-bearing, or a header is outside the safe set
  (`accept`, `x-github-api-version`, `if-none-match`, `if-modified-since`).
- `--jq` was requested but `jq` is not installed.
- a top-level subcommand or flag is not one of the supported read-only shapes.

Safe read-shaped requests are sent to Octopool first. Octopool owns the route and pool
policy decision; on a cache miss it first uses token-free GitHub API/web/raw/Git endpoints
for supported public shapes, then the configured app/PAT identity pool, writes eligible
public responses to the shared cache, and returns the GitHub-shaped body. If the
server says the read should run locally — unsupported route, public pooling disabled by
policy, private/unverified repository, no usable identity, or identity pool depleted — the CLI
runs the original command with the real `gh` and your local GitHub token.

Pagination is fail-closed: if bounded relay pagination cannot prove a complete PR detail,
check set, or filtered issue list, the CLI delegates to real `gh` instead of returning a
partial result. Non-integer `--limit`/`-L` values are rejected explicitly.

Mutating and unsupported `gh` subcommands (`gh pr create`, unusual formatting flags, …)
are passed straight through to the real GitHub CLI, with their exit codes preserved.
`gh auth status` normally delegates too. For `gh auth status --active --hostname <host>`,
if GitHub's REST scope probe reports the active token as invalid while the same token still
authenticates through GraphQL, the shim reports the account as authenticated and warns that
reauthentication cannot restore REST quota. Broader multi-account status checks retain the
real CLI's exit status and output, with a diagnostic when the active token still passes the
GraphQL check.

`gh auth login --with-token` also stays delegated to the real CLI. If GitHub REST quota is
exhausted while `gh` validates token scopes, the shim keeps the nonzero exit status but verifies
the token through GraphQL and reports the core reset time. The token remains only in memory and
is not stored by Octopool; retry the same login command after reset instead of reauthorizing.

### `octopool health [--pool <id>]`

Fetches `GET /v1/pools/<pool>/health` using the stored token. Returns identity counts and
policy version.

### `octopool stats [--pool <id>] [--since 24h] [--client <name>] [--json]`

Fetches `GET /v1/pools/<pool>/stats` using the stored token. The default human output
shows the pool request count, service errors, expected local fallbacks, raw and
successful-eligible cache hit rates, coalesced duplicate misses, caller- and client-specific
usage, all of the caller's active client usage, D1 cache entries, and top route kinds.
When the server records backend attribution, it also ranks attributed upstream work by
route and bounded source (`github_web`, anonymous `github_api`, or `github_identity`) and
groups local delegation by fallback reason. No request bodies, query values, or credentials
enter these aggregates.
`--since` accepts `30m`, `24h`, or `7d` style windows, capped at 30 days.
`--client` filters `client_usage` and `client_routes` to that named client while retaining
the authenticated caller's scope. Human output identifies both the calling client and the
filter; JSON includes `client_filter` only when the filter is active.

```sh
octopool stats
# pool: maintainers
# client: steipete-mbp
# requests: 54 (1 service errors, 2 local fallbacks)
# cache: 82.4% hit (40 hits, 2 stale, 9 misses, 3 bypass, 0 unknown)
# eligible: 49/54 requests, 85.7% hit
# coalesced: 4 duplicate misses
# github: 42 saved, 12 backend
# this client: 38 requests, 31 saved, 7 backend
# top routes:
#   pr_view: 31 req, 86.1% eligible hit, 1 stale, 5 miss, 0 bypass, 0 errors, 1 fallback
# backends:
#   github_web / workflow_run_list: 12 req, 12 miss, 0 bypass, 0 revalidated
# fallback reasons:
#   identity_pool_depleted / contents: 1 req
# clients:
#   steipete-mbp: 38 req, 31 saved, 7 backend, 1 fallback
```

Use `--json` for dashboards or scripts that want the raw aggregate:

```sh
octopool stats --since 7d --json
```

Filter the client-specific aggregates without changing the calling client identity:

```sh
octopool stats -client ci-runner
```

### `octopool request --path <p> [--method GET] [--query k=v] [--header k=v] [--route-hint k=v]`

Debug/admin raw wrapper over `POST /v1/github/request`. Prints the full relay envelope.
`--route-hint pr_head_sha=<sha>` or `--route-hint pr_state=closed` can be used for
state-aware PR subresource cache probes.

### `octopool admin caller|identity ...`

Admin provisioning. Requires an admin token. See [Admin & provisioning](admin.md).

## Cache freshness

Shared cache hits are the point of the relay, but a cached answer describes the state at
fill time, not now. A PR read stays fresh for two minutes while the PR is open, so directly
after a `git push` the cached copy still reports the previous head SHA, and directly after a
merge it still reports the PR as open. Nothing about the response looks different, which is
how a stale answer gets read as current fact.

Three things keep that honest:

- **Gate fields read live.** `gh pr view --json` reads that include `headRefOid`,
  `baseRefOid`, `state`, `merged`, `mergedAt`, `mergeable`, `mergeStateStatus`, or
  `closedAt` send `cache-control: max-age=0` automatically. These are the values callers
  branch on, so they always come from GitHub. Descriptive fields (`title`, `body`, `labels`,
  `author`) stay cached.
- **Cached decision reads announce themselves.** When a PR, issue, run, or checks route is
  served from the shared cache, the CLI prints one line to stderr naming the route, whether
  it was a hit or a stale serve, and when it refreshes. stdout stays untouched, so `--json`
  and `--jq` consumers are unaffected. Silence it with `OCTOPOOL_QUIET_CACHE=1`.
- **Anything can be forced live.** `OCTOPOOL_FRESH=1` applies `max-age=0` to every relayed
  read, and `gh api -H "cache-control: max-age=0"` now relays instead of falling back to
  local `gh`, so a raw API read can be made live without spending your own token quota.

Note that `git push` never passes through Octopool, so the relay cannot invalidate a PR
entry when a branch moves. That is why the gate fields read live rather than relying on
invalidation.

## Token and URL safety

- A saved caller token is only sent to the saved Octopool URL. Overriding `--url` (or
  `OCTOPOOL_URL`) to a different host requires an explicit `OCTOPOOL_TOKEN`, or a fresh
  `octopool login` for that URL. This prevents leaking the token to an attacker-supplied
  endpoint.
- Once a request reaches Octopool, relay policy denials fail closed; they are not
  silently retried against the real `gh` unless Octopool returns the explicit
  `fallback_local` signal for a safe read.

## Environment variables

These are dev/CI escape hatches, not the everyday UX:

- `OCTOPOOL_URL` — base URL override.
- `OCTOPOOL_TOKEN` — caller token override (required to use a non-saved URL).
- `OCTOPOOL_POOL` — pool id (default `maintainers`).
- `OCTOPOOL_GH_PATH` — path to the real `gh` binary.
- `OCTOPOOL_FRESH=1` — send `cache-control: max-age=0` on every relayed read, so answers
  come from GitHub instead of the shared cache. Use it right after a `git push` or a merge,
  when a cached answer would still describe the previous state. Costs pool quota; leave it
  off for ordinary reads.
- `OCTOPOOL_QUIET_CACHE=1` — suppress the one-line stderr note printed when a
  decision-shaped route (PR/issue/run/checks) is served from the shared cache.
- `OCTOPOOL_NO_FALLBACK=1` — fail instead of running real `gh` after Octopool returns
  `fallback_local`, including during an active watch, useful for proving relay/cache coverage.
- `OCTOPOOL_RELAY_RETRIES` — how many times transient pool-exhaustion fallbacks
  (`identities_cooling_down`, `identity_pool_depleted`, `github_identity_depleted`,
  `github_rate_limited`, `relay_overloaded`), relay `5xx internal_error` responses, and
  malformed 502/503/504 gateway responses are retried against the relay (1s, then 3s for
  subsequent retries). Exhausted transient fallbacks may delegate to real `gh`; exhausted
  service errors remain failures instead of spending local GitHub quota. Default `2`; `0`
  disables retries.
- `OCTOPOOL_ADMIN_TOKEN` — admin token for `octopool admin`.
- `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` — permit non-HTTPS login for local dev.

## Server discovery

Self-hosted Octopool servers expose:

```http
GET /.well-known/octopool
```

Response shape:

```json
{
  "service": "octopool",
  "version": 1,
  "api_base": "https://octopool.your-org.dev",
  "app_base": "https://octopool.your-org.dev",
  "default_pool": "maintainers",
  "allowed_org": "your-org",
  "auth": {
    "cli_github_token": true,
    "web_login": true
  },
  "min_cli_version": "0.2.2"
}
```

`octopool.dev` advertises itself as the API base and `https://octopool.openclaw.ai` as
the browser app base. A one-domain self-host can use the same origin for both.
