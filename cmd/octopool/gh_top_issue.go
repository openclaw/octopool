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
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) {
			return ghDelegated()
		}
		if nativeHumanFormat(opts) {
			return ghCompleted(relayHumanIssueView(ctx, stdout, repo, number))
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedIssueFields) {
			return ghDelegated()
		}
		return ghCompleted(relayIssueView(ctx, stdout, repo, number, opts))
	case "list":
		repo, ok := repoOnly(opts)
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
	normalizeIssueJSONState(issue)
	raw, err := json.Marshal(issue)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(raw, opts.json, fieldMapIssue)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, filtered, opts.jq)
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
