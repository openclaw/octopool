package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

func relayPRUser(ctx context.Context, client ghRelayClient, raw any, users map[string]map[string]any) (map[string]any, error) {
	user, _ := raw.(map[string]any)
	login, nodeID := firstString(user, "login"), firstString(user, "node_id")
	if login == "" || nodeID == "" {
		return nil, errors.New("pull request response did not include user identity")
	}
	key := strings.ToLower(login)
	profile := users[key]
	if profile == nil {
		request := ghAPIRequest{method: "GET", path: "/users/" + url.PathEscape(login)}
		if !safeRelayRequest(request) {
			return nil, errors.New("unsupported pull request user lookup")
		}
		envelope, err := client.do(ctx, request)
		if err != nil {
			return nil, err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(body, &profile); err != nil {
			return nil, err
		}
		users[key] = profile
	}
	_, hasName := profile["name"]
	_, stringName := profile["name"].(string)
	_, hasID := profile["id"].(float64)
	if !strings.EqualFold(firstString(profile, "login"), login) || firstString(profile, "node_id") != nodeID || !hasName || (!stringName && profile["name"] != nil) || !hasID || firstString(profile, "type") == "" {
		return nil, errors.New("user response did not include matching complete identity")
	}
	return profile, nil
}

func relayPRStatusCheckRollup(ctx context.Context, client ghRelayClient, repo, sha string) ([]any, error) {
	headers := map[string]string{"cache-control": "max-age=0"}
	items, err := prCheckContextsForSHA(ctx, client, repo, sha, headers)
	if err != nil {
		return nil, err
	}
	workflows := map[json.Number]string{}
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if nestedStringValue(item, "app", "slug") == "github-actions" {
			if err := hydratePRCheckWorkflows(ctx, client, repo, sha, headers, workflows); err != nil {
				return nil, err
			}
			break
		}
	}
	rollup := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("invalid check context")
		}
		if _, status := item["context"]; status {
			rollup = append(rollup, map[string]any{
				"__typename": "StatusContext", "context": firstString(item, "context"),
				"state":     strings.ToUpper(firstString(item, "conclusion")),
				"targetUrl": firstString(item, "details_url"), "startedAt": ghCheckTimestamp(item, "started_at"),
			})
			continue
		}
		workflow := ""
		if nestedStringValue(item, "app", "slug") == "github-actions" {
			suite, _ := valueAtPath(item, "check_suite", "id")
			id, _ := suite.(json.Number)
			var found bool
			workflow, found = workflows[id]
			if !found {
				return nil, errors.New("workflow run response did not include GitHub Actions check suite")
			}
		}
		rollup = append(rollup, map[string]any{
			"__typename": "CheckRun", "name": firstString(item, "name"), "workflowName": workflow,
			"status": strings.ToUpper(firstString(item, "status")), "conclusion": strings.ToUpper(firstString(item, "conclusion")),
			"startedAt": ghCheckTimestamp(item, "started_at"), "completedAt": ghCheckTimestamp(item, "completed_at"),
			"detailsUrl": firstString(item, "details_url"),
		})
	}
	return rollup, nil
}

// gh exports time.Time fields: absent/null timestamps serialize as the zero
// time, not null or an empty string (api/queries_pr.go and api/export_pr.go).
func ghCheckTimestamp(item map[string]any, field string) string {
	if value := firstString(item, field); value != "" {
		return value
	}
	return time.Time{}.Format(time.RFC3339)
}

func hydratePRCheckWorkflows(ctx context.Context, client ghRelayClient, repo, sha string, headers map[string]string, workflows map[json.Number]string) error {
	request := ghAPIRequest{
		method: "GET", path: repoPath(repo, "actions", "runs"), headers: headers,
		query: map[string]any{"head_sha": sha},
	}
	if !safeRelayRequest(request) {
		return errors.New("unsupported workflow run lookup")
	}
	// Filtered workflow queries and the shared collector are bounded to 1,000
	// items. Never fabricate an empty name from an incomplete workflow lookup.
	items, err := relayCompleteCollection(ctx, client, request, "workflow_runs")
	if err != nil {
		return err
	}
	for _, raw := range items {
		run := raw.(map[string]any)
		if firstString(run, "head_sha") != sha {
			return errors.New("workflow run response did not match pull request head")
		}
		id, ok := run["check_suite_id"].(json.Number)
		if !ok {
			return errors.New("workflow run response did not include check_suite_id")
		}
		name, ok := run["name"].(string)
		if !ok {
			return errors.New("workflow run response did not include name")
		}
		workflows[id] = name
	}
	return nil
}
