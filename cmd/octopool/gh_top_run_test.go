package main

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"testing"
)

func TestRunGHRunViewAttemptOccurrences(t *testing.T) {
	maxAttempt := strconv.FormatUint(uint64(math.MaxInt), 10)
	aboveMaxAttempt := strconv.FormatUint(uint64(math.MaxInt)+1, 10)
	for _, test := range []struct {
		name       string
		flags      []string
		mode, path string
	}{
		{"control_requested", []string{"--attempt=2"}, "relay", "/repos/acme/repo/actions/runs/42/attempts/2"},
		{"regression_zero_latest", []string{"--attempt=0"}, "relay", "/repos/acme/repo/actions/runs/42"},
		{"regression_prefix", []string{"--attempt=0x2"}, "relay", "/repos/acme/repo/actions/runs/42/attempts/2"},
		{"regression_unsigned_plus", []string{"--attempt=+2"}, "reject", ""},
		{"control_unsigned_minus", []string{"--attempt=-2"}, "reject", ""},
		{"regression_earlier_plus", []string{"--attempt=+1", "--attempt=2"}, "reject", ""},
		{"regression_earlier_octal_error", []string{"--attempt=08", "--attempt=2"}, "reject", ""},
		{"regression_earlier_overflow", []string{"--attempt=18446744073709551616", "--attempt=2"}, "reject", ""},
		{"regression_unsigned_max", []string{"--attempt=18446744073709551615"}, "delegate", ""},
		{"regression_above_signed", []string{"--attempt=9223372036854775808"}, "delegate", ""},
		{"control_platform_max", []string{"--attempt=" + maxAttempt}, "relay", "/repos/acme/repo/actions/runs/42/attempts/" + maxAttempt},
		{"control_above_platform_max", []string{"--attempt=" + aboveMaxAttempt}, "delegate", ""},
		{"control_overridden_large_uint64", []string{"--attempt=18446744073709551615", "--attempt=2"}, "relay", "/repos/acme/repo/actions/runs/42/attempts/2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var paths []string
			relayTestServer(t, func(req map[string]any) any {
				paths = append(paths, req["path"].(string))
				if req["path"] == "/repos/acme/repo/actions/runs/42/attempts/"+maxAttempt {
					return map[string]any{"id": 42, "run_attempt": 3}
				}
				return nativeOptionsResponse(t, req)
			})
			args := append([]string{"run", "view", "42", "-R", "acme/repo", "--json", "databaseId,jobs"}, test.flags...)
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), args, &out)
			if test.mode == "relay" {
				if result.action != ghComplete || result.err != nil || len(paths) != 2 || paths[0] != test.path || paths[1] != "/repos/acme/repo/actions/runs/42/attempts/3/jobs" || strings.TrimSpace(out.String()) != `{"databaseId":42,"jobs":[]}` {
					t.Fatalf("action=%v err=%v paths=%v output=%q (jobs belong to returned attempt 3)", result.action, result.err, paths, out.String())
				}
			} else if len(paths) != 0 || out.Len() != 0 || (result.action != ghDelegate && (test.mode == "delegate" || result.action != ghFail)) {
				t.Fatalf("attempt must %s before data: action=%v err=%v paths=%v output=%q", test.mode, result.action, result.err, paths, out.String())
			}
		})
	}
}

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
