# Native PR detail exports

The reference is native **gh 2.101.0 (2026-09-15)**, verified with the installed
binary and the matching [cli/cli tag](https://github.com/cli/cli/tree/v2.101.0).
The relevant sources are `api/query_builder.go`, `api/queries_comments.go`,
`api/queries_pr.go`, `api/queries_pr_review.go`, `api/queries_issue.go`,
`api/reaction_groups.go`, `api/export_pr.go`, and `pkg/cmd/pr/shared/finder.go`.
Credential resolution follows native gh, including its active account selection.
The persisted `ActiveUser` login is not proof of identity: a username can change
while its stored token remains valid.

## Comments

Native gh's initial selection is:

```graphql
comments(first: 100) {
  nodes {
    id
    author { login ... on User { id name } }
    authorAssociation
    body
    createdAt
    includesCreatedEdit
    isMinimized
    minimizedReason
    reactionGroups { content users { totalCount } }
    url
    viewerDidAuthor
  }
  pageInfo { hasNextPage endCursor }
  totalCount
}
```

`preloadPrComments` requests successive `comments(first:100,after:$endCursor)`
through `node(id:$id){...on PullRequest{…}}` until `hasNextPage` is false.
Its struct-generated selection has the same exported fields, with only
`author{login}`. Neither query supplies `orderBy`; export preserves connection
order across all pages without sorting. The JSON value is the concatenated array
of nodes, with no connection wrapper or pagination metadata.

Each comment exports `id`, `author:{login}`, `authorAssociation`, `body`,
`createdAt`, `includesCreatedEdit`, `isMinimized`, `minimizedReason`,
`reactionGroups:[{content,users:{totalCount}}]`, `url`, and `viewerDidAuthor`.
The author ID and name requested initially are discarded. Null authors become
`{"login":""}`; null minimized reasons become `""`. Empty URLs are omitted.
Dates pass through Go `time.Time` JSON encoding. Zero-count reaction groups are
removed, retaining order and an empty array when there are no reactions.

Every exported field above is viewer-independent except `viewerDidAuthor`.
Neither the selection nor export contains `viewerHasReacted`. The fixed
`pr-comments-v1` query omits `viewerDidAuthor` and the unused author name. It
retains the User node ID for local authorship computation, omitting that ID from
export. The CLI uses two guarded native REST `/user` reads to resolve the active
credential's immutable ID before hydration and before output. Comparing immutable
IDs handles renamed accounts and reused logins; empty/deleted authors cannot match.
These identity probes consume caller REST quota while comment queries use pooled
GraphQL quota. Unavailable identity reads, environment-token overrides or account
changes cause delegation. Neither gh's persisted username nor Octopool's saved login
is an identity source.

## Reviews: deliberately delegated

Native gh's initial selection is:

```graphql
reviews(first: 100) {
  nodes {
    id
    author { login }
    authorAssociation
    submittedAt
    body
    state
    commit { oid }
    reactionGroups { content users { totalCount } }
  }
  pageInfo { hasNextPage endCursor }
  totalCount
}
```

`preloadPrReviews` follows `reviews(first:100,after:$endCursor)` through the PR
node until completion, with no `orderBy` or export sorting. Its struct-generated
continuation additionally selects `includesCreatedEdit` and `url`. Consequently,
native JSON includes `includesCreatedEdit:false` and omits `url` for the initial
page, but subsequent pages use their actual values. JSON is the concatenated
array, exporting `id`, `author:{login}`, `authorAssociation`, `body`, `submittedAt`,
`includesCreatedEdit`, `reactionGroups`, `state`, optional `url`, and `commit:{oid}`.
Null submission dates stay null; null commit/author objects become their Go zero
values. Reactions use the same zero-count filtering as comments.

The fields of a published review are viewer-independent; there are no explicit
viewer flags in this export. **Membership of the connection is viewer-dependent:**
the local viewer can see their own private `PENDING` review. `ExportData` exports
all review nodes, unlike the human renderer's `DisplayableReviews` filter.
Filtering pending reviews would lose native data; leaving them in a pooled query
could expose the pooled account's private review. A configured username cannot
recover the private body or prove absence of a pending review. There is therefore
no pooled reviews shape, and any bundle containing `reviews` remains native.

## Commits

Native gh selects:

```graphql
commits(first: 100) {
  nodes {
    commit {
      authors(first: 100) { nodes { name email user { id login } } }
      messageHeadline
      messageBody
      oid
      committedDate
      authoredDate
    }
  }
}
```

All selected/exported fields are viewer-independent. Unlike comments/reviews,
the finder does **not** paginate commits or their authors. It retains the first
100 of each in connection order. The JSON array flattens `nodes[].commit` and
exports `oid`, `messageHeadline`, `messageBody`, `committedDate`, `authoredDate`,
and `authors:[{name,email,id,login}]`. Author `user` is flattened; null users
produce empty ID/login strings. Both empty commits and author lists export `[]`.
Dates use Go `time.Time` encoding.

`pr-commits-v1` adds connection totals/page info and the PR identity/head solely
for validation. Commit sets above 100 delegate instead of changing native gh's
truncation. The first 100 authors remain native-identical. Comments are bounded
to ten 100-item pages; incomplete pages, changing totals/PR identity, duplicate
IDs, invalid/repeated cursors and old Worker responses trigger guarded fallback
before output. Commit heads must match the initial and final live PR reads.

## Freshness and security

The two projections share the fixed landing-query allowlist and transport, public
repository guard, GraphQL quota accounting, cursor-separated cache keys, 60-second
maximum cache lifetime, and no stale fallback. The PR-view CLI requests
`max-age=0` for every page and its accompanying basic PR read, preserving native
live-read behavior. GraphQL failures are errors, not an old-Worker fallback.
Only canonical Worker-owned query text reaches pooled credentials; caller text
and viewer-specific selections cannot enter these projections.
