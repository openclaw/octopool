# Token-Free GitHub Endpoints

This is the canonical inventory of GitHub reads Octopool can make without a PAT or
GitHub App installation token. All repository routes remain public-repository only and
still pass Octopool's public-repo guard.

There are two different token-free transports:

- **Anonymous GitHub API:** REST-shaped JSON from `api.github.com`, without an
  `Authorization` header. These consume GitHub's shared anonymous API quota and still
  pass Octopool's normal response sanitization.
- **No-API-quota sources:** public `github.com`, `raw.githubusercontent.com`, and Git
  smart HTTP endpoints. These do not consume GitHub API quota. Some return exact REST
  shapes; others are bounded shapes used only by supported top-level `gh --json`
  commands.

Cache hits are separate: a fresh D1 cache hit contacts no GitHub endpoint.

## Selection rules

- When a route has both transports, Octopool tries no-API-quota alternatives before the
  anonymous API, then a pooled PAT/App token where permitted.
- Diff and patch media use public web endpoints directly.
- A parser that cannot prove completeness or exactness returns no result. Octopool then
  tries the anonymous API in the same request cycle or falls through to the pooled identity.
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

### Contents and Git refs

| Relay request                                                | Public source                                                             | Limits                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}`        | `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`           | Explicit safe ref and file path only; returned as an API-shaped file object |
| `GET /repos/{owner}/{repo}/git/ref/heads/{branch}`           | `https://github.com/{owner}/{repo}.git/info/refs?service=git-upload-pack` | Exact branch ref                                                            |
| `GET /repos/{owner}/{repo}/git/matching-refs/heads/{prefix}` | Same Git smart HTTP advertisement                                         | Exact matching branch refs                                                  |
| `GET /repos/{owner}/{repo}/git/ref/tags/{tag}`               | Same Git smart HTTP advertisement                                         | Annotated tags only                                                         |
| `GET /repos/{owner}/{repo}/git/matching-refs/tags/{prefix}`  | Same Git smart HTTP advertisement                                         | Only when every matched tag is annotated                                    |

Git ref responses also read
`https://github.com/{owner}/{repo}/issues?q=is%3Aissue` to recover the repository node
ID needed for exact REST-compatible ref node IDs. Lightweight tags remain anonymous
API-only because the advertisement cannot prove their target object type.

### Bounded CLI shapes

These mappings are used only when the requested top-level `gh --json` fields fit the
documented public shape.

Current shape IDs are `pr-summary-v1`, `pr-files-v1`, `pr-list-v1`, `issue-summary-v1`,
`issue-list-v1`, `label-list-v1`, `workflow-list-v1`, `workflow-view-v1`,
`actions-summary-v1`, `actions-jobs-v1`, and `release-summary-v1`.

| Relay request                                                         | Public source                                                                                                       | Shape/limits                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /repos/{owner}/{repo}/pulls/{number}`                            | `https://github.com/{owner}/{repo}/pull/{number}`                                                                   | PR summary fields; no query                                                |
| `GET /repos/{owner}/{repo}/pulls`                                     | `https://github.com/{owner}/{repo}/issues?q=is%3Apr...`                                                             | First page; complete embedded result required                              |
| `GET /repos/{owner}/{repo}/issues/{number}`                           | `https://github.com/{owner}/{repo}/issues/{number}`                                                                 | Issue summary fields; no query                                             |
| `GET /repos/{owner}/{repo}/issues`                                    | `https://github.com/{owner}/{repo}/issues?q=is%3Aissue...`                                                          | First page; complete embedded result required                              |
| `GET /repos/{owner}/{repo}/labels`                                    | `https://github.com/{owner}/{repo}/labels`                                                                          | First page; complete embedded label set required                           |
| `GET /repos/{owner}/{repo}/actions/workflows`                         | `https://github.com/{owner}/{repo}/actions`                                                                         | Up to 10 workflow pages                                                    |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow}`              | Same Actions workflow list                                                                                          | Lookup by workflow ID or YAML filename                                     |
| `GET /repos/{owner}/{repo}/actions/runs`                              | `https://github.com/{owner}/{repo}/actions?query={filters}`                                                         | Up to 25 runs; optional branch/status filters; shared public-page superset |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs`         | `https://github.com/{owner}/{repo}/actions/workflows/{workflow}?query={filters}`                                    | Up to 25 runs; shared per-workflow public-page superset                    |
| `GET /repos/{owner}/{repo}/actions/runs/{id}`                         | `https://github.com/{owner}/{repo}/actions/runs/{id}`                                                               | Run summary; no query                                                      |
| `GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}/jobs` | `https://github.com/{owner}/{repo}/actions/runs/{id}/job_groups_batch?attempt={attempt}`, then each public job page | Exact attempt; up to 25 job pages                                          |
| `GET /repos/{owner}/{repo}/releases/latest`                           | `https://github.com/{owner}/{repo}/releases/latest`                                                                 | Release summary used by `gh release view`                                  |
| `GET /repos/{owner}/{repo}/releases/tags/{tag}`                       | `https://github.com/{owner}/{repo}/releases/tag/{tag}`                                                              | Release summary used by `gh release view`; no query                        |

Supported field sets:

- PR view: `number`, `title`, `state`, `url`, `createdAt`, `closedAt`, `mergedAt`,
  `headRefName`, `headRefOid`, `baseRefName`.
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
- Run summary: `databaseId`, `name`, `workflowName`, `status`, `conclusion`, `url`,
  `headBranch`, `headSha`, `event`, `createdAt`, `updatedAt`, `displayTitle`, `number`,
  and `attempt` for run views.
- Run jobs add `jobs` with bounded job and step metadata.
- Release summary: `tagName`, `name`, `url`, `isDraft`, `isPrerelease`, `createdAt`,
  `publishedAt`, `body`.

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
- Private repository reads.
- Any mutation or non-`GET` request.
- Any route or media type not listed above.

GitHub can still rate-limit, change, or remove public HTML. Every page parser therefore
fails closed and preserves the normal anonymous or pooled API fallback.
