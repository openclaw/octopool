# Octopool CLI

The `octopool` Go CLI is the product entrypoint. It logs in against the relay, stores a
caller token locally, and acts as a drop-in `gh` shim for the read-only GitHub commands
Octopool supports. Local GitHub writes and read fallbacks pass through the string rewrite
guard before the real `gh` runs.

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

Repository protection reads use guarded native fallback, retaining your existing GitHub
permissions and exact authenticated response shape. No protection response uses pooled
credentials or shared cache, even for a public repository:

```sh
octopool gh api repos/openclaw/openclaw/rules/branches/main --jq type
octopool gh api repos/openclaw/openclaw/rulesets --paginate
octopool gh api 'repos/openclaw/openclaw/rulesets/42?includes_parents=true'
octopool gh api repos/openclaw/openclaw/branches/feature%2Ftopic/protection
```

The [exact GET allowlist](relay.md#native-protection-reads) also covers documented
protection subresources. Supply literal owner/repo/branch values; encode a slash within
a branch as `%2F`. Decoded structural policy checks still apply. The Worker returns
`fallback_local` / `local_credentials_required` after its policy checks, and the CLI
fetches authoritative policy again before native dispatch. String-rewrite policy denial or
unavailability never permits fallback; `OCTOPOOL_NO_FALLBACK=1` rejects the handoff. This is read capability,
not a determination that a PR meets or fails a review requirement.

With active rules, these exact reads and their supported output flags use strict API
preparation, including GitHub.com host pinning. Safe unmodeled routes or flags retain the
[best-effort native filtering](#outbound-string-rewrite-protection) described below; they do not
become modeled protection reads merely because their path is similar.

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
`gh pr view --json state` returns the GraphQL lifecycle `OPEN`, `CLOSED`, or `MERGED`
regardless of the other requested fields or whether the relay uses a public page or REST.
Draft status is separate: an open draft has `state: "OPEN"` and `isDraft: true` when
requested. This conversion happens before field filtering and `--jq`; raw `gh api` REST
states, PR search states, and human-format `DRAFT` display remain unchanged.
`gh pr view --json mergeable` likewise returns a JSON enum string before filtering and
`--jq`: REST `true` becomes `"MERGEABLE"`, `false` becomes `"CONFLICTING"`, and null or
absent values become `"UNKNOWN"`. This uses only REST `mergeable`, not `mergeable_state`,
draft/lifecycle status, checks, or merge policy. Raw `gh api` REST reads retain their
boolean, null, or absent `mergeable` values. `mergeCommit` and `mergeStateStatus` remain
unsupported and delegate to real `gh`, including when requested alongside `mergeable`;
`gh pr list --json mergeable` also delegates.
Upgrade note: scripts relying on earlier Octopool boolean/null output must use explicit
enum comparisons. Replace `.mergeable == true` with `.mergeable == "MERGEABLE"` and
`.mergeable == false` with `.mergeable == "CONFLICTING"`; handle `"UNKNOWN"` separately.
Do not rely on truthiness: all three enum strings are truthy in `jq`.
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

After successfully fetching an explicit empty string rewrite policy (and finding no
local rules), the command retains its existing real-`gh` delegation when any of these hold:

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

With active string rewrite rules, modeled content, API, and lifecycle commands use strict
structural validation and immutable sanitized snapshots. An unmodeled native command or flag
no longer fails merely because Octopool does not recognize its shape: visible arguments,
explicitly declared JSON/text stdin, and `--input` files are filtered on a bounded best-effort basis before normal
real-`gh` delegation. Policy load/rewrite failures still block. Child exit codes and
stdout/stderr are preserved.
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

### `octopool admin caller|identity|string-rewrites ...`

Admin provisioning. Requires an admin token. See [Admin & provisioning](admin.md).

## Outbound string rewrite protection

Every protected `gh` command requires an Octopool login and a fresh authoritative policy
from `GET /v1/pools/<pool>/string-rewrites`. Each relay request and every final real-`gh`
dispatch checks policy; a fallback cannot reuse approval for different arguments. There is
no persistent policy cache, offline allowance, or fallback on authentication/policy errors.
Policy HTTP requests reject redirects, use a five-second deadline, and bound the response
to 65,536 bytes. Help/version and narrowly parsed GitHub authentication bootstrap commands
remain available without a policy.

The same strict JSON file configures server rules and optional local rules:

```json
{
  "schema_version": 1,
  "rules": [
    { "pattern": "\\binternal-model\\b", "replacement": "gpt-5.6-sol" },
    { "pattern": "\\binternal-family-[A-Za-z0-9_-]+\\b", "replacement": "" }
  ]
}
```

Local rules default to `string-rewrites.json` beside `auth.json`. Set
`OCTOPOOL_STRING_REWRITE_FILE` to select another file. An absent default is optional;
an explicitly configured missing or unreadable file fails closed. The local file is never
uploaded. Server rules run first, then local rules; identical entries are deduplicated,
conflicting replacements are rejected, and combined limits still apply.

Rules use a portable RE2 subset: literal Unicode, captures/noncapturing groups, alternation,
greedy/lazy repetition, bracket classes, dot, anchors, ASCII `\b`, `\w`, `\d`, `\s`
and their uppercase complements, escaped punctuation, and `\n`, `\r`, `\t`, `\f`,
`\a`, `\v`. Inline flags, lookaround, backreferences, named captures, Unicode properties,
POSIX named classes, octal/hex/Unicode escapes, `\C`, and quoted-literal extensions are
not accepted. Use literal Unicode characters instead of regex Unicode escapes. JSON
escapes are decoded normally; invalid UTF-8, unpaired surrogates, duplicate keys, unknown
fields, missing fields, and duplicate patterns are rejected.

Each rule replaces all matches once, in order. Replacements are literal (`$1` stays `$1`);
an empty replacement deletes text. A final scan checks every effective pattern again and
blocks remaining or newly created matches. Empty-string patterns are rejected at load time;
contextual zero-width matches abort before dispatch. Limits are 128 rules, 256 UTF-8 bytes
per pattern, 1,024 per replacement, 65,536 per policy document, and 1,048,576 bytes of
materialized/intermediate/final content. Match iteration is also bounded.

With active rules, the initial local publication vocabulary is deliberately conservative:

- PR/issue `create`, `edit`, `comment`, and PR `review`: explicit title/body flags, body
  files, or stdin; numeric PR/issue selectors for existing items. PR creation requires
  explicit `--head` and `--base`; the head must already be pushed. `--head` prevents gh
  from implicitly pushing or forking. Reviews require one explicit review action. PR/issue creation
  accepts one `--label`/`-l` and one `--assignee`/`-a` value (use comma-separated lists),
  while PR/issue edits accept metadata-only add/remove label and assignee flags. Assignees may
  include native `@me` or `@copilot`. PR create/comment also accept repeated `--attach`
  image/video files as described below.
- Release `create`/`edit`: explicit title/notes or notes files; one tag and no asset uploads.
  Creation requires `--verify-tag`, so gh cannot create a missing tag. Generated notes,
  notes from tags, and other implicit content sources are blocked.
- Raw REST API equivalents: allowlisted issue/PR/review/comment/release endpoints with
  `-f`/`--raw-field`, `-F`/`--field`, or `--input` JSON. Literal and typed fields retain
  their distinction; only typed `@file`/`@-` values read files/stdin. Nested review comments
  use `--input` JSON. Exact issue-assignee POSTs accept repeated raw `assignees[]` values;
  exact pull-request merge PUTs require only a full 40-hex `sha` and `merge_method: squash`.
  Other bracket accumulation, duplicate keys, mixed input/field sources, unknown properties,
  and custom authentication headers are rejected. Raw release creation first verifies the
  existing remote tag with a local authenticated GET.

Long flags accept separate or equal values; supported short value flags also accept
attached values. Repeated flags/aliases and boolean clusters are rejected. Metadata flags
not listed by the guard are unsupported; use an allowlisted raw REST shape where applicable.
Creation also rejects sanitized empty titles/bodies/notes to avoid implicit defaults.
Repository context is normalized and pinned into an explicit `owner/repo` after validation;
explicit `https://github.com/owner/repo` and GitHub SSH forms are accepted, while other hosts
are blocked. Input files are read into bounded snapshots, never modified, and never reopened
by the child. Sanitized snapshots use a private 0700 directory and 0600 files, removed
after execution, including nonzero exits. These modeled commands do not retain live stdin.

Protected PR create/comment commands accept up to 16 repeated `--attach FILE` or
`--attach=FILE` values. Raster image extensions are GIF, JPEG/JPG, PNG, and WebP; video
extensions are MOV, MP4, and WebM. Images are limited to 10 MiB each, videos to 100 MiB each,
and all attachments together to 100 MiB. The source path is structurally checked, optional
`#alt text` is rewritten, default image alt text remains based on the original filename, and
native `gh` receives suffix-preserving private byte-for-byte snapshots. Recognized inline
Markdown links/images that point at an attached local file are rewritten to the matching snapshot,
so native `gh` can preserve labels, alt text, titles, and normal upload-URL replacement. Up to 64
matched inline references are rewritten with bounded parser verification. Code spans remain literal;
matching reference-style definitions are blocked rather than published with broken paths. Empty
files, directories, other extensions, and video alt text are blocked. A new PR comment
may consist only of attachments. An `--edit-last` attachment update still requires an explicit body because
native `gh` would otherwise fetch and republish the existing text after the guard runs. Other
modeled body requirements stay unchanged. Attachment bytes are not text- or vision-inspected, so
callers remain responsible for reviewing the media itself before publication.

Commands and flags outside the modeled vocabulary use a bounded best-effort pass-through
instead of being denied solely for being new or unfamiliar. Octopool rewrites every visible
argument, snapshots and filters `--input` files or `--input=-`, snapshots typed
`-F`/`--field key=@source` text without changing its formatting, and filters stdin when the
command explicitly declares it (currently `workflow run --json`). Valid JSON request stdin/files are decoded recursively so string keys and values are rewritten
without corrupting JSON; other valid UTF-8 is rewritten as text. This keeps workflow
dispatches (`gh workflow run` field or `--json` forms), job-log reads, unmodeled uploads, and newly
introduced native flags working while active rules still remove visible matches. Native
children force `GH_HOST=github.com` and remove inherited `GH_REPO`; best-effort
`--repo`/`-R` values are structurally checked before rewriting and normalized to
`github.com/owner/repo`. Native `gh search` repository filters retain `owner/repo`, because the
CLI converts that value into a `repo:` search qualifier and rejects a host-qualified form.
Repo-capable commands without an explicit selector pin the current GitHub.com remote.
Alternate API/repository hosts, explicit credential headers,
unresolved API placeholders, invalid UTF-8, policy
material, residual matches, and bounded-read failures remain blocked.

Best effort is intentionally not the same guarantee as a modeled snapshot. Live terminal
input is passed through so native prompts still work, and deferred content sources other than
`--input` and typed field `@source` files—for example an editor, generated notes,
extension-owned files, or content native
`gh` derives after the guard—cannot be inspected. Direct real `gh`, browsers, Git pushes,
and deliberate encoding/obfuscation remain outside the boundary. Use a modeled command when
publication content needs the strict guarantee.

Modeled content paths also reject recognizable active rule material before rewriting
and in the final text: complete JSON objects with exactly string `pattern` and
`replacement` fields, whose decoded pattern equals an effective server or local pattern.
The replacement need not be identical. This covers copied policy files, compact or pretty
JSON, rule arrays, JSON Unicode escapes, and ordinary Markdown fenced snippets, including
inline text, files, stdin, and every decoded REST payload string. Fenced regions are scanned
with independent parser state so unrelated quoted prose cannot hide a complete rule object.
Detection is content-based, not filename-based, and stays within the existing 1 MiB limit.
Ordinary prose containing a forbidden term still undergoes normal rewriting; merely mentioning
regex source outside a recognizable JSON rule is not classified as policy material.

Reads check decoded path segments, query keys/values, and safe forwarded headers, including
bounded percent-decoding layers. Matches in structural values are blocked, never rewritten.
Active policy also rejects unresolved native-gh placeholders anywhere in the original
REST endpoint, including query keys/values and embedded `:owner`, `:repo`, or `:branch`
forms, before initial dispatch and every final delegation. Supply literal structural IDs.
The relay rejects literal TAB/LF/CR in paths before URL parsing and checks canonical final
outbound URLs and noncredential headers, including derived probes and followed redirects.
An encoded `%09` remains encoded on the wire; it is not treated as a stripped literal TAB.
This includes direct `octopool request` with local rules and approved local fallbacks.
Allowlisted top-level reads may fall back to native gh after Octopool pins and checks the
repository, numeric/ref selector, JSON field projection, filters, and composed request. This
covers readiness/CI projections, issue comment projections, and PR head filters whose fixed
GraphQL shapes are not representable by the relay. Numeric `pr ready` (or a checked
current/explicit nonnumeric Git branch) and metadata-only PR/issue edits with add/remove label
or assignee flags are also allowed without free-form text. Exact-head
`pr merge --squash --match-head-commit` is converted to the immediate pull-request merge REST
endpoint with only the checked SHA and squash method; it never enables auto-merge, so a branch
that requires a merge queue fails closed. Subject/body merge flags, admin/auto merge variants,
URL selectors, numeric inferred branches, and unpinned merges remain blocked on that strict
lifecycle path. Other editor/web/template/fill modes, unmodeled uploads, aliases/extensions, raw
GraphQL, and newly introduced native commands/flags use best-effort filtering and retain
native behavior. A denial reports only the generic unsafe-input boundary and never echoes the
rejected text.

Admin imports always fetch the current revision before the conditional update:

```sh
octopool admin string-rewrites status
octopool admin string-rewrites set --file rules.json
cat rules.json | octopool admin string-rewrites set --file - --if-revision 7
```

`--if-revision` additionally compares the operator's expected revision. A conflict never
overwrites a newer policy. Status and successful imports print only revision and rule count,
not patterns, replacements, matched content, or local paths.

Strict protection covers modeled traffic through this updated shim and relay, using the
policy snapshot checked before dispatch; unmodeled native commands receive the best-effort
filtering described above. Direct real `gh`, interactive/deferred native content, browsers,
Git pushes, older clients' local writes, existing published content, and arbitrary deliberate
obfuscation are outside this boundary. Policy-material detection does not interpret arbitrary Markdown, Unicode
obfuscation, malformed rule JSON, or arbitrary encodings, and is not general data-loss
prevention or a network-wide guarantee. GitHub writes continue to use the user's local credentials; the Worker
remains GET-only.

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
  branch on, so they require an upstream fetch or successful conditional revalidation.
  Descriptive fields (`title`, `body`, `labels`, `author`) stay cached.
- **Cached decision reads announce themselves.** When a PR, issue, run, or checks route is
  served from the shared cache, the CLI prints one line to stderr naming the route, whether
  it was a hit or a stale serve, and when it refreshes. stdout stays untouched, so `--json`
  and `--jq` consumers are unaffected. A stale response warns that it is unsafe for live
  decisions even under `OCTOPOOL_FRESH=1`; older relays may ignore the requested bound.
  A normal `hit` under FRESH remains quiet because it may have been live-revalidated.
  Silence cache notices with `OCTOPOOL_QUIET_CACHE=1`.
- **Anything can request a live read.** `OCTOPOOL_FRESH=1` applies `max-age=0` at shared
  relay request construction, including top-level `run view` and every jobs hydration
  request. An explicit `cache-control` header retains precedence, including headers
  passed through `gh api -H`. Every explicit age bound also applies during outages:
  `max-age=0` cannot return an unvalidated cached success. If upstream cannot satisfy the
  bound, the existing typed failure/local-fallback flow applies. Reads without an age
  bound retain the relay's route-limited stale outage fallback.

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
- `OCTOPOOL_STRING_REWRITE_FILE` — optional local policy JSON; an explicit unreadable or
  missing file fails closed. Defaults to `string-rewrites.json` beside `auth.json`.
- `OCTOPOOL_FRESH=1` — default every relayed read to `cache-control: max-age=0`, including
  run metadata and jobs; explicit cache-control headers take precedence. Use it right after
  a `git push` or a merge, when a cached answer could describe the previous state. It can
  cost API quota; leave it off for ordinary reads. Outage fallback cannot exceed the
  requested age bound.
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
