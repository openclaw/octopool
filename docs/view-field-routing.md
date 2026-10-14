# PR and issue view field routing

This inventory compares the supported field tables at `5a8dc64` with the valid
`--json` fields printed by native gh v2.102.0. Unknown/invalid field names also
stay native so gh can report its own validation error. One unsupported field
routes the entire export to native gh; `--jq` does not reduce the upstream field set.

## Baseline native delegation

| Command      | Fields                                                                                                                                                                                                                       | Reason                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pr view`    | `mergeStateStatus`                                                                                                                                                                                                           | No GraphQL projection was wired into PR-view exports; REST `mergeable_state` is not equivalent (native `BLOCKED` versus REST `unstable`). |
| `pr view`    | `closed`, `closingIssuesReferences`, `fullDatabaseId`, `id`, `isCrossRepository`, `latestReviews`, `milestone`, `potentialMergeCommit`, `projectCards`, `projectItems`, `reactionGroups`, `reviewDecision`, `reviewRequests` | Not admitted by `supportedPRFields`; native exports have no implemented exact projection.                                                 |
| `pr view`    | `reviews`                                                                                                                                                                                                                    | Admitted by the table but always requests typed native fallback: private pending reviews depend on the caller.                            |
| `pr view`    | non-null `autoMergeRequest`                                                                                                                                                                                                  | Admitted by the table, but REST lacks native `enabledAt` and `authorEmail`; previously only explicit null was supported.                  |
| `issue view` | `blockedBy`, `blocking`, `closed`, `closedByPullRequestsReferences`, `comments`, `id`, `isPinned`, `issueType`, `parent`, `projectCards`, `projectItems`, `reactionGroups`, `stateReason`, `subIssues`, `subIssuesSummary`   | Not admitted by `supportedIssueFields`; no exact view projection implemented.                                                             |

`maintainerCanModify`, `mergeable`, and `statusCheckRollup` already relay at the
baseline. `maintainerCanModify` requires a REST boolean; `mergeable` maps REST
true/false/null-or-absent to MERGEABLE/CONFLICTING/UNKNOWN. The rollup hydrates live
checks/statuses and verifies the head. These are not causes of `native-json-fields`.
Missing identity metadata, pagination limits, moving heads, or other incomplete
responses can still cause typed native fallback after a supported request begins.
Those are distinct from the field-table journal category.

`needsLivePRRead` includes `headRefOid`, `baseRefOid`, `state`, `merged`, `mergedAt`,
`mergeable`, `mergeCommit`, `mergeStateStatus`, `autoMergeRequest`,
`maintainerCanModify`, `mergedBy`, `closedAt`, and `statusCheckRollup`. The inclusion
of `mergeStateStatus` does not override the earlier field-table rejection.

## The journal's `:field`

`journalJSONFields` is deliberately lossy: every unrecognized spelling becomes
`:field`, then fields are sorted and deduplicated. At the baseline, valid issue
fields that collapse to it are `blockedBy`, `blocking`,
`closedByPullRequestsReferences`, `isPinned`, `issueType`, `projectCards`,
`stateReason`, `subIssues`, and `subIssuesSummary`. Other invalid names collapse
there too. `parent`, `id`, `closed`, `comments`, `projectItems`, and `reactionGroups`
are already recognized by another table or the explicit journal allowlist.

Thus `:field,assignees,state` and `:field,title` alone cannot identify the original
field. No unredacted caller evidence was supplied with those journal lines. The
journal now recognizes all valid native issue/PR field names, without retaining
arbitrary unknown strings, so subsequent samples identify the exact field.

## Changes and retained boundaries

Issue views now support `stateReason` through live REST and native assignee
projection. Lists retain their original field table. PR `mergeStateStatus` now reuses the existing live merge snapshot, and enabled PR `autoMergeRequest`
uses the complete fixed pooled `pr-auto-merge-v1` GraphQL shape. Disabled
auto-merge, mergeability, and maintainer permission keep their existing live REST
paths. Every new projection completes before output or `--jq` evaluation.

`pr-merge-snapshot-v1` lacks five native auto-merge fields, and `pr-ci-summary-v1`
and `pr-ci-rollup-v1` cannot replace that export. The new shape is necessary for
full native auto-merge data. No deployment or schema migration is part of this change.

The fixed pooled merge snapshot matched native on openclaw/openclaw PRs 157854,
171553, 171790, 171704, and 170742 on October 13. A separate comparison with native
fallback disabled found that the generic scoped read-only GraphQL route can return
`UNKNOWN` where native and the fixed pooled snapshot both return `BLOCKED` on the
same head. That generic route must not substitute for the fixed pooled projection.
PR 171553 changed UNSTABLE to CLEAN on an unchanged SHA, demonstrating that head
equality alone cannot prove an atomic merge-policy snapshot. The CLI now preserves
the actual GraphQL enum, never translates REST mergeable_state, and refuses unrecognized
enums or incomplete snapshots. Lists/searches still delegate this field, as do view
exports containing any of the other unsupported fields in the baseline table.
