package main

import (
	"bytes"
	"testing"
)

func TestRunGHPublicSummaryShapesFollowRequestedFields(t *testing.T) {
	var requests []map[string]any
	relayTestServer(t, func(body map[string]any) any {
		requests = append(requests, body)
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls":
			return []map[string]any{}
		case "/repos/openclaw/octopool/pulls/11":
			return map[string]any{"number": 11, "body": "Public body"}
		case "/repos/openclaw/octopool/issues/5":
			return map[string]any{"number": 5, "closed_at": "2026-05-27T23:19:04Z"}
		case "/repos/openclaw/octopool/issues":
			return []map[string]any{}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})

	for _, args := range [][]string{
		{"list", "-R", "openclaw/octopool", "--json", "number,title"},
		{"list", "-R", "openclaw/octopool", "--json", "number,body"},
	} {
		var out bytes.Buffer
		result := handleGHPR(t.Context(), args, &out)
		if result.err != nil || result.action != ghComplete {
			t.Fatalf("pr action=%v err=%v", result.action, result.err)
		}
	}
	for _, args := range [][]string{
		{"view", "11", "-R", "openclaw/octopool", "--json", "number,headRefOid"},
		{"view", "11", "-R", "openclaw/octopool", "--json", "number,body"},
	} {
		var out bytes.Buffer
		result := handleGHPR(t.Context(), args, &out)
		if result.err != nil || result.action != ghComplete {
			t.Fatalf("pr view action=%v err=%v", result.action, result.err)
		}
	}
	for _, args := range [][]string{
		{"view", "5", "-R", "openclaw/octopool", "--json", "number,title"},
		{"view", "5", "-R", "openclaw/octopool", "--json", "number,closedAt"},
	} {
		var out bytes.Buffer
		result := handleGHIssue(t.Context(), args, &out)
		if result.err != nil || result.action != ghComplete {
			t.Fatalf("issue view action=%v err=%v", result.action, result.err)
		}
	}
	var out bytes.Buffer
	result := handleGHIssue(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "number,closedAt",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("issue list action=%v err=%v", result.action, result.err)
	}

	wantShapes := []string{"pr-list-v1", "", "pr-summary-v2", "", "issue-summary-v1", "", "issue-list-v1"}
	if len(requests) != len(wantShapes) {
		t.Fatalf("requests = %d", len(requests))
	}
	for index, want := range wantShapes {
		headers, _ := requests[index]["headers"].(map[string]any)
		got, _ := headers["x-octopool-public-shape"].(string)
		if got != want {
			t.Fatalf("request %d shape = %q, want %q", index, got, want)
		}
	}
}
