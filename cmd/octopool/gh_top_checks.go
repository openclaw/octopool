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
	if len(opts.json) == 0 {
		if err := renderHumanPRChecks(stdout, items); err != nil {
			return err
		}
	} else {
		raw, err := json.Marshal(items)
		if err != nil {
			return err
		}
		raw, err = filterJSONFields(raw, opts.json, fieldMapCheckRun)
		if err != nil {
			return err
		}
		if err := writeBytes(ctx, stdout, raw, opts.jq); err != nil {
			return err
		}
	}
	return checkExitCode(items)
}

func relayPRCheckItems(ctx context.Context, client ghRelayClient, repo string, number string) ([]any, error) {
	items, _, err := relayPRCheckItemsWithSHA(ctx, client, repo, number)
	return items, err
}

func relayPRHeadSHA(ctx context.Context, client ghRelayClient, repo string, number string, maxAgeSeconds int) (string, error) {
	prEnvelope, err := client.do(ctx, ghAPIRequest{
		method: "GET",
		path:   repoPath(repo, "pulls", number),
		headers: map[string]string{
			"cache-control":           "max-age=" + strconv.Itoa(maxAgeSeconds),
			"x-octopool-public-shape": publicShapePullRequestSummary,
		},
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
	items, err := prCheckContextsForSHA(ctx, client, repo, sha, headers)
	if err != nil {
		return nil, err
	}
	return ghCheckItems(items), nil
}

// Preserve the context discriminator and source fields until each gh export
// projects them; pr checks and pr view expose different public JSON contracts.
func prCheckContextsForSHA(ctx context.Context, client ghRelayClient, repo, sha string, headers map[string]string) ([]any, error) {
	checkRuns, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "commits", sha, "check-runs"), headers: headers,
	}, "check_runs")
	if err != nil {
		return nil, err
	}
	statuses, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "commits", sha, "status"), headers: headers,
	}, "statuses")
	if err != nil {
		return nil, err
	}
	return append(checkRuns, statusItems(statuses)...), nil
}

func statusItems(rawItems []any) []any {
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
	return items
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
