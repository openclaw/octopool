Recorded from native `gh api graphql` (nonterminal stdout), 2026-09-27, for this public query:

```graphql
query {
  repository(owner: "openclaw", name: "octopool") {
    nameWithOwner
    description
    databaseId
    pullRequest(number: 42) {
      state
      headRefOid
    }
  }
}
```

The response has no terminating newline. Tests use it as a frozen output contract; no live GitHub call is needed.
