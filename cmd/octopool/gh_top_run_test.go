package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"os"
	"reflect"
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
				if req["path"] == "/repos/acme/repo/actions/runs/42/attempts/3/jobs" {
					return map[string]any{"total_count": 0, "jobs": []any{}}
				}
				if req["path"] != test.path {
					t.Errorf("unexpected attempt run route: %v", req["path"])
				}
				return newRunExportFixture().run
			})
			args := append([]string{"run", "view", "42", "-R", "acme/repo", "--json", "databaseId,jobs,attempt,url"}, test.flags...)
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), args, &out)
			if test.mode == "relay" {
				if result.action != ghComplete || result.err != nil || len(paths) != 2 || paths[0] != test.path || paths[1] != "/repos/acme/repo/actions/runs/42/attempts/3/jobs" {
					t.Fatalf("action=%v err=%v paths=%v output=%q (jobs belong to returned attempt 3)", result.action, result.err, paths, out.String())
				}
				wantURL := "https://github.com/acme/repo/actions/runs/42" + strings.TrimPrefix(test.path, "/repos/acme/repo/actions/runs/42")
				assertRunExportJSON(t, out.String(), `{"databaseId":42,"jobs":[],"attempt":3,"url":`+strconv.Quote(wantURL)+`}`)
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
			headers, _ := body["headers"].(map[string]any)
			if headers["x-octopool-public-shape"] != nil {
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
			headers, _ := body["headers"].(map[string]any)
			if headers["x-octopool-public-shape"] != nil {
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
	for _, variant := range []string{"missing jobs", "excess jobs", "next link", "oversized page"} {
		t.Run(variant, func(t *testing.T) {
			body := `{"total_count":101,"jobs":[{"id":1}]}`
			headers := map[string]string{}
			switch variant {
			case "excess jobs":
				body = `{"total_count":0,"jobs":[{"id":1}]}`
			case "next link":
				body = `{"total_count":1,"jobs":[{"id":1}]}`
				headers["Link"] = `<https://api.github.com/repos/acme/repo/actions/runs/42/attempts/2/jobs?page=2>; rel="next"`
			case "oversized page":
				var jobs []string
				for id := 1; id <= relayPageSize+1; id++ {
					jobs = append(jobs, fmt.Sprintf(`{"id":%d}`, id))
				}
				body = fmt.Sprintf(`{"total_count":%d,"jobs":[%s]}`, len(jobs), strings.Join(jobs, ","))
			}
			jobs, err := runJobs(relayEnvelope{Status: 200, BodyEncoding: "json", Body: []byte(body), Headers: headers}, runJobOwner{id: "42"})
			if !isLocalFallback(err) || jobs != nil {
				t.Fatalf("err=%v jobs=%v", err, jobs)
			}
		})
	}
}

func TestRunJobsIdentityAndOwnership(t *testing.T) {
	for _, test := range []struct {
		name, jobs, head string
		valid            bool
	}{
		{"optional metadata", `[{"id":7}]`, "", true},
		{"null metadata", `[{"id":7,"run_id":null,"head_sha":null}]`, "", true},
		{"empty head", `[{"id":7,"run_id":42,"head_sha":""}]`, "", true},
		{"reused job", `[{"id":7,"run_id":42,"head_sha":"owned","run_attempt":1}]`, "owned", true},
		{"safe id", `[{"id":9007199254740991}]`, "", true},
		{"id then null", `[{"id":7,"id":null}]`, "", true},
		{"duplicate ids", `[{"id":7},{"id":7}]`, "", false},
		{"missing id", `[{}]`, "", false},
		{"null id", `[{"id":null}]`, "", false},
		{"zero id", `[{"id":0}]`, "", false},
		{"negative id", `[{"id":-7}]`, "", false},
		{"fractional id", `[{"id":7.5}]`, "", false},
		{"string id", `[{"id":"7"}]`, "", false},
		{"bool id", `[{"id":true}]`, "", false},
		{"unsafe id", `[{"id":9007199254740992}]`, "", false},
		{"overflow id", `[{"id":9223372036854775808}]`, "", false},
		{"foreign run", `[{"id":7,"run_id":43}]`, "", false},
		{"foreign head", `[{"id":7,"head_sha":"foreign"}]`, "owned", false},
		{"unproved head", `[{"id":7,"head_sha":"foreign"}]`, "", false},
		{"malformed run", `[{"id":7,"run_id":"42"}]`, "", false},
		{"unsafe run", `[{"id":7,"run_id":9007199254740993}]`, "", false},
		{"nonpositive run", `[{"id":7,"run_id":0}]`, "", false},
		{"malformed head", `[{"id":7,"head_sha":42}]`, "owned", false},
		{"run then null", `[{"id":7,"run_id":43,"run_id":null}]`, "", false},
		{"head then null", `[{"id":7,"head_sha":"foreign","head_sha":null}]`, "owned", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var records []json.RawMessage
			if err := json.Unmarshal([]byte(test.jobs), &records); err != nil {
				t.Fatal(err)
			}
			envelope := relayEnvelope{BodyEncoding: "json", Body: []byte(fmt.Sprintf(`{"total_count":%d,"jobs":%s}`, len(records), test.jobs))}
			jobs, humanErr := runJobs(envelope, runJobOwner{id: "00042", headSHA: test.head})
			machineJobs, machineErr := machineRunJobs(envelope, machineRun{ID: 42, HeadSha: test.head, Attempt: 2})
			if (humanErr == nil) != test.valid || (machineErr == nil) != test.valid {
				t.Fatalf("valid=%t human=%v machine=%v", test.valid, humanErr, machineErr)
			}
			if !test.valid {
				if jobs != nil || machineJobs != nil {
					t.Fatal("invalid identity returned a partial collection")
				}
				return
			}
			if len(jobs) != len(machineJobs) || len(jobs) != len(records) {
				t.Fatal("valid collection lost jobs")
			}
			for index, job := range jobs {
				if job.(map[string]any)["databaseId"] != float64(machineJobs[index].DatabaseID) {
					t.Fatal("human and machine identity projections disagree")
				}
			}
		})
	}
}

func TestHumanRunViewRejectsContradictoryJobs(t *testing.T) {
	for _, jobs := range []string{`[{"id":7},{"id":7}]`, `[{"id":7,"run_id":43}]`, `[{"id":7,"head_sha":"foreign"}]`} {
		t.Run(jobs, func(t *testing.T) {
			relayTestServer(t, func(request map[string]any) any {
				if strings.HasSuffix(request["path"].(string), "/jobs") {
					var records []json.RawMessage
					if err := json.Unmarshal([]byte(jobs), &records); err != nil {
						t.Fatal(err)
					}
					return map[string]any{"total_count": len(records), "jobs": records}
				}
				return map[string]any{"id": 42, "status": "completed", "conclusion": "success", "run_attempt": 2, "head_sha": "owned"}
			})
			var out bytes.Buffer
			result := handleGHRun(t.Context(), []string{"view", "42", "-R", "acme/repo"}, &out)
			if !isLocalFallback(result.err) || out.Len() != 0 {
				t.Fatalf("human view must fail before output with ordinary fallback available: err=%v stdout=%q", result.err, out.String())
			}
		})
	}
}

func assertRunExportJSON(t *testing.T, got, want string) {
	t.Helper()
	decode := func(raw string) any {
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("invalid JSON %q: %v", raw, err)
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			t.Fatalf("trailing output after JSON %q: %v", raw, err)
		}
		return value
	}
	if !reflect.DeepEqual(decode(got), decode(want)) {
		t.Errorf("native export values/selected keys:\n got %s\nwant %s", got, want)
	}
}

func runExportCommand(t *testing.T, f *runExportFixture, args []string) (string, error) {
	t.Helper()
	relayTestServer(t, func(req map[string]any) any { return f.response(t, req) })
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	capture := captureRewriteGH(t)
	var out, stderr bytes.Buffer
	err := runGH(t.Context(), args, &out, &stderr)
	t.Logf("paths=%v error=%T:%v stdout=%q stderr=%q", f.paths(), err, err, out.String(), stderr.String())
	if _, statErr := os.Stat(capture); !os.IsNotExist(statErr) {
		t.Error("supported export unexpectedly launched native child")
	}
	return out.String(), err
}

func runExportArgs(command, fields string) []string {
	args := []string{"run", command}
	if command == "view" {
		args = append(args, "42")
	}
	return append(args, "-R", "acme/repo", "--json", fields)
}

func TestRunExportSelectedValues(t *testing.T) {
	for _, test := range []struct {
		name, command, fields, want string
		nulls                       bool
	}{
		{"list_null_defaults", "list", "databaseId,name,conclusion,headBranch,createdAt,updatedAt,displayTitle,number", `[{"databaseId":42,"name":"","conclusion":"","headBranch":"","createdAt":"0001-01-01T00:00:00Z","updatedAt":"0001-01-01T00:00:00Z","displayTitle":"","number":0}]`, true},
		{"view_null_defaults", "view", "databaseId,name,conclusion,headBranch,createdAt,updatedAt,displayTitle,number,attempt", `{"databaseId":42,"name":"","conclusion":"","headBranch":"","createdAt":"0001-01-01T00:00:00Z","updatedAt":"0001-01-01T00:00:00Z","displayTitle":"","number":0,"attempt":0}`, true},
		{"unfamiliar_states", "view", "status,conclusion", `{"status":"future_state","conclusion":"future_conclusion"}`, false},
		{"one_selected_field", "list", "headSha", `[{"headSha":"224a80eeebec678db6646ef888f5bbc89caf63c4"}]`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newRunExportFixture()
			if test.nulls {
				for _, key := range []string{"name", "conclusion", "head_branch", "created_at", "run_number", "run_attempt"} {
					f.run[key] = nil
				}
				delete(f.run, "updated_at")
				delete(f.run, "display_title")
				f.run["head_commit"] = map[string]any{"message": "must not become displayTitle"}
			} else {
				f.run["status"], f.run["conclusion"] = "future_state", "future_conclusion"
			}
			out, err := runExportCommand(t, f, runExportArgs(test.command, test.fields))
			if err != nil {
				t.Fatal(err)
			}
			assertRunExportJSON(t, out, test.want)
			if len(f.requests) != 1 {
				t.Errorf("unselected metadata/jobs acquired: %v", f.paths())
			}
		})
	}
}

func TestRunExportAllFieldsAndRepeatedSelection(t *testing.T) {
	for _, command := range []string{"list", "view"} {
		t.Run(command, func(t *testing.T) {
			f := newRunExportFixture()
			fields := "workflowName,number,url,name,headSha,headBranch,event,createdAt,updatedAt,displayTitle,databaseId,status,conclusion"
			want := `{"workflowName":"Real CI","number":17,"url":"https://github.com/acme/repo/actions/runs/42","name":"source run label","headSha":"224a80eeebec678db6646ef888f5bbc89caf63c4","headBranch":"feature","event":"pull_request","createdAt":"2026-01-02T03:04:05Z","updatedAt":"2026-01-02T03:06:05Z","displayTitle":"source display title","databaseId":42,"status":"completed","conclusion":"failure"}`
			if command == "view" {
				fields += ",jobs,attempt"
				want = strings.TrimSuffix(want, "}") + `,"jobs":[],"attempt":3}`
			} else {
				want = "[" + want + "]"
			}
			args := append(runExportArgs(command, fields), "--json=name,workflowName,number", "--json=")
			out, err := runExportCommand(t, f, args)
			if err != nil {
				t.Fatal(err)
			}
			assertRunExportJSON(t, out, want)
			wantCalls := 2
			if command == "view" {
				wantCalls = 3
			}
			if len(f.requests) != wantCalls {
				t.Errorf("lazy name/jobs budget got %d want %d: %v", len(f.requests), wantCalls, f.paths())
			}
		})
	}
}

func TestRunExportEncoderAndTime(t *testing.T) {
	f := newRunExportFixture()
	f.run["name"] = "<&>"
	f.run["created_at"] = "2026-01-02T03:04:05.1234567899+02:00"
	f.run["updated_at"] = "0001-01-01T01:00:00+01:00"
	out, err := runExportCommand(t, f, runExportArgs("view", "name,createdAt,updatedAt"))
	if err != nil {
		t.Fatal(err)
	}
	assertRunExportJSON(t, out, `{"name":"<&>","createdAt":"2026-01-02T03:04:05.123456789+02:00","updatedAt":"0001-01-01T01:00:00+01:00"}`)
	if !strings.Contains(out, `"<&>"`) {
		t.Error("run-local encoder must disable HTML escaping")
	}
}

func TestRunExportNestedShapes(t *testing.T) {
	for _, steps := range []string{"absent", "null", "empty", "ordered_defaults_and_times"} {
		t.Run(steps, func(t *testing.T) {
			f := newRunExportFixture()
			job := map[string]any{"id": 9, "run_id": 42, "head_sha": runExportHead, "run_attempt": 1, "name": nil, "conclusion": nil, "ignored": true}
			wantSteps := `[]`
			switch steps {
			case "null":
				job["steps"] = nil
			case "empty":
				job["steps"] = []any{}
			case "ordered_defaults_and_times":
				job["steps"] = []any{
					map[string]any{"number": 3, "status": "future_step", "started_at": "2026-01-02T03:04:05.120000000+02:00", "completed_at": "0001-01-01T01:00:00+01:00", "ignored": "not exported"},
					map[string]any{"number": 1, "name": nil, "conclusion": nil, "started_at": "0001-01-01T01:00:00+01:00"},
				}
				wantSteps = `[{"name":"","status":"future_step","conclusion":"","number":3,"startedAt":"2026-01-02T03:04:05.12+02:00","completedAt":"0001-01-01T00:00:00Z"},{"name":"","status":"","conclusion":"","number":1,"startedAt":"0001-01-01T01:00:00+01:00","completedAt":"0001-01-01T00:00:00Z"}]`
			}
			job["started_at"] = "0001-01-01T01:00:00+01:00"
			job["completed_at"] = "0001-01-01T01:00:00+01:00"
			f.jobs = map[string]any{"total_count": 2, "jobs": []any{job, map[string]any{"id": 7}}}
			out, err := runExportCommand(t, f, runExportArgs("view", "jobs"))
			if err != nil {
				t.Fatal(err)
			}
			assertRunExportJSON(t, out, `{"jobs":[{"databaseId":9,"name":"","status":"","conclusion":"","startedAt":"0001-01-01T01:00:00+01:00","completedAt":"0001-01-01T00:00:00Z","url":"","steps":`+wantSteps+`},{"databaseId":7,"name":"","status":"","conclusion":"","startedAt":"0001-01-01T00:00:00Z","completedAt":"0001-01-01T00:00:00Z","url":"","steps":[]}]}`)
		})
	}
}

func assertRunExportFailure(t *testing.T, out string, err error, reason string) {
	t.Helper()
	if out != "" {
		t.Errorf("failure leaked JSON/jq output: %q", out)
	}
	if err == nil {
		t.Error("invalid native input/proof exported successfully")
		return
	}
	var fallback localFallbackError
	if reason == "terminal" {
		if errors.As(err, &fallback) {
			t.Errorf("native decoder/contradictory identity must be terminal, got %v", err)
		}
	} else if !errors.As(err, &fallback) || fallback.Reason != reason || fallback.Relay != nil {
		t.Errorf("want typed local reason %q with nil relay, got %T: %v", reason, err, err)
	}
}

func TestRunExportNumericAndDecodeOwners(t *testing.T) {
	for _, test := range []struct {
		name, owner, key, raw, reason string
	}{
		{"safe_run_id", "run", "id", "9007199254740991", ""},
		{"safe_negative_run_number", "run", "run_number", "-9007199254740991", ""},
		{"safe_attempt", "run", "run_attempt", "9007199254740991", ""},
		{"safe_job_id", "job", "id", "9007199254740991", ""},
		{"safe_step_number", "step", "number", "9007199254740991", ""},
		{"unsafe_run_id", "run", "id", "9007199254740992", "unsupported_run_export"},
		{"unsafe_list_id", "list", "id", "9007199254740993", "unsupported_run_export"},
		{"unsafe_run_number", "run", "run_number", "-9007199254740992", "unsupported_run_export"},
		{"unsafe_attempt", "run", "run_attempt", "9007199254740992", "unsupported_run_export"},
		{"unsafe_job_id", "job", "id", "9007199254740993", "unsupported_run_export"},
		{"unsafe_step_number", "step", "number", "9007199254740992", "unsupported_run_export"},
		{"unsafe_unselected_workflow_id", "run", "workflow_id", "9007199254740992", "unsupported_run_export"},
		{"fractional_run_id", "run", "id", "42.5", "terminal"},
		{"string_run_number_unselected", "unselected", "run_number", `"17"`, "terminal"},
		{"overflow_run_number", "run", "run_number", "9223372036854775808", "terminal"},
		{"negative_unsigned_attempt", "run", "run_attempt", "-1", "terminal"},
		{"overflow_unsigned_attempt", "run", "run_attempt", "18446744073709551616", "terminal"},
		{"fractional_job_id", "job", "id", "7.5", "terminal"},
		{"overflow_job_id", "job", "id", "9223372036854775808", "terminal"},
		{"string_step_number", "step", "number", `"2"`, "terminal"},
		{"overflow_platform_step", "step", "number", "9223372036854775808", "terminal"},
		{"wrong_workflow_type_unselected", "unselected", "workflow_id", `"9"`, "terminal"},
		{"wrong_string_state", "run", "status", "true", "terminal"},
		{"invalid_created_time", "run", "created_at", `"not-a-date"`, "terminal"},
		{"invalid_unselected_started_time", "unselected", "run_started_at", `""`, "terminal"},
		{"numeric_job_time", "job", "started_at", "123", "terminal"},
		{"nonarray_steps", "job", "steps", `{}`, "terminal"},
		{"late_step_time", "step", "completed_at", `"invalid"`, "terminal"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newRunExportFixture()
			fields := "databaseId,number,attempt,status,createdAt"
			command := "view"
			if test.owner == "list" {
				command, fields = "list", "databaseId"
			}
			if test.owner == "unselected" {
				fields = "databaseId"
			}
			job := runExportJob(7)
			if test.owner == "job" || test.owner == "step" {
				fields = "jobs"
				if test.owner == "job" {
					job[test.key] = json.RawMessage(test.raw)
				} else {
					step := map[string]any{"number": 1, "name": "last step", "status": "completed", "conclusion": "success", "started_at": "2026-01-02T03:04:06Z", "completed_at": "2026-01-02T03:05:06Z"}
					step[test.key] = json.RawMessage(test.raw)
					job["steps"] = []any{map[string]any{"number": 2}, step}
				}
				f.jobs = map[string]any{"total_count": 1, "jobs": []any{job}}
			} else {
				f.run[test.key] = json.RawMessage(test.raw)
			}
			args := runExportArgs(command, fields)
			if test.owner == "run" && test.key == "id" && test.raw != "42.5" {
				args[2] = test.raw
			}
			out, err := runExportCommand(t, f, args)
			wantCalls := 1
			if fields == "jobs" {
				wantCalls = 2
			}
			if len(f.requests) != wantCalls {
				t.Errorf("owner not reached: got paths %v want %d data calls", f.paths(), wantCalls)
			}
			if test.reason != "" {
				assertRunExportFailure(t, out, err, test.reason)
				return
			}
			if err != nil || !strings.Contains(out, ":"+test.raw) {
				t.Errorf("safe native integer must survive literally: error=%v output=%s", err, out)
			}
		})
	}
}

func TestRunExportIdentityAndCompleteness(t *testing.T) {
	for _, test := range []struct{ name, reason string }{
		{"empty_jobs", ""}, {"hundred_jobs", ""}, {"reused_success_and_optional_association", ""},
		{"null_optional_association", ""}, {"null_step_element", "terminal"},
		{"contradictory_run_then_null", "terminal"}, {"contradictory_head_then_null", "terminal"},
		{"over_hundred", "workflow jobs response requires pagination"},
		{"over_hundred_complete_array", "workflow jobs response requires pagination"},
		{"short_page", "workflow jobs response requires pagination"},
		{"excess_items", "unsupported_run_export"}, {"last_next", "unsupported_run_export"},
		{"missing_total", "workflow jobs response did not include a valid total_count"},
		{"fractional_total", "workflow jobs response did not include a valid total_count"},
		{"null_total", "workflow jobs response did not include a valid total_count"},
		{"negative_total", "workflow jobs response did not include a valid total_count"},
		{"missing_jobs", "unsupported_run_export"}, {"null_jobs", "unsupported_run_export"}, {"object_jobs", "unsupported_run_export"},
		{"null_job", "unsupported_run_export"}, {"duplicate_job_id", "unsupported_run_export"},
		{"missing_job_id", "unsupported_run_export"}, {"zero_job_id", "unsupported_run_export"},
		{"missing_run_id", "unsupported_run_export"}, {"null_run_id", "unsupported_run_export"}, {"zero_run_id", "unsupported_run_export"},
		{"mismatched_run_id", "terminal"}, {"mismatched_job_run", "terminal"}, {"mismatched_job_head", "terminal"},
		{"unproved_job_head", "unsupported_run_export"}, {"wrong_job_head_type", "terminal"}, {"wrong_job_run_type", "terminal"},
		{"missing_attempt", "workflow run response did not include run_attempt"},
		{"unknown_REST_fields_ignored", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newRunExportFixture()
			job := runExportJob(7)
			jobs := []any{job}
			body := map[string]any{"total_count": 1, "jobs": jobs}
			var headers map[string]string
			wantCalls := 2
			switch test.name {
			case "empty_jobs":
				body["total_count"], body["jobs"] = 0, []any{}
			case "hundred_jobs", "over_hundred", "over_hundred_complete_array":
				count := 100
				if test.name == "over_hundred_complete_array" {
					count = 101
				}
				jobs = make([]any, count)
				for i := range jobs {
					jobs[i] = runExportJob(i + 1)
				}
				body["total_count"], body["jobs"] = count, jobs
				if test.name == "over_hundred" {
					body["total_count"] = 101
				}
			case "reused_success_and_optional_association":
				delete(job, "run_id")
				delete(job, "head_sha")
				job["run_attempt"] = 1 // Returned run attempt is 3; reused successes are legitimate.
			case "short_page":
				body["total_count"] = 2
			case "null_optional_association":
				job["run_id"], job["head_sha"] = nil, nil
			case "null_step_element":
				job["steps"] = []any{nil}
			case "contradictory_run_then_null":
				body["jobs"] = []any{json.RawMessage(`{"id":7,"run_id":43,"run_id":null,"steps":[]}`)}
			case "contradictory_head_then_null":
				body["jobs"] = []any{json.RawMessage(`{"id":7,"head_sha":"contradiction","head_sha":null,"steps":[]}`)}
			case "excess_items":
				body["total_count"] = 0
			case "last_next":
				headers = map[string]string{"link": `<https://api.github.com/repos/acme/repo/actions/runs/42/attempts/3/jobs?page=2>; rel="next"`}
			case "missing_total":
				delete(body, "total_count")
			case "fractional_total":
				body["total_count"] = json.RawMessage("1.5")
			case "null_total":
				body["total_count"] = nil
			case "negative_total":
				body["total_count"] = -1
			case "missing_jobs":
				delete(body, "jobs")
			case "null_jobs":
				body["jobs"] = nil
			case "object_jobs":
				body["jobs"] = map[string]any{}
			case "null_job":
				body["jobs"] = []any{nil}
			case "duplicate_job_id":
				body["total_count"], body["jobs"] = 2, []any{job, job}
			case "missing_job_id":
				delete(job, "id")
			case "zero_job_id":
				job["id"] = 0
			case "missing_run_id":
				delete(f.run, "id")
				wantCalls = 1
			case "null_run_id":
				f.run["id"] = nil
				wantCalls = 1
			case "zero_run_id":
				f.run["id"] = 0
				wantCalls = 1
			case "mismatched_run_id":
				f.run["id"] = 43
				wantCalls = 1
			case "mismatched_job_run":
				job["run_id"] = 43
			case "mismatched_job_head":
				job["head_sha"] = strings.Repeat("9", 40)
			case "unproved_job_head":
				delete(f.run, "head_sha")
			case "wrong_job_head_type":
				job["head_sha"] = 123
			case "wrong_job_run_type":
				job["run_id"] = "42"
			case "missing_attempt":
				delete(f.run, "run_attempt")
				wantCalls = 1
			case "unknown_REST_fields_ignored":
				f.run["future_number"] = "not a native number"
				job["runner_id"] = "not modeled"
			}
			f.jobs = relayTestResponse{Body: body, Headers: headers}
			out, err := runExportCommand(t, f, runExportArgs("view", "databaseId,jobs"))
			if len(f.requests) != wantCalls {
				t.Errorf("validation/acquisition boundary: paths=%v want %d calls", f.paths(), wantCalls)
			}
			wantPaths := []string{"/repos/acme/repo/actions/runs/42"}
			if wantCalls == 2 {
				wantPaths = append(wantPaths, "/repos/acme/repo/actions/runs/42/attempts/3/jobs")
			}
			if !reflect.DeepEqual(f.paths(), wantPaths) {
				t.Errorf("canonical owned acquisition: got %v want %v", f.paths(), wantPaths)
			}
			if test.reason != "" {
				assertRunExportFailure(t, out, err, test.reason)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got struct {
				DatabaseID int               `json:"databaseId"`
				Jobs       []json.RawMessage `json:"jobs"`
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if got.DatabaseID != 42 || got.Jobs == nil || len(got.Jobs) != body["total_count"].(int) {
				t.Errorf("complete supported control lost jobs: %s", out)
			}
		})
	}
}

func TestRunExportListEvidence(t *testing.T) {
	for _, test := range []struct{ name, raw string }{
		{"missing_envelope", `{}`}, {"null_envelope", `{"workflow_runs":null}`},
		{"nonarray_envelope", `{"workflow_runs":{}}`}, {"missing_identity", `{"workflow_runs":[{"name":"valid string"}]}`},
		{"null_identity", `{"workflow_runs":[{"id":null}]}`}, {"negative_identity", `{"workflow_runs":[{"id":-1}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newRunExportFixture()
			relayTestServer(t, func(req map[string]any) any {
				f.requests = append(f.requests, req)
				if req["path"] != "/repos/acme/repo/actions/runs" {
					t.Errorf("unexpected lookup for unselected metadata: %v", req["path"])
				}
				return json.RawMessage(test.raw)
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), runExportArgs("list", "databaseId"), &out, &stderr)
			assertRunExportFailure(t, out.String(), err, "unsupported_run_export")
			if len(f.requests) != 1 {
				t.Errorf("unexpected calls %v", f.paths())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("unproved list dispatched native despite NO_FALLBACK")
			}
		})
	}
}

func TestRunExportWorkflowMetadata(t *testing.T) {
	for _, test := range []struct {
		name, command, selector, reason string
		calls                           int
	}{
		{"view_disabled", "view", "", "", 2},
		{"list_disabled_catalogue", "list", "", "", 2},
		{"list_missing_memoized", "list", "", "", 3},
		{"list_actual_404", "list", "", "", 3},
		{"view_actual_404", "view", "", "terminal", 2},
		{"list_relay_404_not_upstream", "list", "", "terminal", 3},
		{"view_auth_error", "view", "", "terminal", 2},
		{"list_upstream_500", "list", "", "terminal", 3},
		{"view_malformed_name", "view", "", "terminal", 2},
		{"view_wrong_id", "view", "", "terminal", 2},
		{"view_missing_workflow_id", "view", "", "unsupported_run_export", 1},
		{"catalogue_http_failure", "list", "", "terminal", 2},
		{"catalogue_shape_refusal", "list", "", "pagination_shape_unsupported", 2},
		{"filtered_numeric", "list", "9", "", 2},
		{"filtered_filename", "list", "ci.yml", "", 2},
		{"filtered_wrong_path", "list", "ci.yml", "terminal", 2},
		{"filtered_wrong_association", "list", "9", "terminal", 2},
		{"empty_list_no_metadata", "list", "", "", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newRunExportFixture()
			wantName := "Real CI"
			switch test.name {
			case "list_missing_memoized", "list_actual_404", "list_upstream_500", "list_relay_404_not_upstream":
				f.workflows = []any{}
				second := maps.Clone(f.run)
				second["id"], second["name"] = 43, "second source name"
				f.runs = []any{f.run, second}
			}
			switch test.name {
			case "list_actual_404", "view_actual_404":
				f.lookups["9"] = relayTestResponse{GitHubStatus: 404, Body: map[string]any{"message": "Not Found"}}
				wantName = ""
			case "list_relay_404_not_upstream":
				f.lookups["9"] = relayErrorFixture(404, apiError{Code: "not_found", Message: "relay route missing"})
			case "view_auth_error":
				f.lookups["9"] = relayErrorFixture(401, apiError{Code: "unauthorized", Message: "synthetic auth failure"})
			case "list_upstream_500":
				f.lookups["9"] = relayTestResponse{GitHubStatus: 500, Body: map[string]any{"message": "upstream failure"}}
			case "view_malformed_name":
				f.lookups["9"].(map[string]any)["name"] = true
			case "view_wrong_id":
				f.lookups["9"].(map[string]any)["id"] = 10
			case "view_missing_workflow_id":
				delete(f.run, "workflow_id")
			case "catalogue_http_failure":
				f.catalogue = relayTestResponse{GitHubStatus: 500, Body: map[string]any{"message": "catalogue failure"}}
			case "catalogue_shape_refusal":
				f.catalogue = map[string]any{"workflows": []any{}}
			case "filtered_wrong_path":
				f.lookups["ci.yml"].(map[string]any)["path"] = ".github/workflows/other.yml"
			case "filtered_wrong_association":
				f.run["workflow_id"] = 10
			case "empty_list_no_metadata":
				f.runs = []any{}
			}
			args := append(runExportArgs(test.command, "name,workflowName"), "--json=workflowName")
			if test.selector != "" {
				args = append(args, "--workflow", test.selector)
			}
			out, err := runExportCommand(t, f, args)
			callsOK := len(f.requests) == test.calls
			if test.name == "filtered_wrong_association" {
				callsOK = len(f.requests) == 1 || len(f.requests) == 2
			}
			if !callsOK {
				t.Errorf("metadata acquisition/memo budget: paths=%v got=%d want=%d", f.paths(), len(f.requests), test.calls)
			}
			if test.selector != "" {
				wantPaths := []string{"/repos/acme/repo/actions/workflows/" + test.selector + "/runs"}
				if len(f.requests) > 1 {
					wantPaths = append(wantPaths, "/repos/acme/repo/actions/workflows/"+test.selector)
				}
				if !reflect.DeepEqual(f.paths(), wantPaths) {
					t.Errorf("canonical selector acquisition: got %v want %v", f.paths(), wantPaths)
				}
			}
			if test.reason != "" {
				assertRunExportFailure(t, out, err, test.reason)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := `{"name":"source run label","workflowName":` + strconv.Quote(wantName) + `}`
			if test.command == "list" {
				if len(f.runs) == 2 {
					want += `,{"name":"second source name","workflowName":` + strconv.Quote(wantName) + `}`
				}
				want = "[" + want + "]"
				if len(f.runs) == 0 {
					want = "[]"
				}
			}
			assertRunExportJSON(t, out, want)
		})
	}
}

func TestRunExportWorkflowAcquisitionBound(t *testing.T) {
	f := newRunExportFixture()
	f.runs, f.workflows = []any{}, []any{}
	for i := 1; i <= 1000; i++ {
		f.workflows = append(f.workflows, map[string]any{"id": i + 1000, "name": "unrelated", "path": ".github/workflows/other.yml", "state": "disabled_manually"})
	}
	for i := 1; i <= 100; i++ {
		run := maps.Clone(f.run)
		run["id"], run["workflow_id"] = i, i
		f.runs = append(f.runs, run)
		f.lookups[strconv.Itoa(i)] = map[string]any{"id": i, "name": fmt.Sprintf("Workflow %d", i), "path": fmt.Sprintf(".github/workflows/%d.yml", i), "state": "disabled_manually"}
	}
	out, err := runExportCommand(t, f, append(runExportArgs("list", "databaseId,workflowName"), "--limit=100", "--json=workflowName"))
	if err != nil {
		t.Fatal(err)
	}
	if len(f.requests) != 111 {
		t.Errorf("bounded 1 run + 10 catalogue + 100 memoized direct lookups: %d paths=%v", len(f.requests), f.paths())
	}
	counts := map[string]int{}
	for _, p := range f.paths() {
		counts[p]++
	}
	for i := 1; i <= 100; i++ {
		if counts["/repos/acme/repo/actions/workflows/"+strconv.Itoa(i)] != 1 {
			t.Errorf("workflow %d did not hydrate exactly once", i)
		}
	}
	var got []struct {
		DatabaseID   int    `json:"databaseId"`
		WorkflowName string `json:"workflowName"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 100 {
		t.Fatalf("runs=%d", len(got))
	}
	for i, run := range got {
		if run.DatabaseID != i+1 || run.WorkflowName != fmt.Sprintf("Workflow %d", i+1) {
			t.Errorf("run %d=%+v", i, run)
		}
	}
}

func TestRunExportWorkflowResponseExceedsLimit(t *testing.T) {
	f := newRunExportFixture()
	f.runs = []any{}
	for i := 1; i <= 101; i++ {
		run := maps.Clone(f.run)
		run["id"], run["workflow_id"] = i, i
		f.runs = append(f.runs, run)
	}
	out, err := runExportCommand(t, f, append(runExportArgs("list", "databaseId,workflowName"), "--limit=100"))
	assertRunExportFailure(t, out, err, "unsupported_run_export")
	if !reflect.DeepEqual(f.paths(), []string{"/repos/acme/repo/actions/runs"}) {
		t.Errorf("oversized response must stop before metadata: %v", f.paths())
	}
	if len(f.requests) == 1 {
		query, _ := f.requests[0]["query"].(map[string]any)
		if query["per_page"] != "100" {
			t.Errorf("effective requested limit: %v", query)
		}
	}
}

func TestRunExportRequestedURLJoin(t *testing.T) {
	f := newRunExportFixture()
	f.run["html_url"] = "https://github.com/acme/repo/actions/runs/42/?check=1#details"
	out, err := runExportCommand(t, f, append(runExportArgs("view", "url,attempt"), "--attempt=2"))
	if err != nil {
		t.Fatal(err)
	}
	assertRunExportJSON(t, out, `{"url":"https://github.com/acme/repo/actions/runs/42/attempts/2?check=1#details","attempt":3}`)
	if !reflect.DeepEqual(f.paths(), []string{"/repos/acme/repo/actions/runs/42/attempts/2"}) {
		t.Errorf("unexpected URL acquisition %v", f.paths())
	}
}
