package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

func hasCurrentUserFilter(opts ghTopOptions) bool {
	return opts.author == "@me" || opts.assignee == "@me"
}

func cloneQuery(input map[string]any) map[string]any {
	out := make(map[string]any, len(input)+2)
	for key, value := range input {
		out[key] = value
	}
	return out
}

func handleGHIssue(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("issue "+args[0], args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "view":
		repo, number, ok, err := repoNumber(opts)
		if err != nil {
			return ghFailed(err)
		}
		if !ok || hasTopModifiers(opts) {
			return ghDelegated()
		}
		if nativeHumanFormat(opts) {
			return ghCompleted(relayHumanIssueView(ctx, stdout, repo, number))
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedIssueViewFields) {
			return ghDelegated()
		}
		return ghCompleted(relayIssueView(ctx, stdout, repo, number, opts))
	case "list":
		if opts.read.has("--search") {
			return handleGHListSearch(ctx, stdout, "issue", opts)
		}
		repo, ok, err := repoOnly(opts)
		if err != nil {
			return ghFailed(err)
		}
		if !ok || limitOverOnePage(opts) || hasCurrentUserFilter(opts) {
			return ghDelegated()
		}
		if !nativeHumanFormat(opts) && (!machineReadable(opts) || !supportedJSONFields(opts, supportedIssueFields)) {
			return ghDelegated()
		}
		// This REST representation limit is not a native label setter rule;
		// unsupported search filters retain their own typed fallback boundary.
		for _, label := range opts.labels {
			if label == "" || strings.ContainsAny(label, ",\r\n") {
				return ghDelegated()
			}
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		if opts.author != "" {
			query["creator"] = opts.author
		}
		if opts.assignee != "" {
			query["assignee"] = opts.assignee
		}
		if len(opts.labels) > 0 {
			query["labels"] = strings.Join(opts.labels, ",")
		}
		return ghCompleted(relayIssueList(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "issues"),
			query:   query,
			headers: publicShapeHeaders(opts, supportedPublicIssueListFields, publicShapeIssueList),
		}, opts))
	default:
		return ghDelegated()
	}
}

func relayIssueView(ctx context.Context, stdout io.Writer, repo string, number string, opts ghTopOptions) error {
	request := ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "issues", number),
		headers: publicShapeHeaders(opts, supportedPublicIssueViewFields, publicShapeIssueSummary),
	}
	if hasJSONField(opts.json, "stateReason") {
		if request.headers == nil {
			request.headers = map[string]string{}
		}
		request.headers["cache-control"] = "max-age=0"
	}
	if !safeRelayRequest(request) {
		return errors.New("internal error: top-level gh command built an unsupported relay request")
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var issue map[string]any
	if err := json.Unmarshal(body, &issue); err != nil {
		return err
	}
	// Native gh reports PRs as MERGED/CLOSED with PR-only fields; REST only says "closed".
	if _, isPR := issue["pull_request"]; isPR {
		return localFallbackError{Reason: "issue_number_is_pull_request"}
	}
	normalizeIssueJSONState(issue)
	if hasJSONField(opts.json, "stateReason") {
		if err := normalizeIssueStateReason(issue); err != nil {
			return err
		}
	}
	if hasJSONField(opts.json, "assignees") {
		assignees, ok := issue["assignees"].([]any)
		if !ok || len(assignees) > 100 {
			return localFallbackError{Reason: "unsupported issue assignees"}
		}
		users := map[string]map[string]any{}
		mapped := make([]any, 0, len(assignees))
		for _, assignee := range assignees {
			profile, err := relayPRUser(ctx, client, assignee, users)
			if err != nil {
				return err
			}
			mapped = append(mapped, issueAssignee{firstString(profile, "node_id"), firstString(profile, "login"), firstString(profile, "name"), profile["id"]})
		}
		issue["assignees"] = mapped
	}
	filtered, err := marshalGHFields(issue, opts.json, fieldMapIssue)
	if err != nil {
		return err
	}
	return writeGHViewJSON(ctx, stdout, filtered, opts.jq)
}

type issueAssignee struct {
	ID         string `json:"id"`
	Login      string `json:"login"`
	Name       string `json:"name"`
	DatabaseID any    `json:"databaseId"`
}

func normalizeIssueStateReason(issue map[string]any) error {
	reason, present := issue["state_reason"]
	if !present {
		return localFallbackError{Reason: "issue response did not include state_reason"}
	}
	// Native gh decodes GraphQL null into its zero-value string.
	switch reason {
	case nil:
		issue["stateReason"] = ""
	case "completed", "not_planned", "reopened":
		issue["stateReason"] = strings.ToUpper(reason.(string))
	default:
		return localFallbackError{Reason: "unsupported issue state_reason"}
	}
	return nil
}

func normalizeIssueJSONState(issue map[string]any) {
	// Normalize only the decoded CLI copy; REST and public-page cache values stay intact.
	if state, ok := issue["state"].(string); ok {
		issue["state"] = strings.ToUpper(state)
	}
}

func relayIssueList(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	limit := desiredLimit(opts)
	filtered := make([]map[string]any, 0, limit)
	complete := false
	for page := 1; page <= maxRelayPages && len(filtered) < limit; page++ {
		paged := request
		paged.query = cloneQuery(request.query)
		paged.query["per_page"] = strconv.Itoa(relayPageSize)
		paged.query["page"] = strconv.Itoa(page)
		envelope, err := client.do(ctx, paged)
		if err != nil {
			return err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return err
		}
		var items []map[string]any
		if err := json.Unmarshal(body, &items); err != nil {
			return err
		}
		for _, item := range items {
			if _, ok := item["pull_request"]; !ok {
				filtered = append(filtered, item)
				if len(filtered) >= limit {
					break
				}
			}
		}
		if len(items) < relayPageSize {
			complete = true
			break
		}
	}
	if len(filtered) < limit && !complete {
		return localFallbackError{Reason: "pagination_exhausted"}
	}
	if len(opts.json) == 0 {
		return renderHumanIssueList(stdout, filtered)
	}
	for _, issue := range filtered {
		normalizeIssueJSONState(issue)
	}
	raw, err := json.Marshal(filtered)
	if err != nil {
		return err
	}
	raw, err = filterJSONFields(raw, opts.json, fieldMapIssue)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}
