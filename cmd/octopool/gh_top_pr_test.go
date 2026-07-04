package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunGHPRViewHydratesDetails(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{
				"number":   7,
				"title":    "hydrate pr",
				"html_url": "https://github.com/openclaw/octopool/pull/7",
			}
		case "/repos/openclaw/octopool/pulls/7/files":
			return []map[string]any{{"filename": "cmd/octopool/gh.go"}}
		case "/repos/openclaw/octopool/pulls/7/commits":
			return []map[string]any{{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/issues/7/comments":
			return []map[string]any{{"body": "looks good"}}
		case "/repos/openclaw/octopool/pulls/7/reviews":
			return []map[string]any{{"state": "APPROVED"}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"view",
		"7",
		"-R", "openclaw/octopool",
		"--json", "number,files,commits,comments,reviews",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	got := out.String()
	for _, want := range []string{"cmd/octopool/gh.go", "abc1234", "looks good", "APPROVED"} {
		if !strings.Contains(got, want) {
			t.Fatalf("out missing %q: %s", want, got)
		}
	}
}

func TestRunGHPRViewFallsBackForStatusCheckRollup(t *testing.T) {
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"view",
		"7",
		"-R", "openclaw/octopool",
		"--json", "number,statusCheckRollup",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHPRChecksUsesCacheableRequests(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/pulls/7" {
			if _, ok := body["headers"]; ok {
				t.Fatalf("unexpected cache-bypass headers: %#v", body["headers"])
			}
		}
		if body["path"] == "/repos/openclaw/octopool/pulls/7" {
			headers, _ := body["headers"].(map[string]any)
			if headers["cache-control"] != "max-age=20" {
				t.Fatalf("expected bounded-freshness PR lookup header, got %#v", body["headers"])
			}
			if _, ok := headers["if-none-match"]; ok {
				t.Fatalf("unexpected cache-bypass header: %#v", headers)
			}
		}
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"statuses": []map[string]any{}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"checks",
		"7",
		"-R", "openclaw/octopool",
		"--json", "name,state",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"name":"CI"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestStatusItemsMapLegacyContexts(t *testing.T) {
	envelope := relayEnvelope{
		Status:       200,
		BodyEncoding: "json",
		Body:         []byte(`{"statuses":[{"context":"ci/external","state":"success","target_url":"https://example.test","created_at":"2026-05-27T00:00:00Z","updated_at":"2026-05-27T00:01:00Z"}]}`),
	}
	items, err := statusItems(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item := items[0].(map[string]any)
	if item["name"] != "ci/external" || item["conclusion"] != "success" || item["details_url"] != "https://example.test" {
		t.Fatalf("item = %#v", item)
	}
}
