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

## Commands

### `octopool login [server]`

Reads a local GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`), exchanges it
with `POST /v1/login/github-cli`, and saves the returned caller token. The server can be
passed as a positional argument, `--server`, or the older `--url` flag:

```sh
octopool login
octopool login https://octopool.your-org.dev
octopool login --server https://octopool.your-org.dev
```

- The login URL must be HTTPS. `http://` is allowed only for loopback hosts, or when
  `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` is set for local development.
- The CLI fetches `GET /.well-known/octopool`, verifies `service: "octopool"`, uses the
  discovered `api_base`, and defaults to the discovered `default_pool` unless `--pool` is
  passed.
- If discovery points `api_base` at a different host, login fails unless
  `--trust-discovery-redirect` is passed. This keeps a mistyped or compromised discovery
  host from silently receiving your local GitHub token.
- The token is stored 0600 at `<user-config-dir>/octopool/auth.json` (URL, pool, token,
  login, timestamp).
- Octopool validates the GitHub identity and OpenClaw org membership during login, and
  binds the caller by immutable GitHub user id. See [Auth](auth.md).

```sh
octopool login
# logged in to https://octopool.dev as steipete for pool maintainers
```

### `octopool whoami [--json]`

Prints the saved login target:

```sh
octopool whoami
# server: https://octopool.dev
# pool: maintainers
# login: steipete
```

Use `--json` for scripts.

### `octopool gh api <GET path> [--jq <expr>]`

Relays a read-only `gh api` call through Octopool's cache and pool. Prints the GitHub
response body exactly like `gh api`, optionally piping it through `jq -r <expr>`.

```sh
octopool gh api repos/openclaw/openclaw/pulls/85341 --jq .number
# 85341
```

### `octopool gh pr|issue|run|repo ...`

The shim also handles common top-level GitHub CLI read commands by translating them to
safe relay routes:

```sh
octopool gh pr view 85341 -R openclaw/openclaw --json number,title,url
octopool gh pr list -R openclaw/openclaw --state open --limit 20 --json number,title,url
octopool gh pr diff 85341 -R openclaw/openclaw --patch
octopool gh pr checks 85341 -R openclaw/openclaw --json name,state,bucket,link,workflow
octopool gh issue view 80490 -R openclaw/openclaw --json number,title,state,url
octopool gh issue list -R openclaw/openclaw --state open --label bug --limit 20 --json number,title,url
octopool gh run list -R openclaw/openclaw --branch main --limit 10 --json databaseId,workflowName,status,conclusion,url
octopool gh run view 26360397003 -R openclaw/openclaw --json databaseId,workflowName,status,conclusion,url
octopool gh repo view openclaw/openclaw --json nameWithOwner,defaultBranchRef,url
```

Top-level commands are relayed only for machine-readable `--json` shapes; normal human
formatted commands stay on the real `gh`. Supported `--json` fields are intentionally
conservative. Common `gh` field names are mapped where the REST API uses different
names, such as `url`, `author`, `headRefName`, `headRefOid`, `baseRefName`,
`baseRefOid`, `isDraft`, `databaseId`, `workflowName`, and `nameWithOwner`.
`--jq` runs after `--json` filtering, matching the usual agent workflow for small
machine-readable reads.

The command falls through to the real `gh` without contacting Octopool when any of these
hold:

- method is not `GET`, or mutating field flags are present (`-f`, `-F`, `--field`,
  `--raw-field`, `--paginate`, `--slurp`).
- a query key looks secret-bearing, or a header is outside the safe set
  (`accept`, `x-github-api-version`, `if-none-match`, `if-modified-since`).
- `--jq` was requested but `jq` is not installed.
- a top-level subcommand or flag is not one of the supported read-only shapes.

Safe read-shaped requests are sent to Octopool first. Octopool owns the route and pool
policy decision; on a cache miss it uses the configured app/PAT identity pool, writes
eligible public responses to the shared cache, and returns the GitHub-shaped body. If the
server says the read should run locally — unsupported route, owner denied by pool policy,
private/unverified repository, no usable identity, or identity pool depleted — the CLI
runs the original command with the real `gh` and your local GitHub token.

Any other `gh` subcommand (`gh pr create`, `gh auth`, unusual formatting flags, …) is
passed straight through to the real GitHub CLI, with its exit code preserved.

### `octopool health [--pool <id>]`

Fetches `GET /v1/pools/<pool>/health` using the stored token. Returns identity counts and
policy version.

### `octopool stats [--pool <id>] [--since 24h] [--json]`

Fetches `GET /v1/pools/<pool>/stats` using the stored token. The default human output
shows the pool request count, cache hit rate, caller-specific usage, D1 cache entries,
and top route kinds. `--since` accepts `30m`, `24h`, or `7d` style windows, capped at 30
days.

```sh
octopool stats
# pool: maintainers
# cache: 82.4% hit (42 hits, 9 misses, 3 bypass, 0 unknown)
# cacheable: 51/54 requests
# top routes:
#   pr_view: 31 req, 86.1% hit, 0 errors
```

Use `--json` for dashboards or scripts that want the raw aggregate:

```sh
octopool stats --since 7d --json
```

### `octopool request --path <p> [--method GET] [--query k=v] [--header k=v]`

Debug/admin raw wrapper over `POST /v1/github/request`. Prints the full relay envelope.

### `octopool admin caller|identity ...`

Admin provisioning. Requires an admin token. See [Admin & provisioning](admin.md).

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
- `OCTOPOOL_NO_FALLBACK=1` — fail instead of running real `gh` after Octopool returns
  `fallback_local`, useful for proving relay/cache coverage.
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
