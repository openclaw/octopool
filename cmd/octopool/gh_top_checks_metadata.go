package main

import (
	"context"
	"encoding/json"
)

type prCheckMetadata struct {
	runID, workflowID   int64
	workflowName, event string
}

func prCheckID(raw any) (int64, bool) {
	number, ok := raw.(json.Number)
	id, err := number.Int64()
	return id, ok && err == nil && id > 0
}

// Both checks and the PR-view rollup use verified workflow names. Never use a
// run's display title/name or follow URLs from response bodies to hydrate them.
func verifiedPRCheckMetadata(ctx context.Context, client ghRelayClient, repo, sha string, headers map[string]string, contexts []prCheckContext) (map[int64]prCheckMetadata, error) {
	needed := map[int64]bool{}
	for _, context := range contexts {
		if context.isStatus {
			continue
		}
		check := context.raw
		if firstString(check, "head_sha") != sha {
			return nil, localFallbackError{Reason: "check response did not match pull request head"}
		}
		app, _ := check["app"].(map[string]any)
		_, appOK := prCheckID(app["id"])
		slug := firstString(app, "slug")
		suite, _ := valueAtPath(check, "check_suite", "id")
		suiteID, suiteOK := prCheckID(suite)
		if !appOK || slug == "" || !suiteOK {
			return nil, localFallbackError{Reason: "check response did not include app and suite identity"}
		}
		if slug == "github-actions" {
			needed[suiteID] = true
		}
	}
	metadata := map[int64]prCheckMetadata{}
	if len(needed) == 0 {
		return metadata, nil
	}
	runs, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "actions", "runs"), headers: headers,
		query: map[string]any{"head_sha": sha},
	}, "workflow_runs")
	if err != nil {
		return nil, err
	}
	for _, raw := range runs {
		run := raw.(map[string]any)
		if firstString(run, "head_sha") != sha {
			return nil, localFallbackError{Reason: "workflow run response did not match pull request head"}
		}
		runID, _ := prCheckID(run["id"]) // Already validated by the raw collector.
		suiteID, suiteOK := prCheckID(run["check_suite_id"])
		workflowID, workflowOK := prCheckID(run["workflow_id"])
		if !suiteOK || !workflowOK {
			return nil, localFallbackError{Reason: "workflow run response did not include suite and workflow identity"}
		}
		if _, exists := metadata[suiteID]; exists {
			return nil, localFallbackError{Reason: "ambiguous workflow runs for check suite"}
		}
		metadata[suiteID] = prCheckMetadata{runID: runID, workflowID: workflowID, event: firstString(run, "event")}
	}
	// The raw catalogue includes inactive workflows; the public workflow-list
	// projection is incomplete and cannot establish these associations.
	workflows, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "actions", "workflows"), headers: headers,
	}, "workflows")
	if err != nil {
		return nil, err
	}
	names := make(map[int64]string, len(workflows))
	for _, raw := range workflows {
		workflow := raw.(map[string]any)
		id, _ := prCheckID(workflow["id"])
		names[id] = firstString(workflow, "name")
	}
	for suiteID := range needed {
		association, found := metadata[suiteID]
		association.workflowName = names[association.workflowID]
		if !found || association.workflowName == "" || association.event == "" {
			return nil, localFallbackError{Reason: "missing workflow association for GitHub Actions check suite"}
		}
		metadata[suiteID] = association
	}
	return metadata, nil
}
