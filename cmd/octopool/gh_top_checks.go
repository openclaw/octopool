package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

// prChecksMaxPRAgeSeconds bounds how old a relay-cached PR record may be when
// resolving the head SHA for `gh pr checks`.
const prChecksMaxPRAgeSeconds = 60

func relayPRChecks(ctx context.Context, stdout io.Writer, repo string, number string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	items, err := relayPRCheckItems(ctx, client, repo, number)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapCheckRun)
		if err != nil {
			return err
		}
	}
	if err := writeBytes(ctx, stdout, raw, opts.jq); err != nil {
		return err
	}
	return checkExitCode(items)
}

func relayPRCheckItems(ctx context.Context, client ghRelayClient, repo string, number string) ([]any, error) {
	items, _, err := relayPRCheckItemsWithSHA(ctx, client, repo, number)
	return items, err
}

func relayPRHeadSHA(ctx context.Context, client ghRelayClient, repo string, number string, maxAgeSeconds int) (string, error) {
	prEnvelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "pulls", number),
		headers: map[string]string{"cache-control": "max-age=" + strconv.Itoa(maxAgeSeconds)},
	})
	if err != nil {
		return "", err
	}
	prBody, err := envelopeBodyBytes(prEnvelope)
	if err != nil {
		return "", err
	}
	var pr map[string]any
	if err := json.Unmarshal(prBody, &pr); err != nil {
		return "", err
	}
	sha, ok := nestedString(pr, "head", "sha")
	if !ok || sha == "" {
		return "", errors.New("pull request response did not include head.sha")
	}
	return sha, nil
}

func relayPRCheckItemsWithSHA(ctx context.Context, client ghRelayClient, repo string, number string) ([]any, string, error) {
	// Bound the PR lookup's staleness instead of forcing a live read: concurrent
	// CI-polling sessions coalesce onto one shared-cache fill while the head SHA
	// stays at most a few seconds behind a push.
	sha, err := relayPRHeadSHA(ctx, client, repo, number, prChecksMaxPRAgeSeconds)
	if err != nil {
		return nil, "", err
	}
	items, err := prCheckItemsForSHA(ctx, client, repo, sha)
	if err != nil {
		return nil, "", err
	}
	return items, sha, nil
}

func prCheckItemsForSHA(ctx context.Context, client ghRelayClient, repo string, sha string) ([]any, error) {
	return prCheckItemsForSHAWithHeaders(ctx, client, repo, sha, nil)
}

// prCheckItemsForSHAFresh bypasses cached staleness so a terminal watch
// snapshot cannot be confirmed by an obsolete cached payload after a rerun.
func prCheckItemsForSHAFresh(ctx context.Context, client ghRelayClient, repo string, sha string) ([]any, error) {
	return prCheckItemsForSHAWithHeaders(ctx, client, repo, sha, map[string]string{"cache-control": "max-age=0"})
}

func prCheckItemsForSHAWithHeaders(
	ctx context.Context,
	client ghRelayClient,
	repo string,
	sha string,
	headers map[string]string,
) ([]any, error) {
	checkRuns := []any{}
	totalCheckRuns := 0
	for page := 1; page <= maxRelayPages; page++ {
		request := ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "commits", sha, "check-runs"),
			query:   map[string]any{"per_page": strconv.Itoa(relayPageSize), "page": strconv.Itoa(page)},
			headers: headers,
		}
		checkRunsEnvelope, err := client.do(ctx, request)
		if err != nil {
			return nil, err
		}
		items, total, err := checkRunItems(checkRunsEnvelope)
		if err != nil {
			return nil, err
		}
		if page == 1 {
			totalCheckRuns = total
		}
		checkRuns = append(checkRuns, items...)
		if len(checkRuns) >= totalCheckRuns || len(items) < relayPageSize {
			break
		}
	}
	if len(checkRuns) < totalCheckRuns {
		return nil, localFallbackError{Reason: "pagination_exhausted"}
	}
	statuses := []any{}
	totalStatuses := 0
	for page := 1; page <= maxRelayPages; page++ {
		statusEnvelope, err := client.do(ctx, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "commits", sha, "status"),
			query:   map[string]any{"per_page": strconv.Itoa(relayPageSize), "page": strconv.Itoa(page)},
			headers: headers,
		})
		if err != nil {
			return nil, err
		}
		items, total, err := statusItems(statusEnvelope)
		if err != nil {
			return nil, err
		}
		if page == 1 {
			totalStatuses = total
		}
		statuses = append(statuses, items...)
		if len(statuses) >= totalStatuses || len(items) < relayPageSize {
			break
		}
	}
	if len(statuses) < totalStatuses {
		return nil, localFallbackError{Reason: "pagination_exhausted"}
	}
	return ghCheckItems(append(checkRuns, statuses...)), nil
}

func checkRunItems(envelope relayEnvelope) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	items, ok := response["check_runs"].([]any)
	if !ok {
		return nil, 0, errors.New("check-runs response did not include check_runs")
	}
	total := len(items)
	if value, ok := response["total_count"].(float64); ok {
		total = int(value)
	}
	return items, total, nil
}

func statusItems(envelope relayEnvelope) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	rawItems, ok := response["statuses"].([]any)
	if !ok {
		return nil, 0, errors.New("status response did not include statuses")
	}
	total := len(rawItems)
	if value, ok := response["total_count"].(float64); ok {
		total = int(value)
	}
	items := make([]any, 0, len(rawItems))
	for _, raw := range rawItems {
		status, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state, _ := status["state"].(string)
		displayStatus := "completed"
		if strings.EqualFold(state, "pending") {
			displayStatus = "pending"
		}
		item := map[string]any{
			"name":         status["context"],
			"context":      status["context"],
			"status":       displayStatus,
			"conclusion":   status["state"],
			"details_url":  status["target_url"],
			"started_at":   status["created_at"],
			"completed_at": status["updated_at"],
		}
		items = append(items, item)
	}
	return items, total, nil
}

func ghCheckItems(items []any) []any {
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state := ghCheckState(item)
		out = append(out, map[string]any{
			"bucket":      ghCheckBucket(state),
			"completedAt": firstString(item, "completed_at", "completedAt"),
			"description": ghCheckDescription(item),
			"event":       nestedStringValue(item, "check_suite", "event"),
			"link":        firstString(item, "details_url", "target_url", "link"),
			"name":        firstString(item, "name", "context"),
			"startedAt":   firstString(item, "started_at", "created_at", "startedAt"),
			"state":       state,
			"workflow":    ghCheckWorkflow(item),
		})
	}
	return out
}

func ghCheckState(item map[string]any) string {
	status := strings.ToLower(firstString(item, "status"))
	conclusion := strings.ToLower(firstString(item, "conclusion"))
	if status != "" && status != "completed" {
		return strings.ToUpper(status)
	}
	if conclusion == "" {
		return strings.ToUpper(status)
	}
	return strings.ToUpper(conclusion)
}

func ghCheckBucket(state string) string {
	switch strings.ToLower(state) {
	case "success", "neutral":
		return "pass"
	case "failure", "error", "timed_out", "action_required":
		return "fail"
	case "cancelled":
		return "cancel"
	case "skipped":
		return "skipping"
	default:
		return "pending"
	}
}

func ghCheckDescription(item map[string]any) string {
	if description := firstString(item, "description"); description != "" {
		return description
	}
	return nestedStringValue(item, "output", "summary")
}

func ghCheckWorkflow(item map[string]any) string {
	if workflow := firstString(item, "workflow"); workflow != "" {
		return workflow
	}
	return nestedStringValue(item, "check_suite", "workflow_name")
}

func checkExitCode(items []any) error {
	exitCode := 0
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		bucket, _ := item["bucket"].(string)
		state, _ := item["state"].(string)
		switch strings.ToLower(bucket) {
		case "fail":
			exitCode = 1
		case "cancel":
			// real gh exits by Failed then Pending counts only; cancelled
			// checks are terminal and do not fail the command.
		case "pending":
			if exitCode == 0 {
				exitCode = 8
			}
		}
		if bucket == "" && strings.ToLower(state) != "success" && strings.ToLower(state) != "neutral" && exitCode == 0 {
			exitCode = 8
		}
	}
	if exitCode != 0 {
		return exitCodeError{Code: exitCode}
	}
	return nil
}
