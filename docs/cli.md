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

Executable discovery follows symlinks and accepts regular `octopool` files, requiring
execute bits on Unix. On Windows it also recognizes `octopool.exe` case-insensitively
without requiring Unix execute bits. This recognition does not establish support for
the full zsh installer on native Windows.

```sh
octopool install-shim --dry-run
octopool install-shim
zsh -c 'command -v gh'
```

## Commands

### `octopool login [server]`

Reads a local GitHub.com token (`GH_TOKEN`, then `GITHUB_TOKEN`, then
`gh auth token --hostname github.com`), exchanges it with `POST /v1/login/github-cli`,
and saves the returned caller token. Native lookup always targets GitHub.com regardless
of `GH_HOST`; a missing or empty GitHub.com token fails login without falling back to
Enterprise credentials. The server can be passed as a positional argument, `--server`,
or the older `--url` flag:

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
- After discovery, the login exchange follows only same-origin HTTP redirects. Trusting
  a discovered `api_base` does not authorize later redirects to other origins.
- The token is stored 0600 at `<user-config-dir>/octopool/auth.json` (URL, pool, token,
  login, client, timestamp).
- The default client name is the local hostname. `--client` overrides it; re-login rotates
  only that named client's caller token and leaves the user's other clients active.
  All trailing `.local` suffixes are normalized away, case-insensitively, preserving base
  case (`Host.local.local` becomes `Host`, distinct from `host`). The default hostname is
  normalized then truncated to 80 characters; login normalizes that result again. Explicit
  `--client` values are never truncated and must satisfy the server's 1-80 character limit
  after normalization. `whoami` displays the saved login response; re-login updates an old
  saved spelling. An ambiguous historical client family returns `client_name_ambiguous`:
  ask an admin to review the conflicting credentials. Refusal leaves existing tokens valid.
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
response body exactly like `gh api`, optionally piping it through `jq -r -- <expr>`.
The expression is always a filter, never a jq command-line option.
On Windows, relay-backed `--jq` requires native jq 1.7 or newer and adds `--binary`
to retain native `gh` LF output terminators and preserve literal string bytes,
including embedded LF, CRLF, lone CR, and Unicode. Other platforms omit the Windows option.
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
octopool gh pr view 85341 -R openclaw/openclaw --json number,files
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

With active string protection, modeled `pr view`, `pr diff`, and non-watch `pr checks`
also accept checked branch selectors, including `feature/topic` and `owner:feature/topic`.
These use guarded native `gh`, not the numeric PR relay routes. Native owns branch lookup
(including open/merged/default-branch selection), JSON/jq output, and exit status. Repository
and branch material is checked, never rewritten to evade policy; the repository is pinned to
GitHub.com and policy is fetched again before native dispatch. Output flag occurrences and
the `--` delimiter retain their ownership.

An omitted selector resolves the current branch locally, honoring tracked `refs/pull/N/head`,
`@{push}`, and native push-remote/upstream-branch precedence, including fork-owner labels.
Contextual repository resolution honors `GH_REPO` or one configured `gh-resolved` default
(as set by `gh repo set-default`) first. Without either, modeled native reads have empty,
non-TTY stdin and use native noninteractive remote priority: `upstream`, then `github`, then
`origin`, then other names, case-insensitively. A single safe HTTPS GitHub.com origin needs
no default-repository setup. All candidates must pass GitHub.com HTTPS validation, and the
highest priority must have a unique remote; tied priorities fail closed rather than relying
on native's unspecified tie ordering. `GH_FORCE_TTY` affects output, not stdin, and cannot
enable prompting here. No interactive/network repository discovery runs during preparation.
Nonempty `--repo` still requires a selector, as in native `gh`.
Local Git context is converted to explicit checked selectors before dispatch, so later
checkout/config changes cannot select another repository or branch. Numeric tracking PRs
can retain numeric relay handling; ambiguous unqualified numeric _branches_ fail closed.
Detached/missing Git context, PR URL selectors, foreign hosts, SSH repository forms/host
aliases, multiple configured defaults or URL/config values, and unsupported ref shapes fail
closed on this modeled path. Use an explicit branch with `-R OWNER/REPO` when local context
cannot be proven. SSH remotes remain unsupported because native applies SSH-config URL
translation, which this guard does not inspect. Issue/run selector restrictions and PR
lifecycle-write rules are unchanged.

`gh pr view --json state` and `gh pr list --json state` return the GraphQL lifecycle
`OPEN`, `CLOSED`, or `MERGED` regardless of the other requested fields or whether the relay
uses a public page or REST.
Draft status is separate: an open draft has `state: "OPEN"` and `isDraft: true` when
requested. This conversion happens before field filtering and `--jq`, without changing
cached payloads, raw `gh api` REST states, or human-format `DRAFT` display.
`gh search prs --json state` and `gh search issues --json state` retain native lowercase
`open`/`closed` states and return `merged` when the result has a nonzero nested
`pull_request.merged_at` timestamp. Top-level `merged_at` and draft status do not change
search state. Search conversion also precedes field filtering and `--jq` and leaves raw
`gh api /search/issues` responses and cached payloads unchanged.
`gh issue view --json state` and `gh issue list --json state` return native `OPEN` or
`CLOSED` values across supported field subsets, including REST and public-page/cache
payloads. This conversion happens before field filtering and `--jq`, without changing
the cached representation. Raw `gh api` REST issue states remain lowercase; issue search
states and human-format output remain unchanged. Unsupported issue fields such as
`comments`, `closed`, and `stateReason` still delegate the entire request to real `gh`.
`gh pr view --json mergeable` likewise returns a JSON enum string before filtering and
`--jq`: REST `true` becomes `"MERGEABLE"`, `false` becomes `"CONFLICTING"`, and null or
absent values become `"UNKNOWN"`. This uses only REST `mergeable`, not `mergeable_state`,
draft/lifecycle status, checks, or merge policy. Raw `gh api` REST reads retain their
boolean, null, or absent `mergeable` values. `mergeCommit` and `mergeStateStatus` remain
unsupported and delegate to real `gh`, including when requested alongside `mergeable`;
`gh pr list --json mergeable` also delegates.
PR views also relay `headRepository`, `headRepositoryOwner`, `assignees`, and
`statusCheckRollup` to reduce local GitHub quota usage through shared transports and
eligible caching, including under active string rewrite protection. Fork metadata
uses GitHub node IDs; a deleted head repository is `null`. Requested author, owner, and assignee
names use a shared per-command profile lookup. The rollup preserves native `gh`
`CheckRun` and `StatusContext` fields and resolves workflow names by check-suite ID
through head-filtered Actions runs and the complete raw workflow catalogue, including
inactive workflows. It shares this verified association with `pr checks`, without using
run names, display titles, or body-supplied URLs. Check/status
pages and workflow lookups read live; after all hydration, a final live PR head check
rejects a moving head before any JSON is printed. A matching SHA is not an atomic
snapshot: checks can change on the same commit. Both `pr checks` and the rollup require
consistent page totals, unique upstream IDs, and complete pages, bounded to 1,000 items
per collection, including both Actions runs and the workflow catalogue. Missing or
ambiguous workflow associations and mismatched check/run heads also refuse projection.
Fork head repositories are supported. Inconsistent
or incomplete collections emit no partial JSON and follow the existing typed native
fallback, including fresh policy checks and host pinning under active rewrite rules.
`OCTOPOOL_NO_FALLBACK=1` keeps these cases as failures. Repeated JSON fields are accepted
and hydrated once.
Otherwise eligible machine-readable `gh pr view` requests selecting any of `commits`,
`comments`, or `reviews` hand the entire command to guarded native `gh` before any relay
data read. Native GraphQL export fields cannot be proven from REST projections of these
records. This includes mixed selections such as `--json number,files,commits`: native
`gh` owns the complete export, the literal JSON and jq arguments, and stdout/stderr;
Octopool does not hydrate a subset or run jq locally. The initial policy check and a
fresh final native-dispatch policy check still apply. `OCTOPOOL_NO_FALLBACK=1` blocks
this typed handoff with `unsupported_pr_detail_export`. Earlier direct-delegation cases
(such as unknown fields or flags, empty JSON selection, missing jq, or an unmodeled
selector) retain their existing guarded native behavior; this setting does not block
all unsupported grammar. Raw REST `gh api` reads of `/repos/OWNER/REPO/pulls/N/commits`,
`/repos/OWNER/REPO/issues/N/comments`, and `/repos/OWNER/REPO/pulls/N/reviews` remain
supported shared reads with unprojected REST shapes. Human PR review rendering is
unchanged. This boundary does not establish native parity for other nested exports.
For relayed PR-view exports, `author`, `labels`, and `files` use native JSON projections.
User authors export `id` (node ID), `is_bot`, `login`, and
`name`; bot authors use native `is_bot` and `app/…` login keys. Labels export node IDs,
names, descriptions (null becomes an empty string), and colors in upstream order.
Files export only `path`, `additions`, `deletions`, and `changeType`, including renames.
File change types use native enums; REST `removed` becomes `DELETED`. Unsupported or
missing statuses, including REST `unchanged` with no native enum, follow guarded
fallback before any JSON is printed.
Upgrade note: PR-view scripts using numeric author/label IDs, REST-only nested keys,
lowercase file statuses, or `originalPath` must use these native projections instead.
Upgrade note: scripts relying on earlier Octopool boolean/null output must use explicit
enum comparisons. Replace `.mergeable == true` with `.mergeable == "MERGEABLE"` and
`.mergeable == false` with `.mergeable == "CONFLICTING"`; handle `"UNKNOWN"` separately.
Do not rely on truthiness: all three enum strings are truthy in `jq`.
Machine `gh run list/view --json` exports use canonical, unshaped REST reads through the
shared cache, not public-page reconstructions. Human run lists/views and watch retain their
page-backed paths. The existing 13 list and 15 view fields are unchanged. Run `name` is the
REST run name; `workflowName` comes only from real workflow metadata, never from `name`.
Missing/null ordinary strings become empty strings, and timestamps use native parsed time
defaults. Jobs always have eight keys and steps six, with non-null arrays in acquisition
order. Only job/step completion times normalize zero instants; other timestamp offsets
and fractional seconds retain native `time.Time` behavior.

Run views also support `jobs`: one canonical returned-attempt page of 100, requiring a
present valid total, exact cardinality, positive unique IDs, and no remaining next link.
More than 100 jobs requires guarded whole-command fallback, not truncation. Requested
nonzero `--attempt` qualifies the output URL; returned `run_attempt` owns JSON `attempt`
and the canonical jobs route, including reused successes from older attempts. Historical
run identity/head evidence is checked without fetching today's branch head.

Only selected `workflowName` triggers metadata. View uses one verified workflow-ID lookup;
filtered lists use one verified numeric/YAML-selector lookup. Nonempty unfiltered lists use
the existing complete catalogue (at most 10 pages of 100), then one memoized direct lookup
per missing workflow ID. Only a genuine upstream 404 on that last list-specific lookup
produces an empty name. Disabled workflows remain valid. Empty lists and unselected names
do not fetch metadata. Logical data-operation bounds are 1 for scalar view, 2 with name,
3 with jobs and name, 2 for filtered list with name, and 111 for unfiltered list with name.
These exclude policy/transport retries. List responses may not exceed their effective
requested limit (default 20, maximum 100); every read retains relay policy and freshness.

Observed native integers outside ±(2^53−1), or unproved identity/collection shapes, use
typed `unsupported_run_export` fallback before JSON or jq output, respecting `NO_FALLBACK`.
The JS service may already have erased numeric or duplicate-key distinctions: this is not
a lossless upstream transport guarantee. Malformed native fields and contradictory
identities remain terminal errors, even for unselected modeled fields. Existing attempt,
job-total, pagination and catalogue refusal reasons remain distinct. Exports buffer all
validation/hydration before output; successful JSON commands return success independently
of run conclusion. Downstream writer/jq errors still fail and cannot be rolled back.
`gh search issues|prs` is translated to a repo-scoped, cacheable GitHub Search request
for the common plain-term `-R owner/repo --state ... --json ...` shape. Cache hits cost
zero GitHub Search quota. All supported search fields use the anonymous GitHub Search API;
this path remains available when pooled search is disabled and never uses a pooled identity
or local token. Qualified search syntax
such as `author:` or custom sort/match flags falls through to the real `gh`. PR search
supports the issue-like fields returned by GitHub Search; PR-list-only fields such as
`headRefName` fall through. Hydrated `gh pr view --json files,...` requests send the
verified PR head SHA, allowing file pages to share a five-minute state-scoped cache.
`gh pr checks` uses the shared cache throughout ordinary acquisition: its PR
head-SHA lookup sends `cache-control: max-age=60` so concurrent CI-polling sessions share
one upstream PR read at most 60 seconds old, and the check/status reads for that SHA use
the normal cache TTLs, as do its raw Actions metadata reads. Each collection is bounded
to 10 pages of 100 entries. Ordinary acquisition uses at most 41 logical data operations,
or 21 without Actions associations; an actual empty result takes 3. These are not limits
on policy reads, transport attempts, retries, or an entire watch session. Every data
operation retains authoritative policy checks through the relay client.

Successful nonempty `pr checks --json` / `--jq` exports return 0 regardless of check
outcomes; export or writer errors still fail. An empty result fails before any JSON or
jq output, with `no checks reported on the '<head branch>' branch` on stderr and exit 1.
Human and watch output instead return 1 for failed checks, otherwise 8 for pending
checks, otherwise 0; cancellation and skipping alone do not fail. `NEUTRAL` maps to
`skipping`. Legacy status descriptions are preserved; check summaries are not descriptions.
Legacy statuses and missing/null check timestamps export zero times. Malformed nonempty
check timestamps use guarded fallback before output.

Checks are deduplicated before field selection by descending start time, using the native
slash-joined check name/workflow/event key and a separate status-context namespace.
Equal starts have no promised winner; creation time and numeric ID are not tiebreakers.
JSON retains that aggregation order, not human-table presentation order.
Native `gh run watch` and `gh pr checks --watch` polling also stays
on the relay, floors intervals at 30 seconds, and backs off to 120 seconds.

Supported `gh run watch` commands keep polling on the relay, including under active rewrite
rules. Relay failures, including
`fallback_local` for pagination or exhausted pool retries, stop the watch with an error;
they never start a personal-token watcher. This applies to the initial read, later polls,
fresh completion confirmation, and final job hydration. Jobs are fetched only after a fresh
completed run response, using its exact `run_attempt`. Missing or inconsistent job metadata
fails explicitly without printing a partial job summary or a successful completion message.
Job IDs must be positive, unique across all pages, and within the relay's safe-integer
range. Supplied `run_id` and nonempty `head_sha` must match the owning run; optional
ownership fields may be absent from public-page-derived jobs. Human run views validate
the same job identities before rendering, retaining their guarded fallback on invalid data.
Octopool preserves the job set returned for that attempt, including reused successes when
present, and does not reconstruct missing jobs from earlier attempts. With complete data,
`--exit-status` returns 1 for a non-successful run; without it, a completed run returns 0.
Read failures return nonzero with or without `--exit-status`. Unsupported command shapes
still delegate, and an explicit `repo_not_public` refusal on the initial run lookup retains
guarded native fallback. A refusal after watch progress never hands off.

For `gh pr checks --watch`, an explicit relay `fallback_local` after progress still prints a
handoff boundary and continues the command with real `gh`, which owns output and exit status.
Its first snapshot may repeat the last relay-rendered state. Client-side incompleteness,
auth, transport/decode failures, and ordinary relay service errors remain terminal after
progress and do not spend local GitHub quota. Cached empty checks are revalidated live.
Terminal confirmation reacquires every check, status, run, and workflow page with
`max-age=0`, builds fresh associations, then reads the PR head live again after hydration.
A changed head cannot confirm completion; a matching head still does not make same-commit
check changes atomic. This extra live read is part of each terminal confirmation attempt,
not the ordinary 41-operation bound. Active rewrite policy retains the existing
pre-handler delegation of checks-watch commands. Ask for raw `gh api`
conditional requests only when instant freshness matters more than quota.
`--jq` runs after `--json` filtering, matching the usual agent workflow for small
machine-readable reads.

#### Read-option occurrences and delegation

Modeled read flags use their command's value types. Each `--json` occurrence is a
CSV record: quotes and doubled quotes are decoded, spaces and empty elements are
significant, and only the first record is read (with normal CSV CRLF handling).
An empty raw value contributes no fields. Repeated occurrences append; valid fields
are deduplicated in first-occurrence order before hydration. Malformed or unsupported
earlier fields cannot disappear into a partial relay request. Explicit `--json=` with
no effective fields delegates, never selects human output. `--json number --json=`
still selects `number`. The last `--jq` program wins, including an empty program;
even an empty `--jq` without `--json` delegates on top-level commands. API jq needs
no JSON flag. Short `-q=` retains the native literal `=` value or delegates intact.
Already-declared `-R`, `-L`, and `-q` aliases accept attached values such as
`-Rowner/repo`, `-L5`, and `-q.number`, including under active rewrite policy;
native handoff preserves those spellings. This does not add short-flag clusters.

Issue-list labels use the same CSV occurrence rules. An empty effective sequence
omits the labels query key. Decoded labels containing commas, empty elements, or
line breaks delegate because the existing REST query cannot preserve them. Spaces
and literal quotes remain supported. Ordinary repo, author, assignee, and jq flags
are scalars, not CSV. Search repo filters are slices but multiple occurrences or
multiple decoded repositories remain native-only. Unsupported filters remain
unsupported even when empty. Search label filters retain typed local fallback,
including labels that the issue-list REST query cannot represent, so
`OCTOPOOL_NO_FALLBACK` still blocks that native dispatch. API fields/headers stay
literal repeated values;
`workflow run --json` stays Boolean. The documented workflow/gist view JSON
extensions are unchanged.

Every limit or interval assignment must pass native signed base-0 integer syntax,
including prefixes, signs, underscores, and overflow checks. Only the final limit
gets the command range check: at least 1 for lists, and 1–1000 for search. Values
above the relay's 100-item bound delegate rather than being clamped into eligibility.
A final limit outside the platform's native integer representation delegates before conversion or command-range checks.
Enum assignments are checked individually, case-insensitively; PR/issue list state
is normalized, but run status spelling is preserved and unsupported spellings
delegate. Run-view attempts use unsigned 64-bit syntax without signs: zero selects
the latest run path, and values beyond the CLI's signed representation delegate
before conversion. Jobs still belong to the returned run attempt.

Watch durations must be representable before multiplication and the 30-second
floor. An earlier int-valid duration can be overridden; an invalid integer cannot.
A final unrepresentable run-watch duration delegates so native lookup and
early-completion timing remain native-owned. Delegation changes only the effective
valid interval (or inserts a proved default before a real `--` terminator), never
discarded intervals, another flag's value, or unknown grammar.
With no active rewrite rules, native PR-checks watch handoff recognizes `-w=false`
and `-w=0` as disabled web mode and keeps the watch floor. The `-w` spelling remains
native-only; short clusters and invalid Boolean assignments are left intact.

Protected native watches apply that floor only after fresh final-policy preparation
has inspected the original interval occurrences, retaining any repository already
pinned before a relay handoff. Active-policy PR checks-watch still delegates before
the handler. Both the input and prepared command must be recognized watches with
corresponding option/value, positional, and terminator ownership, apart from checked
repository pins. A valid policy rewrite from interval 5 to 40 stays 40; invalid
input rewritten into valid grammar, changed commands or option ownership, and unknown
grammar retain their policy-prepared argv without a guessed floor. Generated interval
values and emitted tokens must also satisfy that final policy; a conflict blocks the
child rather than bypassing policy or rewriting the floor below 30 seconds.

These parsers run after the existing policy check. Active rules still inspect
original occurrences and structural material, even overwritten scalars or CSV
records ignored by decoding. Native argv retains spelling and order except for
necessary repository/host pins and the effective watch floor; decoded CSV is never
joined back into native arguments. Relay attempts and final native dispatch acquire
policy again. The guarded `repo view` pin is positional, including when resolved
from context or supplied with the shim's repo option; native `repo view` has no
`--repo` flag. Publication duplicate restrictions and typed-fallback
`OCTOPOOL_NO_FALLBACK` behavior are unchanged; direct unsupported-shape delegation
remains protected native dispatch, not a universal no-fallback opt-out.

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

Non-TTY `pr checks` uses the native checks-only table comparator, separately from JSON.
Cancellation displays as `fail` while retaining its successful cancellation-only exit.
Elapsed values display `0` when absent or nonpositive, and Go durations (including
fractional seconds) otherwise. Watch retains Octopool's terse transition/final output.

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

Client filters and client groups use the same suffix policy for both current and historical
audit labels. These are derived labels, not proof that credentials or physical machines
were reconciled; stored audit names and caller/token links remain unchanged.

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
to 65,536 bytes. Empty invocations, singleton help/version, known built-in topic help,
and narrowly parsed GitHub authentication bootstrap commands remain available without a policy.

Topic help accepts exactly `help <topic>`, `<topic> --help`, or `<topic> -h` for these
built-in paths:

- Roots: `api`, `pr`, `issue`, `release`, `auth`, `status`.
- PR: `pr create|edit|comment|review|view|list|status|merge|ready`.
- Issue: `issue create|edit|comment|view|list|status`.
- Release: `release create|edit|view|list`.
- Auth: `auth login|status`, using long `--help` or `help <topic>` only.

For example, `gh pr merge --help`, `gh pr ready -h`, and `gh help pr merge` do not
require policy access. `auth login -h` and `auth status -h` require a hostname value;
`auth login -h github.com` and `auth status -h github.com` retain their narrow auth
bootstrap route. Parent `auth -h` is help. Aliases, extension names, additional topics,
operands, and options (including extended help spellings) follow ordinary policy and
input protection. A value spelled `--help`, such as `--body-file --help`, still belongs
to its input flag.

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

Policy-load failures keep the existing message prefix and add bounded diagnostics to the
normal stderr error line. There is no success diagnostic, stdout change, persistent log,
automatic policy retry, or cached-policy fallback. A synthetic example:

```text
error: string rewrite policy unavailable or invalid (class=http_status attempt_utc=2026-09-01T12:34:56.123Z elapsed_ms=42 http_status=403 cf_ray=0123456789abcdef-SJC)
```

The fixed `class` identifies the failing check, not its underlying cause:

| Class                  | Meaning                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`                | Caller client setup failed, including saved-auth loading, missing login, or saved-token URL binding. No policy request occurred.                                            |
| `request`              | Policy URL, blank token, or HTTP request construction failed validation.                                                                                                    |
| `transport`            | HTTP execution failed without a response, including DNS/network errors not classified below.                                                                                |
| `timeout` / `canceled` | HTTP execution reported a deadline/network timeout or context cancellation, respectively.                                                                                   |
| `http_status`          | The policy HTTP response was not exactly 200; redirects, including same-origin redirects, are refused.                                                                      |
| `response_read`        | Reading the 200 response body failed (including a timeout/cancellation while reading it).                                                                                   |
| `response_size`        | The 200 response exceeded the 65,536-byte document limit.                                                                                                                   |
| `server_validation`    | The 200 document failed JSON/schema/rule validation.                                                                                                                        |
| `local_read`           | Local path resolution or bounded file reading failed, including an explicit missing, unreadable, nonregular, or oversized file. An absent optional default remains allowed. |
| `local_validation`     | Local JSON/schema/rule validation failed.                                                                                                                                   |
| `merge`                | Combining individually valid server/local policies failed conflict or combined-limit checks.                                                                                |

`attempt_utc` is the client clock's UTC start time, before policy HTTP validation.
`elapsed_ms` is monotonic elapsed time from that start to failure construction, truncated
to whole milliseconds. It includes GET/body reading and any subsequent server/local/merge
checks reached, but excludes caller client setup and final stderr formatting. For `setup`
only, both fields instead cover client setup. They do not measure a whole `gh` invocation;
each guarded boundary reloads policy and starts another attempt. The existing five-second
context and HTTP-client deadlines are unchanged, and do not bound later local/merge work.

`http_status` is omitted without an observed response. For `server_validation`, `local_read`,
`local_validation`, or `merge`, `http_status=200` belongs to the preceding policy **GET**,
not to local validation. Its correlation metadata survives those later failures. Optional
`cf_ray` accepts only one value with exactly 16 ASCII hex digits, optionally followed by
`-` and three uppercase ASCII POP letters. Missing, malformed, overlong, or multiple values
are dropped, never truncated. It is an unauthenticated correlation hint, not proof of origin.
No raw error strings, URLs, paths, bodies, arbitrary headers, tokens, or rule content are
included. Admin HTTP 409 remains a revision conflict; guarded caller GET 409 is a terminal
policy failure. See [policy-failure correlation](operations.md#correlating-policy-load-failures)
before drawing conclusions from a later successful probe.

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
  files, or stdin; numeric PR/issue selectors for existing items. PR creation pins
  `--head` to the current branch when the flag is omitted (detached HEAD and non-git
  directories are blocked); the head must already be pushed, since a pinned `--head`
  prevents gh from implicitly pushing or forking. `--base` is optional and defaults to
  the repository's default branch. `--dry-run` is accepted. Reviews require one
  explicit review action. PR/issue creation
  accepts one `--label`/`-l` and one `--assignee`/`-a` value (use comma-separated lists),
  while PR/issue edits accept metadata-only add/remove label and assignee flags. Assignees may
  include native `@me` or `@copilot`. PR/issue create/edit/comment also accept repeated
  `--attach` image/video files as described below.
- Release `create`/`edit`: explicit title/notes or notes files and one tag.
  Creation requires `--verify-tag`, so gh cannot create a missing tag. Generated notes,
  notes from tags, and other implicit content sources are blocked. Asset-bearing creation
  additionally requires explicit `--draft=true` (or `--draft`) and unchanged metadata,
  as described below. Release editing still accepts exactly one tag and no assets.
- Raw REST API equivalents: allowlisted issue/PR/review/comment/release endpoints with
  `-f`/`--raw-field`, `-F`/`--field`, or `--input` JSON. Literal and typed fields retain
  their distinction; only typed `@file`/`@-` values read files/stdin. Nested review comments
  use `--input` JSON. Exact issue-assignee POSTs accept repeated raw `assignees[]` values;
  exact pull-request merge PUTs require a full 40-hex `sha` and `merge_method: squash`,
  with optional rewritten `commit_message` and `commit_title` strings.
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

With active rules, `gh release create TAG --repo OWNER/REPO --draft --verify-tag
--title TITLE --notes-file NOTES FILE...` accepts up to 16 explicit local asset paths
on macOS, Linux, and Windows. Each asset must be a nonempty regular file, at most 1 GiB;
the aggregate asset limit is 4 GiB. Public basenames are limited to 255 bytes and use
only ASCII letters, digits, internal periods, underscores, and hyphens. A basename
cannot start with a period or hyphen, or end with a period; a leading underscore is
allowed. Empty and Windows reserved names remain rejected. GitHub
[documents filename rewriting during asset uploads](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#upload-a-release-asset)
without specifying a complete normalization algorithm. This is Octopool's conservative
supported subset; other public names are rejected rather than silently sanitized.
The existing 1 MiB text budget remains unchanged. Title, notes, original/resolved source
paths, and exact public basenames undergo policy, material, residual, and UTF-8 checks;
if filtering would change any of them, the entire command is rejected. Canonical notes
are preserved byte for byte. Assetless release creation retains its existing filtering.

Asset operands cannot be stdin, URLs, unexpanded globs, `#label` forms, traversal paths,
symlinks, Windows UNC/device paths, or unsafe portable filenames (including control
characters, Windows reserved names, and trailing dots/spaces). Public-name restrictions
apply to the original basename before filesystem access. Source components have separate
validation: `.claude`, spaces, Unicode, and leading hyphens are allowed in parent
directories and private staging paths, subject to the existing path and policy checks.
Duplicate basenames, case-fold collisions, hard links to the same file, and resource-limit
violations are rejected. Parent directory aliases such as macOS `/tmp` are resolved and checked;
Windows reparse points, including ancestor reparse points, are rejected.

Generated release asset paths undergo the same literal-operand validation as source
operands, in addition to policy checks. A temp-root path containing `#` or glob syntax
therefore blocks asset-bearing creation and cleans up staging before native `gh` starts:
[`gh release create` interprets asset operands as filenames/patterns with optional `#label` syntax](https://cli.github.com/manual/gh_release_create).
Ordinary metadata snapshots use filesystem paths rather than release operand syntax;
legal `#` or bracket characters in a private temp directory remain supported there.
Windows shared staging still enforces local filesystem, device, traversal, reparse,
handle-pinning and private ACL checks. Hidden, space-bearing and Unicode temp directories
remain supported for release assets when their paths contain no release operand syntax.

Every asset is copied in 64 KiB chunks into exclusively created private snapshot files
before native `gh` starts, preserving names, order, and opaque bytes. Descriptor identity
and before/after file metadata reject observed replacement, size changes, or in-place
mutation. Unix opens do not follow symlink operands and cannot block on a substituted
FIFO. Windows requires persistent filesystem ACLs, creates staging with a protected
current-user-only inheritable ACL, pins directory handles against deletion, and excludes
source write/delete sharing while capturing. Cancellation is checked between chunks and
before execution. Snapshots are removed on preparation/start/child failures and handled
cancellation; uncatchable termination and power loss can leave temporary files behind.

Assets, including checksums and provenance, are opaque: Octopool does not rewrite,
unpack, rebuild, sign, or certify their contents as secret-free. The caller owns artifact
review, provenance, and a reviewed, frozen source directory. Staging isolates subsequent
source changes; metadata checks cannot prove correspondence with earlier verification
against arbitrary hostile local writers before capture. There is no digest handoff.
Local preparation is all-or-nothing, but remote draft creation and upload are not a
transaction. A failed child can leave a partial remote draft. Octopool does not delete
drafts, replace assets, clobber, retry uploads, or publish after failure. This capability
does not add modeled standalone `release upload` support or new release-edit forms.

Protected PR/issue create/edit/comment commands accept up to 16 repeated `--attach FILE`
or `--attach=FILE` values. Raster image extensions are GIF, JPEG/JPG, PNG, and WebP; video
extensions are MOV, MP4, and WebM. Images are limited to 10 MiB each, videos to 100 MiB each,
and all attachments together to 100 MiB. The source path is structurally checked, optional
`#alt text` is rewritten, default image alt text remains based on the original filename, and
native `gh` receives suffix-preserving private byte-for-byte snapshots. Recognized inline
Markdown links/images that point at an attached local file are rewritten to the matching snapshot,
so native `gh` can preserve labels, alt text, titles, and normal upload-URL replacement. Up to 64
matched inline references are rewritten with bounded parser verification. Code spans remain literal;
matching reference-style definitions are blocked rather than published with broken paths. Empty
files, directories, other extensions, and video alt text are blocked. A new PR/issue comment
may consist only of attachments, including with `--edit-last=false`. PR/issue edits with attachments
and PR/issue comment `--edit-last` (or `--edit-last=true`) attachment updates require an explicit
complete `--body` or `--body-file`, including when `--create-if-none` is set, because native `gh`
would otherwise fetch and republish existing text after the guard runs. Title or metadata flags do
not satisfy this requirement for PR/issue edits. PR/issue edits allow an explicitly supplied empty
body after inspection. Other
modeled body requirements stay unchanged; issue creation still requires an explicit title and body.
Attachment bytes are not text- or vision-inspected, so callers remain responsible for reviewing
the media itself before publication.

Commands and flags outside the modeled vocabulary use a bounded best-effort pass-through
instead of being denied solely for being new or unfamiliar. Octopool rewrites every visible
argument, snapshots and filters `--input` files or `--input=-`, snapshots typed
`-F`/`--field key=@source` text without changing its formatting, and filters stdin when the
command explicitly declares it (currently `workflow run --json`). Nonempty declared JSON
must pass strict UTF-8, surrogate, decoded duplicate-key, single-value, and depth validation;
malformed JSON never falls back to text. Decoded string keys and values are rewritten and
the final JSON is bounded again. This keeps workflow dispatches, job-log reads, unmodeled
uploads, and newly introduced native flags working within the declared-input boundary. Native
children force `GH_HOST=github.com` and remove inherited `GH_REPO`; best-effort
`--repo`/`-R` values are structurally checked before rewriting and normalized to
`github.com/owner/repo`. Native `gh search` repository filters retain `owner/repo`, because the
CLI converts that value into a `repo:` search qualifier and rejects a host-qualified form.
Repo-capable commands without an explicit selector pin the current GitHub.com remote.
Alternate API/repository hosts, explicit credential headers,
unresolved API placeholders, invalid UTF-8, policy
material, residual matches, and bounded-read failures remain blocked.

For native `gh api --input`, a missing or empty effective `Content-Type` defaults to JSON;
explicit JSON and `+json` media types also require strict JSON. A valid explicit non-JSON
Content-Type keeps bounded UTF-8 text filtering without JSON reformatting, including
JSON-looking text. Content-Type is a native capability, not an additional relay header.
Repeated headers follow native `Header.Add` order: an empty first Content-Type selects the
native JSON default; otherwise declarations must be equivalent, and conflicting or malformed
media types block. Exactly zero-byte best-effort input retains native no-input compatibility;
whitespace-only declared JSON blocks. Modeled API empty-body rules remain unchanged.

Workflow JSON flags accept native Boolean spellings (`1/t/T/true/TRUE/True` and
`0/f/F/false/FALSE/False`), validate every occurrence, and use the final assignment.
Bare `--json` means true; `--json false` includes a positional `false`. Absent or final-false
JSON flags do not cause preparation to read idle stdin. True workflow help also leaves
JSON stdin unread; native short `-h` requests help immediately, while long `--help` uses
its final Boolean assignment. Known API `-i` bundles preserve each include option and the
following value-taking flag. Parser metadata never adds synthetic flag names or default
values to the text being rewritten. Known option values retain their ownership, including
flag-looking values and interleaved repository options. A real `--`
ends declarations: subsequent arguments are visible text, not file/stdin sources or headers.
Generated repository/hostname pins precede that delimiter.

Original sources are captured before argument rewriting, and newly introduced sources are
captured afterward. The stricter original/final JSON declaration applies to captured bytes;
rewriting cannot downgrade inspection or reopen a substituted original path. Typed field
sources remain literal text, and raw fields remain literal arguments. Only other commands'
undeclared input retains the previous opportunistic JSON-or-text handling. These checks do
not infer formats from filenames, endpoints, or bytes, decode nested obfuscation, or protect
against downstream reinterpretation of deliberately mislabeled text. Binary API input has
no exemption from UTF-8 validation. The existing 1 MiB content and aggregate budgets apply.

For `gh repo clone`, positional repository checks apply only to the source, accounting for
native clone options and their values. A `--` ends native option parsing; if the source has
not appeared yet, the next argument is still the source. Unknown options before the source
fail closed. Source protocol is preserved, with structural and GitHub.com host validation
before and after rewriting. Destination paths and forwarded Git flags and values still
receive visible-argument filtering without being treated as additional repository inputs.

Best effort is intentionally not the same guarantee as a modeled snapshot. Live terminal
input is passed through so native prompts still work, and deferred content sources other than
`--input` and typed field `@source` files—for example an editor, generated notes,
extension-owned files, or content native
`gh` derives after the guard—cannot be inspected. Direct real `gh`, browsers, Git pushes,
and deliberate encoding/obfuscation remain outside the boundary. Use a modeled command when
publication content needs the strict guarantee. Reads are byte-bounded, not time-bounded:
an arbitrary producer can stall preparation before EOF or the limit. Existing child
cancellation and snapshot cleanup do not make a blocked arbitrary reader interruptible.

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
endpoint with the checked SHA and squash method; it never enables auto-merge, so a branch
that requires a merge queue fails closed. An explicit `--body-file`/`-F` (including `-` for
stdin) supplies an optional commit message through the same bounded text rewriting and private
JSON snapshot as REST content. An optional `--subject`/`-t` supplies `commit_title` through
that same protection, with separate, equals, and short attached values supported. Subjects
are literal text: a leading `@` never reads a file or stdin. The child receives only the
checked JSON snapshot, not the original subject, body path, or live stdin. Omitting the
subject leaves `commit_title` absent. Inline-body merge flags, non-squash methods, admin/auto variants,
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
  `baseRefOid`, `state`, `merged`, `mergedAt`, `mergeable`, `mergeStateStatus`,
  `closedAt`, or `statusCheckRollup` send `cache-control: max-age=0` automatically. These are the values callers
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
- `request`, `health`, and `stats` bind the saved URL and caller token to the same
  loaded auth snapshot, so another login cannot replace the token midway through
  request setup. An explicit nonblank token environment variable (`--token-env`,
  default `OCTOPOOL_TOKEN`) still takes precedence over the saved token.
- Login, caller, and admin JSON requests follow redirects only to the same scheme,
  hostname, and effective port as the original request (omitted ports mean 80 for HTTP
  and 443 for HTTPS). Cross-origin redirects and HTTPS downgrades fail before the target
  receives a request. Neither `--trust-discovery-redirect` nor
  `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` bypasses this restriction. Configure the intended API
  base directly when moving a server to another origin. Credential-free discovery
  keeps its existing redirect behavior; string-rewrite policy requests still reject
  all redirects.
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
  subsequent retries). Exhausted transient fallbacks may delegate to real `gh` except for
  supported `gh run watch`, which fails explicitly. Exhausted service errors remain failures
  instead of spending local GitHub quota. Default `2`; `0`
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
