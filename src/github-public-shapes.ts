export const PUBLIC_SHAPES = {
  actionsSummary: "actions-summary-v1",
  actionsJobs: "actions-jobs-v1",
  issueSummary: "issue-summary-v1",
  issueList: "issue-list-v1",
  issueSearch: "issue-search-v1",
  pullRequestList: "pr-list-v1",
  pullRequestSummary: "pr-summary-v1",
  labelList: "label-list-v1",
  workflowList: "workflow-list-v1",
  workflowView: "workflow-view-v1",
  releaseSummary: "release-summary-v1",
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
