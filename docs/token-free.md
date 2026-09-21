# Token-Free GitHub Endpoints

This is the canonical inventory of GitHub reads Octopool can make without a PAT or
GitHub App installation token. All repository routes remain public-repository only and
still pass Octopool's public-repo guard.

There are two different token-free transports:

- **Anonymous GitHub API:** REST-shaped JSON from `api.github.com`, without an
  `Authorization` header. These consume GitHub's shared anonymous API quota, including
  successful `304 Not Modified` validations, and still
  pass Octopool's normal response sanitization.
- **No-API-quota sources:** public `github.com` pages and Git smart HTTP endpoints.
  These do not consume GitHub API quota. Some return exact REST shapes; others are bounded shapes used only by supported top-level `gh --json`
  commands.

Cache hits reuse a stored body. Visibility, membership, and revalidation checks can still
contact GitHub, so a cache hit is not proof of zero upstream requests.

## Selection rules

- When a route has both transports, Octopool tries no-API-quota alternatives before the
  anonymous API, then a pooled PAT/App token where permitted. Previously, stale API
  revalidation preceded this phase; shaped page transports now run before anonymous
  conditional revalidation too, retaining the stored validator as fallback if the page fails.
- Diff and patch media use public web endpoints directly.
- A parser that cannot prove completeness or exactness returns no result. Octopool then
  tries the anonymous API in the same request cycle or falls through to the pooled identity.
- Unsuccessful HTTP responses are cancelled before trying another source. Rejected redirect
  chains and failed enrichment responses also release their streams without widening redirect
  permissions or changing the response shape.
- Shaped page fallbacks require an internal `x-octopool-public-shape` header generated
  by supported top-level CLI commands. Raw `gh api` requests do not opt into these
  reduced page shapes.
- Supported repo-scoped `gh search issues|prs` shapes stay token-free-only when pooled
  search is disabled: Octopool uses anonymous API and the shared cache, but never a
  pooled identity or the caller's local token. If anonymous API and bounded stale cache
  are unavailable, the read fails closed.
- Only `GET` with the default JSON accept variants is eligible for anonymous API JSON
  fallback.

## No-API-quota mappings

### Diff and patch media

| Relay request                                                             | Public source                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /repos/{owner}/{repo}/pulls/{number}` with diff/patch `Accept`       | `https://github.com/{owner}/{repo}/pull/{number}.diff` or `.patch`        |
| `GET /repos/{owner}/{repo}/commits/{sha}` with diff/patch `Accept`        | `https://github.com/{owner}/{repo}/commit/{sha}.diff` or `.patch`         |
| `GET /repos/{owner}/{repo}/compare/{comparison}` with diff/patch `Accept` | `https://github.com/{owner}/{repo}/compare/{comparison}.diff` or `.patch` |

GitHub may redirect these to `patch-diff.githubusercontent.com`; Octopool permits only
that known patch host.

### Git refs

| Relay request                                                | Public source                                                             | Limits                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------- |
| `GET /repos/{owner}/{repo}/git/ref/heads/{branch}`           | `https://github.com/{owner}/{repo}.git/info/refs?service=git-upload-pack` | Exact branch ref                         |
| `GET /repos/{owner}/{repo}/git/matching-refs/heads/{prefix}` | Same Git smart HTTP advertisement                                         | Exact matching branch refs               |
| `GET /repos/{owner}/{repo}/git/ref/tags/{tag}`               | Same Git smart HTTP advertisement                                         | Annotated tags only                      |
| `GET /repos/{owner}/{repo}/git/matching-refs/tags/{prefix}`  | Same Git smart HTTP advertisement                                         | Only when every matched tag is annotated |

Git refs require an `application/x-git-upload-pack-advertisement` response and a
complete bounded v0 envelope: the upload-pack service packet, its header flush,
nonempty supported ref records, and a separate terminal flush at exact end of body.
Packets use byte lengths and are limited to 65,520 bytes including the four-byte
prefix. Truncation, reserved records, empty ref records, trailing bytes, and unsupported
version/shallow/metadata forms fall back to the existing exact anonymous API. The
streamed response cap still applies; `Content-Length` is not completion evidence.
This is a conservative adapter subset, not a full Git protocol implementation.

Only after accepting the whole advertisement do Git ref responses read
`https://github.com/{owner}/{repo}/issues?q=is%3Aissue` to recover the repository node
ID needed for exact REST-compatible ref node IDs. Lightweight tags remain anonymous
API-only because the advertisement cannot prove their target object type.

Git-ref JSON adapters accept missing, empty, and whitespace-only `Accept` as well
as the supported JSON media types. Their cache representation generation covers
these eligible blanks while preserving distinct blank-header keys.

### Bounded CLI shapes

These mappings are used when a supported CLI owner requests the documented public shape.
Machine `gh run list/view --json` deliberately omits Actions shape headers and uses shared
exact REST instead, including jobs and lazy workflow-name metadata. Human run output and
watch still use the bounded Actions page shapes below. See the [CLI export contract](cli.md)
for native defaults, requested/returned attempt ownership, safe-integer limits and bounds.

Current shape IDs are `pr-summary-v2`, `pr-summary-v1`, `pr-files-v1`, `pr-list-v1`, `issue-summary-v1`,
`issue-list-v1`, `label-list-v1`, `workflow-list-v1`, `workflow-view-v1`,
`actions-summary-v1`, `actions-jobs-v1`, and `release-metadata-v1`. The `release-summary-v1` wire shape uses
the exact anonymous API as described below.

| Relay request                                                         | Public source                                                                                                       | Shape/limits                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /repos/{owner}/{repo}/pulls/{number}`                            | `https://github.com/{owner}/{repo}/pull/{number}`                                                                   | PR summary fields; no query                                        |
| `GET /repos/{owner}/{repo}/pulls`                                     | `https://github.com/{owner}/{repo}/issues?q=is%3Apr...`                                                             | First page; complete embedded result required                      |
| `GET /repos/{owner}/{repo}/issues/{number}`                           | `https://github.com/{owner}/{repo}/issues/{number}`                                                                 | Issue summary fields; no query                                     |
| `GET /repos/{owner}/{repo}/issues`                                    | `https://github.com/{owner}/{repo}/issues?q=is%3Aissue...`                                                          | First page; complete embedded result required                      |
| `GET /repos/{owner}/{repo}/labels`                                    | `https://github.com/{owner}/{repo}/labels`                                                                          | First page; complete embedded label set required                   |
| `GET /repos/{owner}/{repo}/actions/workflows`                         | `https://github.com/{owner}/{repo}/actions`                                                                         | Up to 10 workflow pages                                            |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow}`              | Same Actions workflow list                                                                                          | Lookup by workflow ID or YAML filename                             |
| `GET /repos/{owner}/{repo}/actions/runs`                              | `https://github.com/{owner}/{repo}/actions`                                                                         | Up to 25 unfiltered runs; shared public-page superset              |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs`         | `https://github.com/{owner}/{repo}/actions/workflows/{workflow}`                                                    | Up to 25 unfiltered runs; shared per-workflow public-page superset |
| `GET /repos/{owner}/{repo}/actions/runs/{id}`                         | `https://github.com/{owner}/{repo}/actions/runs/{id}`                                                               | Run summary; no query                                              |
| `GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}/jobs` | `https://github.com/{owner}/{repo}/actions/runs/{id}/job_groups_batch?attempt={attempt}`, then each public job page | Exact attempt; up to 25 job pages                                  |
| `GET /repos/{owner}/{repo}/releases/tags/{tag}`                       | `https://github.com/{owner}/{repo}/releases/tag/{tag}`                                                              | Release metadata fields only; no query                             |
| `GET /repos/{owner}/{repo}/releases/latest`                           | `https://github.com/{owner}/{repo}/releases/latest`, then the same repository's release-tag page                    | Release metadata fields only; no query                             |

Supported field sets:

- PR view: `number`, `title`, `state`, `url`, `createdAt`, `closedAt`, `mergedAt`,
  `headRefName`, `headRefOid`, `baseRefName`, `mergeCommit`, `merged`, `isDraft`,
  `author`, `headRepositoryOwner`.
- PR files: `path`, `additions`, `deletions`, `changeType`, and `originalPath`; the
  `pr-files-v1` shape uses exact anonymous API data plus a verified head discriminator,
  not a reduced public-page parser.
- PR list: `number`, `title`, `state`, `url`, `author`, `createdAt`, `updatedAt`,
  `closedAt`, `mergedAt`, `isDraft`, `labels`.
- Issue view: `number`, `title`, `body`, `state`, `url`, `author`, `createdAt`,
  `updatedAt`, `labels`.
- Issue list: `number`, `title`, `state`, `url`, `author`, `createdAt`, `updatedAt`,
  `closedAt`, `labels`.
- Labels and workflows: `id`, `name`, `description`, `color`, `url` for labels;
  `id`, `name`, `path`, `state` for workflows.
- Actions summary shapes supply human/watch run metadata; their reconstructed names and
  timestamps are not native machine-export evidence.
- Actions jobs shapes add bounded job and step metadata for human/watch output, not run JSON.
- Release view metadata: `tagName`, `url`, `isDraft`, `isPrerelease`, `publishedAt`.

Release metadata requires a complete release header, matching repository/tag breadcrumb,
public-repository marker, and publication timestamp. Prerelease labels are read only from
the release header, never from user-written notes. Latest-release pages must also carry
the latest label. A malformed or ambiguous header falls through to the exact anonymous
API. Names, raw Markdown, creation timestamps, lists, numeric release-ID routes, query
parameters, custom media, and caller conditionals retain their existing API handling.
The metadata shape has its own cache keys; it cannot satisfy exact release-body reads.

Issue summary and list shapes validate only their documented fields. Missing pagination
metadata for unselected assignees does not discard an otherwise complete page. Labels
still require explicit completeness; requests selecting assignees or milestones use
the exact API representation.

`pr-summary-v2` supplies exact CLI projections, not a complete REST PR body. It always
includes `merged`, and includes `merge_commit_sha` only for merged PRs with a full commit
SHA. Unmerged PRs project `mergeCommit: null`; their REST test-merge SHA is not reconstructed.
The page proves draft status for open and merged PRs, but omits `draft` for closed-unmerged
PRs. Authors and head owners supply login-only identities, hydrated through `/users/{login}`
for node IDs, actor types, and names. Missing identities are omitted, not guessed.
If a requested projection needs an omitted value, the CLI repeats the PR read through
the relay without the public-shape header, preserving its freshness headers. This stays
within the relay even with `OCTOPOOL_NO_FALLBACK=1`. Fields not needed by the request do
not trigger this retry. `headRepository` and `mergeable` remain API-only; `mergedBy`
remains unsupported by the CLI. Older CLIs can still request the original `pr-summary-v1`
field set. Deploy the Worker and upgrade the CLI to use v2.

Actions run lists validate the first page's cards and matching responsive copies of counts
and timestamps. When GitHub marks the count as capped (`N+ workflow runs` or
`count_is_capped="true"`), `total_count` in `actions-summary-v1` is the lower bound `N`,
not an exact repository/workflow total. Such pages must contain at least the requested
number of cards (up to 25); uncapped counts remain exact. Human run lists render the
returned rows without using the total. Filtered cache reuse still requires enough matching
rows, and a short larger cached page still needs exact completion evidence. Ambiguous
event prose and missing commit SHAs are hydrated from each run's owned page. Canonical
events come from the `on: <event>` label beside the workflow link in the disjoint
`Workflow run graph` region, with both its `graph_partial` URL and workflow link bound
to the requested run. Only [documented event names](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
are accepted. Without a graph, the confirmed summary-prose allowlist is only `push` →
`push` and `pull request` → `pull_request`. Prose such as `issue`, `issues`, and
`issue comment` is never mechanically converted into an event. Missing, malformed,
or conflicting evidence falls back to REST. If even one hydrated run still has an
ambiguous event, the entire list falls back to REST; partial lists are not returned.
Manual run summaries use `Manually triggered` beside their timestamp and still require
the owned graph to prove `workflow_dispatch`. PR-triggered pages that omit the owned
commit SHA remain API-only; a PR link or current branch head cannot supply historical
`head_sha`. Queued/pending status alone does not prevent page parsing.

Before fetching any run page, the list adapter counts cards needing an event or full
SHA across the entire parsed page, before limit truncation. More than eight causes
immediate REST fallback. Otherwise hydration runs concurrently, with each run-page
fetch capped at the lesser of the configured request timeout and five seconds. The list
page fetch keeps the normal configured transport timeout. After parsing and the card-count
check, hydration gets its own shared 2500 ms deadline, covering all run-page fetches,
redirects, body reads and commit patches. List fetching and parsing do not consume that
deadline. The first failed hydration or deadline aborts outstanding work; only a complete
result can be returned or cached. A failed hydration phase adds at most roughly 2.5 seconds
after the list page, plus synchronous parsing/scheduling overhead. Run views and jobs
retain their existing timeout policy.
Unfiltered superset projection preserves the upstream count/lower bound; filtered
projections report the number of captured matches before applying the requested limit.

Job groups use zero-based `batch` pagination with an explicit `size=1`, up to 25 batches
and 25 job pages. Every batch must keep the same group total, advance without duplicate
jobs, and end with `hasMore: false` at the declared group count. Group totals are not job
totals: nested groups may contain several jobs. The resulting jobs shape reports the
complete job count, and discards the group page's response validators after hydration.
Verified skipped-job pages expose no timestamps or steps. This bounded shape returns
`started_at: null`, `completed_at: null`, and `steps: []` for those jobs; these are unavailable
timestamps, not reconstructed REST times. Human output matches native `gh`'s `in 0s`
rendering for skipped jobs with absent/equal timestamps; watch output does not use job timing.
Ordinary job pages must identify the selected job and agree with the group status. A live
`Started` header supplies the start time; completed headers supply the completion time.
Contradictory states, conclusions, or timestamp ordering fall back to REST.

The opt-in live parser check fetches public pages only:
`OCTOPOOL_LIVE_GITHUB=1 pnpm exec vitest run test/actions-live.test.ts`.
Without the flag, this test is skipped and does not access the network.

Workflow pagination uses
`https://github.com/{owner}/{repo}/actions/workflows_partial?query=&page={page}`. Actions
run enrichment may read a run page and
`https://github.com/{owner}/{repo}/commit/{sha}.patch`.

### Public-repository proof

The guard normally checks `GET https://api.github.com/repos/{owner}/{repo}`. If that
proof is rate-limited or unavailable, Octopool can inspect
`https://github.com/{owner}/{repo}` for GitHub's public-repository marker. This proves
visibility only; it does not provide a relay response.
Token-free-only shaped search always uses this page-marker proof and never a configured
verification token.
Its `issue-search-v1` CLI shape gates an exact first-page anonymous API request; it is not
a reduced public-page response shape.

## Anonymous API routes

Every path below maps directly to `GET https://api.github.com{path}` without an
`Authorization` header. Query parameters accepted by the corresponding relay route are
preserved. Repository responses are cached only after the public-repo guard succeeds.

### Exact contents responses

Contents JSON reads, with or without an explicit `ref`, use the anonymous REST API.
Octopool preserves GitHub's file, symlink, submodule, and directory responses instead
of constructing file metadata from `raw.githubusercontent.com` bytes. GitHub may
return a symlink target's contents or describe the symlink itself; only the REST
endpoint knows which response is correct.

These cache misses consume anonymous API quota. If the anonymous API is unavailable,
the existing public-repository guard, pooled API, and bounded stale-cache paths still
apply. Explicit raw, HTML, and object media keep their existing exact API handling.
The contents cache generation retires old reconstructed JSON responses; see
[cache keys](cache.md#cache-key).

### Exact release bodies

`gh release view [tag] --json` uses the exact anonymous API for both latest and tagged
releases whenever the selected fields include `name`, `body`, or `createdAt`. Its `release-summary-v1` shape supports
`tagName`, `name`, `url`, `isDraft`, `isPrerelease`, `createdAt`, `publishedAt`, and `body`.
The decoded `body` string preserves the API's raw Markdown byte for byte, including
headings, tight lists, reference links, code fences, whitespace, line endings, and an
explicitly empty string. Cache reads preserve that same source string.

Rendered release HTML does not prove the original Markdown. Octopool does not reconstruct
it or substitute a changelog. These exact release cache misses consume anonymous API quota
instead of using the public release page. If the API is unavailable, only an eligible
exact cached response may be served through the existing bounded stale policy; otherwise
the existing guarded local-`gh` fallback applies. Releases never use pooled credentials,
and draft filtering remains in place.

### Public issue-event visibility

Issue timelines (`/issues/{number}/timeline`), per-issue events (`/issues/{number}/events`),
repository issue events (`/issues/events`), and individual events (`/issues/events/{id}`)
are anonymous-only, including caller conditional requests. GitHub's
[cross-references](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#cross-referenced)
and [closing-commit references](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-an-issues-only-repository)
depend on access to the source repository. Proving the target public or removing a nested
repository object does not prove the enclosing issue/commit details public.

These routes preserve anonymous REST bodies and headers. Anonymous quota exhaustion or
unavailability uses eligible public stale data or guarded native fallback; unsupported media
also falls back locally. Old event representations are retired by the server's cache generation.
Repository activity events use a different payload schema, and network events explicitly list
public activity; neither is changed by this issue-reference restriction.

### Generated route catalog

<!-- token-free-api-routes:start -->

```text
GET /users/{login}
GET /users/{login}/repos
GET /users/{login}/orgs
GET /users/{login}/gists
GET /users/{login}/followers
GET /users/{login}/following
GET /users/{login}/events
GET /users/{login}/received_events
GET /users/{login}/keys
GET /users/{login}/gpg_keys
GET /orgs/{org}/repos
GET /orgs/{org}/events
GET /orgs/{org}/public_members
GET /orgs/{org}/public_members/{login}
GET /gists/{gist}
GET /emojis
GET /meta
GET /licenses
GET /licenses/{slug}
GET /gitignore/templates
GET /gitignore/templates/{template}
GET /repos/{owner}/{repo}
GET /repos/{owner}/{repo}/commits
GET /repos/{owner}/{repo}/commits/{sha}
GET /repos/{owner}/{repo}/commits/{ref}
GET /repos/{owner}/{repo}/commits/{sha}/comments
GET /repos/{owner}/{repo}/commits/{sha}/pulls
GET /repos/{owner}/{repo}/commits/{sha}/branches-where-head
GET /repos/{owner}/{repo}/commits/{sha}/statuses
GET /repos/{owner}/{repo}/commits/{ref}/statuses
GET /repos/{owner}/{repo}/comments/{id}
GET /repos/{owner}/{repo}/compare/{comparison}
GET /repos/{owner}/{repo}/contents/{path}
GET /repos/{owner}/{repo}/readme
GET /repos/{owner}/{repo}/readme/{dir}
GET /repos/{owner}/{repo}/pulls/{number}
GET /repos/{owner}/{repo}/pulls
GET /repos/{owner}/{repo}/pulls/{number}/files
GET /repos/{owner}/{repo}/pulls/{number}/commits
GET /repos/{owner}/{repo}/pulls/{number}/comments
GET /repos/{owner}/{repo}/pulls/comments
GET /repos/{owner}/{repo}/pulls/comments/{id}
GET /repos/{owner}/{repo}/pulls/comments/{id}/reactions
GET /repos/{owner}/{repo}/pulls/{number}/reviews
GET /repos/{owner}/{repo}/pulls/{number}/reviews/{id}
GET /repos/{owner}/{repo}/pulls/{number}/reviews/{id}/comments
GET /repos/{owner}/{repo}/pulls/{number}/requested_reviewers
GET /repos/{owner}/{repo}/commits/{sha}/check-runs
GET /repos/{owner}/{repo}/commits/{ref}/check-runs
GET /repos/{owner}/{repo}/commits/{sha}/check-suites
GET /repos/{owner}/{repo}/commits/{ref}/check-suites
GET /repos/{owner}/{repo}/commits/{sha}/status
GET /repos/{owner}/{repo}/commits/{ref}/status
GET /repos/{owner}/{repo}/statuses/{sha}
GET /repos/{owner}/{repo}/actions/runs
GET /repos/{owner}/{repo}/actions/runs/{id}
GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}
GET /repos/{owner}/{repo}/actions/runs/{id}/jobs
GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}/jobs
GET /repos/{owner}/{repo}/actions/runs/{id}/artifacts
GET /repos/{owner}/{repo}/actions/jobs/{id}
GET /repos/{owner}/{repo}/check-runs/{id}/annotations
GET /repos/{owner}/{repo}/issues/{number}
GET /repos/{owner}/{repo}/issues
GET /repos/{owner}/{repo}/issues/{number}/comments
GET /repos/{owner}/{repo}/issues/comments
GET /repos/{owner}/{repo}/issues/comments/{id}
GET /repos/{owner}/{repo}/issues/comments/{id}/reactions
GET /repos/{owner}/{repo}/issues/{number}/events
GET /repos/{owner}/{repo}/issues/events
GET /repos/{owner}/{repo}/issues/events/{id}
GET /repos/{owner}/{repo}/issues/{number}/labels
GET /repos/{owner}/{repo}/issues/{number}/reactions
GET /repos/{owner}/{repo}/issues/{number}/timeline
GET /repos/{owner}/{repo}/assignees
GET /repos/{owner}/{repo}/assignees/{login}
GET /repos/{owner}/{repo}/labels
GET /repos/{owner}/{repo}/labels/{label}
GET /repos/{owner}/{repo}/milestones
GET /repos/{owner}/{repo}/milestones/{id}
GET /repos/{owner}/{repo}/branches
GET /repos/{owner}/{repo}/branches/{branch}
GET /repos/{owner}/{repo}/tags
GET /repos/{owner}/{repo}/languages
GET /repos/{owner}/{repo}/contributors
GET /repos/{owner}/{repo}/license
GET /repos/{owner}/{repo}/topics
GET /repos/{owner}/{repo}/community/profile
GET /repos/{owner}/{repo}/forks
GET /repos/{owner}/{repo}/stargazers
GET /repos/{owner}/{repo}/subscribers
GET /repos/{owner}/{repo}/deployments
GET /repos/{owner}/{repo}/events
GET /networks/{owner}/{repo}/events
GET /repos/{owner}/{repo}/stats/contributors
GET /repos/{owner}/{repo}/stats/commit_activity
GET /repos/{owner}/{repo}/stats/code_frequency
GET /repos/{owner}/{repo}/stats/participation
GET /repos/{owner}/{repo}/stats/punch_card
GET /repos/{owner}/{repo}/git/blobs/{sha}
GET /repos/{owner}/{repo}/git/commits/{sha}
GET /repos/{owner}/{repo}/git/tags/{sha}
GET /repos/{owner}/{repo}/git/trees/{sha}
GET /repos/{owner}/{repo}/git/ref/{ref}
GET /repos/{owner}/{repo}/git/matching-refs/{ref}
GET /repos/{owner}/{repo}/actions/workflows
GET /repos/{owner}/{repo}/actions/workflows/{workflow}
GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs
GET /repos/{owner}/{repo}/releases
GET /repos/{owner}/{repo}/releases/latest
GET /repos/{owner}/{repo}/releases/tags/{tag}
GET /repos/{owner}/{repo}/releases/{id}
GET /repos/{owner}/{repo}/releases/{id}/assets
GET /repos/{owner}/{repo}/releases/assets/{id}
GET /search/issues
GET /search/commits
GET /search/repositories
```

<!-- token-free-api-routes:end -->

Actions job logs are deliberately absent: log downloads require authenticated GitHub and follow
signed redirects. Release list/latest/tag/id reads remove drafts from anonymous responses; asset
routes use the exact anonymous API response. Search requires pool policy `allow_search: true` and
the relay's scoped query validation; `GET /search/code` is intentionally not token-free.

## Explicit exclusions

These supported relay routes are not token-free:

- Actions job logs.
- GitHub code search.
- `GET /rate_limit`.
- The public landing shapes `pr-ci-summary-v1`, `pr-ci-rollup-v1`, and
  `pr-merge-snapshot-v1` on `GET /repos/{owner}/{repo}/pulls/{number}`. These use
  fixed GraphQL queries with a pooled identity, including explicit refreshes;
  they never use anonymous API or public-page transports. Ordinary REST requests
  on the same path keep the anonymous transport listed above.
- Private repository reads.
- Any mutation or non-`GET` request.
- Any route or media type not listed above.

GitHub can still rate-limit, change, or remove public HTML. Every page parser therefore
fails closed and preserves the normal anonymous or pooled API fallback.
