export const PUBLIC_SHAPES = {
  actionsSummary: "actions-summary-v1",
  actionsJobs: "actions-jobs-v1",
  issueSummary: "issue-summary-v1",
  issueList: "issue-list-v1",
  issueSearch: "issue-search-v1",
  pullRequestList: "pr-list-v1",
  pullRequestSummary: "pr-summary-v2",
  pullRequestSummaryV1: "pr-summary-v1",
  pullRequestCISummary: "pr-ci-summary-v1",
  pullRequestCIRollup: "pr-ci-rollup-v1",
  pullRequestMergeSnapshot: "pr-merge-snapshot-v1",
  pullRequestFiles: "pr-files-v1",
  labelList: "label-list-v1",
  workflowList: "workflow-list-v1",
  workflowView: "workflow-view-v1",
  releaseSummary: "release-summary-v1",
} as const;

// These fixed public projections are also generated into the CLI's query allowlist.
// Viewer-specific fields and caller-supplied GraphQL never reach pooled credentials.
export const GITHUB_LANDING_QUERIES = {
  pullRequestCISummary: `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:1){checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}`,
  pullRequestCIRollup: `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{kind:__typename ... on CheckRun{name status conclusion databaseId checkSuite{databaseId workflowRun{databaseId event workflow{databaseId}}}} ... on StatusContext{context state}}}}}}}`,
  pullRequestMergeSnapshot: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id databaseId url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}`,
} as const;

export function isPublicIssueSearchQuery(
  query: Record<string, string | string[]> | undefined,
  owner: string,
  repo: string,
): boolean {
  const allowedKeys = new Set(["q", "per_page", "page"]);
  if (
    query === undefined ||
    Object.entries(query).some(
      ([key, value]) => !allowedKeys.has(key) || Array.isArray(value) || value === "",
    ) ||
    (query.page !== undefined && query.page !== "1")
  ) {
    return false;
  }
  const perPageText = query.per_page ?? "30";
  const perPage = Number(perPageText);
  const raw = query.q;
  if (
    typeof perPageText !== "string" ||
    !/^(?:[1-9]|[1-9][0-9]|100)$/.test(perPageText) ||
    !Number.isInteger(perPage) ||
    typeof raw !== "string"
  ) {
    return false;
  }
  let repoMatches = 0;
  let typeMatches = 0;
  let stateMatches = 0;
  let terms = 0;
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const repoMatch = /^repo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(token);
    if (repoMatch !== null) {
      if (
        repoMatch[1]?.toLowerCase() !== owner.toLowerCase() ||
        repoMatch[2]?.toLowerCase() !== repo.toLowerCase()
      ) {
        return false;
      }
      repoMatches++;
      continue;
    }
    if (/^type:(issue|pr)$/i.test(token)) {
      typeMatches++;
      continue;
    }
    if (/^state:(open|closed)$/i.test(token)) {
      stateMatches++;
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(token) || token.toUpperCase() === "OR") {
      return false;
    }
    terms++;
  }
  return repoMatches === 1 && typeMatches === 1 && stateMatches <= 1 && terms >= 1;
}
