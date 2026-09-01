package main

var fieldMapPR = map[string][]string{
	"url":          {"html_url"},
	"author":       {"user"},
	"createdAt":    {"created_at"},
	"updatedAt":    {"updated_at"},
	"closedAt":     {"closed_at"},
	"mergedAt":     {"merged_at"},
	"headRefName":  {"head", "ref"},
	"headRefOid":   {"head", "sha"},
	"baseRefName":  {"base", "ref"},
	"baseRefOid":   {"base", "sha"},
	"isDraft":      {"draft"},
	"changedFiles": {"changed_files"},
}

var fieldMapIssue = map[string][]string{
	"url":       {"html_url"},
	"author":    {"user"},
	"createdAt": {"created_at"},
	"updatedAt": {"updated_at"},
	"closedAt":  {"closed_at"},
}

var fieldMapRepo = map[string][]string{
	"nameWithOwner":    {"full_name"},
	"url":              {"html_url"},
	"isPrivate":        {"private"},
	"defaultBranchRef": {"default_branch"},
	"createdAt":        {"created_at"},
	"updatedAt":        {"updated_at"},
	"pushedAt":         {"pushed_at"},
}

var fieldMapRelease = map[string][]string{
	"tagName":      {"tag_name"},
	"url":          {"html_url"},
	"isDraft":      {"draft"},
	"isPrerelease": {"prerelease"},
	"createdAt":    {"created_at"},
	"publishedAt":  {"published_at"},
}

var fieldMapCheckRun = map[string][]string{
	"databaseId":  {"id"},
	"detailsUrl":  {"details_url"},
	"startedAt":   {"started_at"},
	"completedAt": {"completed_at"},
}

var fieldMapWorkflow = map[string][]string{
	"url":       {"html_url"},
	"createdAt": {"created_at"},
	"updatedAt": {"updated_at"},
}

var fieldMapLabel = map[string][]string{}

var fieldMapGist = map[string][]string{
	"url":       {"html_url"},
	"isPublic":  {"public"},
	"createdAt": {"created_at"},
	"updatedAt": {"updated_at"},
}

var supportedPRFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"mergedAt", "headRefName", "headRefOid", "baseRefName", "baseRefOid", "isDraft", "labels",
	"additions", "deletions", "changedFiles", "mergeable", "merged", "files", "commits", "comments",
	"reviews", "headRepository", "headRepositoryOwner", "assignees", "statusCheckRollup",
)

var supportedPRListFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"mergedAt", "headRefName", "headRefOid", "baseRefName", "baseRefOid", "isDraft", "labels",
)

var supportedPublicPRListFields = supportedFields(
	"number", "title", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"mergedAt", "isDraft", "labels",
)

var supportedPublicPRViewFields = supportedFields(
	"number", "title", "state", "url", "createdAt", "closedAt", "mergedAt",
	"headRefName", "headRefOid", "baseRefName",
)

var supportedPRSearchFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"labels",
)

var supportedIssueFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"labels", "assignees", "milestone",
)

var supportedPublicIssueViewFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "labels",
)

var supportedPublicIssueListFields = supportedFields(
	"number", "title", "state", "url", "author", "createdAt", "updatedAt", "closedAt", "labels",
)

var supportedRunListFields = supportedFields(
	"databaseId", "name", "workflowName", "status", "conclusion", "url", "headBranch",
	"headSha", "event", "createdAt", "updatedAt", "displayTitle", "number",
)

var supportedRunViewFields = supportedFields(
	"databaseId", "name", "workflowName", "status", "conclusion", "url", "headBranch",
	"headSha", "event", "createdAt", "updatedAt", "displayTitle", "number", "attempt", "jobs",
)

var supportedRepoFields = supportedFields(
	"id", "name", "full_name", "nameWithOwner", "url", "isPrivate", "defaultBranchRef", "description",
	"visibility", "stargazers_count", "forks_count", "open_issues_count", "createdAt", "updatedAt",
	"pushedAt", "owner",
)

var supportedReleaseFields = supportedFields(
	"id", "tagName", "name", "url", "isDraft", "isPrerelease", "createdAt", "publishedAt", "body",
)

var supportedReleaseViewFields = supportedFields(
	"tagName", "name", "url", "isDraft", "isPrerelease", "createdAt", "publishedAt", "body",
)

var supportedCheckRunFields = supportedFields(
	"bucket", "completedAt", "description", "event", "link", "name", "startedAt", "state", "workflow",
)

var supportedWorkflowFields = supportedFields(
	"id", "name", "path", "state",
)

var supportedLabelFields = supportedFields(
	"id", "name", "description", "color", "url",
)

var supportedGistFields = supportedFields(
	"id", "description", "files", "isPublic", "public", "url", "createdAt", "updatedAt", "owner",
)

func supportedFields(fields ...string) map[string]bool {
	out := make(map[string]bool, len(fields))
	for _, field := range fields {
		out[field] = true
	}
	return out
}
