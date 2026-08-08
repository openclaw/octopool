package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRunGHRunViewComposesJobs(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/actions/runs/27398328238":
			headers, ok := body["headers"].(map[string]any)
			if !ok || headers["x-octopool-public-shape"] != "actions-summary-v1" {
				t.Fatalf("run headers = %#v", body["headers"])
			}
			return map[string]any{
				"id":          27398328238,
				"status":      "completed",
				"conclusion":  "success",
				"run_attempt": 2,
				"head_sha":    "20d9295e7d6258943d6682fe5532ba3f0caedd29",
			}
		case "/repos/openclaw/octopool/actions/runs/27398328238/attempts/2/jobs":
			headers, ok := body["headers"].(map[string]any)
			if !ok || headers["x-octopool-public-shape"] != "actions-jobs-v1" {
				t.Fatalf("jobs headers = %#v", body["headers"])
			}
			query, ok := body["query"].(map[string]any)
			if !ok || query["per_page"] != "100" {
				t.Fatalf("jobs query = %#v", body["query"])
			}
			return map[string]any{
				"total_count": 1,
				"jobs": []map[string]any{{
					"id":           80970314592,
					"name":         "Check",
					"status":       "completed",
					"conclusion":   "success",
					"started_at":   "2026-06-12T06:15:20Z",
					"completed_at": "2026-06-12T06:17:55Z",
					"html_url":     "https://github.com/openclaw/octopool/actions/runs/27398328238/job/80970314592",
					"steps": []map[string]any{{
						"name":         "Check out",
						"number":       2,
						"status":       "completed",
						"conclusion":   "success",
						"started_at":   "2026-06-12T06:15:23Z",
						"completed_at": "2026-06-12T06:15:26Z",
					}},
				}},
			}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{
		"view",
		"27398328238",
		"-R", "openclaw/octopool",
		"--json", "databaseId,status,conclusion,headSha,jobs",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	jobs, ok := got["jobs"].([]any)
	if !ok || len(jobs) != 1 {
		t.Fatalf("jobs = %#v", got["jobs"])
	}
	job := jobs[0].(map[string]any)
	if job["databaseId"] != float64(80970314592) || job["startedAt"] != "2026-06-12T06:15:20Z" {
		t.Fatalf("job = %#v", job)
	}
	steps := job["steps"].([]any)
	step := steps[0].(map[string]any)
	if step["completedAt"] != "2026-06-12T06:15:26Z" {
		t.Fatalf("step = %#v", step)
	}
}

func TestRunGHRunViewUsesRequestedAttempt(t *testing.T) {
	paths := []string{}
	relayTestServer(t, func(body map[string]any) any {
		path := body["path"].(string)
		paths = append(paths, path)
		if strings.HasSuffix(path, "/jobs") {
			return map[string]any{"total_count": 0, "jobs": []any{}}
		}
		return map[string]any{
			"id": 27398328238, "status": "completed", "conclusion": "failure", "run_attempt": 1,
		}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{
		"view", "27398328238", "--attempt", "1", "-R", "openclaw/octopool", "--json", "attempt,jobs",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got, want := strings.Join(paths, "\n"), strings.Join([]string{
		"/repos/openclaw/octopool/actions/runs/27398328238/attempts/1",
		"/repos/openclaw/octopool/actions/runs/27398328238/attempts/1/jobs",
	}, "\n"); got != want {
		t.Fatalf("paths:\n%s\nwant:\n%s", got, want)
	}
	if got := out.String(); !strings.Contains(got, `"attempt":1`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHRunListDoesNotAcceptJobs(t *testing.T) {
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "jobs",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHRunListDoesNotAcceptID(t *testing.T) {
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHRunListMapsDisplayTitle(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		return map[string]any{"workflow_runs": []map[string]any{{
			"id":            27398328238,
			"display_title": "feat: preserve anonymous quota",
			"run_number":    80,
		}}}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "databaseId,displayTitle,number",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"displayTitle":"feat: preserve anonymous quota"`) || !strings.Contains(got, `"number":80`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunJobsFallsBackWhenPaginationIsRequired(t *testing.T) {
	_, err := runJobs(relayEnvelope{
		Status:       200,
		BodyEncoding: "json",
		Body:         []byte(`{"total_count":101,"jobs":[{"id":1}]}`),
	})
	if !isLocalFallback(err) {
		t.Fatalf("err = %v", err)
	}
}
