package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var allowedSearchTerm = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func handleGHSearch(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) < 2 {
		return ghDelegated()
	}
	kind := args[0]
	if kind != "issues" && kind != "prs" && kind != "repos" {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("search "+args[0], args[1:])
	if !ok {
		return early
	}
	if kind == "repos" {
		if opts.repo != "" || opts.repoCount > 0 || opts.state != "" || opts.patch || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		query, ok := plainSearchQuery(opts.positionals)
		if !ok || query == "" {
			return ghDelegated()
		}
		opts.positionals = nil
		return ghCompleted(relaySearchRepos(ctx, stdout, query, opts))
	}
	repo, ok, err := repoFromOptionOrCurrent(opts.repo)
	if err != nil {
		return ghFailed(err)
	}
	if !ok || repo == "" || opts.repoCount > 1 || !machineReadable(opts) || limitOverOnePage(opts) {
		return ghDelegated()
	}
	if opts.patch || opts.branch != "" || opts.workflow != "" || opts.status != "" {
		return ghDelegated()
	}
	if opts.state != "" && opts.state != "open" && opts.state != "closed" {
		return ghDelegated()
	}
	query := topSearchQuery(opts.positionals)
	if query == "" {
		return ghDelegated()
	}
	opts.positionals = nil
	switch kind {
	case "issues":
		if !supportedJSONFields(opts, supportedIssueSearchFields) {
			return ghDelegated()
		}
		return ghCompleted(relaySearchIssues(ctx, stdout, repo, query, opts))
	case "prs":
		if !supportedJSONFields(opts, supportedPRSearchFields) {
			return ghDelegated()
		}
		return ghCompleted(relaySearchPRs(ctx, stdout, repo, query, opts))
	default:
		return ghDelegated()
	}
}

func relaySearchIssues(ctx context.Context, stdout io.Writer, repo string, rawQuery string, opts ghTopOptions) error {
	if opts.read.has("--author") || opts.read.has("--assignee") || opts.read.has("--label") {
		return localFallbackError{Reason: "unsupported_search_filter"}
	}
	return relayGitHubSearch(ctx, stdout, repo, rawQuery, "issue", opts, fieldMapIssue)
}

func relaySearchPRs(ctx context.Context, stdout io.Writer, repo string, rawQuery string, opts ghTopOptions) error {
	if opts.read.has("--author") || opts.read.has("--assignee") || opts.read.has("--label") {
		return localFallbackError{Reason: "unsupported_pr_search_filter"}
	}
	return relayGitHubSearch(ctx, stdout, repo, rawQuery, "pr", opts, fieldMapPR)
}

func relaySearchRepos(ctx context.Context, stdout io.Writer, rawQuery string, opts ghTopOptions) error {
	terms, ok := searchTerms(rawQuery)
	if !ok || len(terms) == 0 {
		return localFallbackError{Reason: "unsupported_repo_search_query"}
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET",
		path:   "/search/repositories",
		query:  map[string]any{"q": strings.Join(terms, " "), "per_page": strconv.Itoa(desiredLimit(opts))},
	})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	items, _ := response["items"].([]any)
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapRepo)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func relayGitHubSearch(
	ctx context.Context,
	stdout io.Writer,
	repo string,
	rawQuery string,
	searchType string,
	opts ghTopOptions,
	fieldMap map[string][]string,
) error {
	q, ok := scopedSearchQuery(repo, searchType, rawQuery, opts)
	if !ok {
		return localFallbackError{Reason: "unsupported_search_query"}
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    "/search/issues",
		query:   map[string]any{"q": q, "per_page": strconv.Itoa(desiredLimit(opts))},
		headers: map[string]string{"x-octopool-public-shape": publicShapeIssueSearch},
	})
	if err != nil {
		return searchFallbackError(err)
	}
	if searchRateLimited(envelope) {
		return localFallbackError{Reason: "github_rate_limited"}
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	items, ok := response["items"].([]any)
	if !ok || response["incomplete_results"] == true {
		return localFallbackError{Reason: "incomplete_search_results"}
	}
	users := map[string]map[string]any{}
	for _, item := range items {
		issue, ok := item.(map[string]any)
		if !ok {
			return localFallbackError{Reason: "unsupported_search_item"}
		}
		// Native search derives lowercase merged only from nested PR metadata.
		mergedAt, err := time.Parse(time.RFC3339, nestedStringValue(issue, "pull_request", "merged_at"))
		if err == nil && !mergedAt.IsZero() {
			issue["state"] = "merged"
		}
		if opts.read.has("--search") {
			if err := mapListSearchItem(ctx, client, issue, searchType, opts.json, users); err != nil {
				return err
			}
		} else if err := mapTopSearchItem(issue, opts.json); err != nil {
			return err
		}
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false) // Match native gh's JSON exporter, including titles/bodies.
	if err := encoder.Encode(filterJSONValue(items, opts.json, fieldMap)); err != nil {
		return err
	}
	return writeBytes(ctx, stdout, output.Bytes(), opts.jq)
}

func searchTerms(raw string) ([]string, bool) {
	fields := strings.Fields(strings.ToLower(raw))
	terms := make([]string, 0, len(fields))
	for _, field := range fields {
		if strings.Contains(field, ":") || strings.HasPrefix(field, "-") || field == "or" || field == "not" {
			return nil, false
		}
		term := strings.Trim(field, `"'`)
		if term == "" {
			continue
		}
		if !allowedSearchTerm.MatchString(term) {
			return nil, false
		}
		terms = append(terms, term)
	}
	return terms, true
}

func plainSearchQuery(parts []string) (string, bool) {
	for _, part := range parts {
		if strings.ContainsAny(part, " \t\r\n") {
			return "", false
		}
	}
	terms, ok := searchTerms(strings.Join(parts, " "))
	if !ok {
		return "", false
	}
	return strings.Join(terms, " "), true
}

// Native search quotes each positional keyword (or its qualifier value).
// List --search is deliberately different: native treats it as a raw query.
func topSearchQuery(parts []string) string {
	quote := func(value string) string {
		if strings.ContainsAny(value, " \"\t\r\n") {
			return strconv.Quote(value)
		}
		return value
	}
	terms := make([]string, 0, len(parts))
	for _, part := range parts {
		if key, value, ok := strings.Cut(part, ":"); ok {
			terms = append(terms, key+":"+quote(value))
		} else {
			terms = append(terms, quote(part))
		}
	}
	return strings.TrimSpace(strings.Join(terms, " "))
}
