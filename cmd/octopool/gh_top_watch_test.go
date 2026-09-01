package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGHRunWatchPrintsTransitionsAndFetchesJobsOnce(t *testing.T) {
	var runCalls int
	var jobsCalls int
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/actions/runs/42":
			runCalls++
			headers, _ := body["headers"].(map[string]any)
			if headers["x-octopool-public-shape"] != "actions-summary-v1" {
				t.Fatalf("run headers = %#v", headers)
			}
			// The fifth read is the terminal confirmation with max-age=0.
			statuses := []string{"queued", "in_progress", "in_progress", "completed", "completed"}
			return map[string]any{"status": statuses[runCalls-1], "conclusion": "failure", "run_attempt": 2}
		case "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs":
			jobsCalls++
			headers, _ := body["headers"].(map[string]any)
			query, _ := body["query"].(map[string]any)
			if headers["x-octopool-public-shape"] != "actions-jobs-v1" || query["per_page"] != "100" {
				t.Fatalf("jobs headers=%#v query=%#v", headers, query)
			}
			return map[string]any{
				"total_count": 1,
				"jobs": []map[string]any{{
					"id": 7, "name": "Test", "status": "completed", "conclusion": "failure",
					"steps": []map[string]any{
						{"name": "Compile", "status": "completed", "conclusion": "success"},
						{"name": "Unit tests", "status": "completed", "conclusion": "failure"},
					},
				}},
			}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	sleeps := recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "openclaw/octopool"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	wantLines := []string{
		"Watching run 42 in openclaw/octopool (status: queued)",
		"run 42: queued -> in_progress",
		"run 42: in_progress -> completed",
		"job Test: failure",
		"  step Unit tests: failure",
		"Run 42 completed with 'failure'",
	}
	for _, want := range wantLines {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, out.String())
		}
	}
	if runCalls != 5 || jobsCalls != 1 {
		t.Fatalf("run calls=%d jobs calls=%d", runCalls, jobsCalls)
	}
	if want := []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps=%v want=%v", *sleeps, want)
	}
}

func TestGHRunWatchRequestedIntervalStartsAt45Seconds(t *testing.T) {
	var calls int
	relayTestServer(t, func(body map[string]any) any {
		if strings.HasSuffix(body["path"].(string), "/jobs") {
			return map[string]any{"total_count": 0, "jobs": []any{}}
		}
		calls++
		status := "in_progress"
		conclusion := ""
		if calls >= 2 {
			status = "completed"
			conclusion = "success"
		}
		return map[string]any{"status": status, "conclusion": conclusion, "run_attempt": 1}
	})
	sleeps := recordWatchSleeps(t)
	result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "openclaw/octopool", "-i", "45"}, &bytes.Buffer{})
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if want := []time.Duration{45 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps=%v want=%v", *sleeps, want)
	}
}

func TestGHRunWatchFloorsRequestedInterval(t *testing.T) {
	var calls int
	relayTestServer(t, func(body map[string]any) any {
		if strings.HasSuffix(body["path"].(string), "/jobs") {
			return map[string]any{"total_count": 0, "jobs": []any{}}
		}
		calls++
		if calls == 1 {
			return map[string]any{"status": "queued"}
		}
		return map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 1}
	})
	sleeps := recordWatchSleeps(t)
	result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "openclaw/octopool", "-i", "5"}, &bytes.Buffer{})
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if want := []time.Duration{30 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps=%v want=%v", *sleeps, want)
	}
}

func TestGHRunWatchExitStatusFailure(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if strings.HasSuffix(body["path"].(string), "/jobs") {
			return map[string]any{"total_count": 0, "jobs": []any{}}
		}
		return map[string]any{"status": "completed", "conclusion": "failure", "run_attempt": 1}
	})
	recordWatchSleeps(t)
	result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "openclaw/octopool", "--exit-status"}, &bytes.Buffer{})
	assertExitCode(t, result.err, 1)
}

func TestGHPRChecksWatchPendingToDone(t *testing.T) {
	var checkCalls int
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			checkCalls++
			status := "in_progress"
			conclusion := ""
			if checkCalls >= 2 {
				status = "completed"
				conclusion = "success"
			}
			return map[string]any{
				"total_count": 2,
				"check_runs": []map[string]any{
					{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": status, "conclusion": conclusion, "details_url": "https://example.test/ci"},
					{"id": 2, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 202}, "name": "Lint", "status": "completed", "conclusion": "success", "details_url": "https://example.test/lint"},
				},
			}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	sleeps := recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	for _, want := range []string{
		"checks: 1 pending, 1 pass, 0 fail, 0 cancel",
		"checks: 0 pending, 2 pass, 0 fail, 0 cancel",
		"CI\tpass\tSUCCESS\thttps://example.test/ci",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, out.String())
		}
	}
	if want := []time.Duration{30 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps=%v want=%v", *sleeps, want)
	}
}

func TestGHPRChecksWatchFailFast(t *testing.T) {
	var checkCalls int
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			checkCalls++
			return map[string]any{"total_count": 2, "check_runs": []map[string]any{
				{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "failure"},
				{"id": 2, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 202}, "name": "Integration", "status": "queued"},
			}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	sleeps := recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch", "--fail-fast"}, &out)
	assertExitCode(t, result.err, 1)
	// One polling read plus the fresh terminal confirmation sweep.
	if checkCalls != 2 || len(*sleeps) != 0 {
		t.Fatalf("check calls=%d sleeps=%v", checkCalls, *sleeps)
	}
	if !strings.Contains(out.String(), "checks: 1 pending, 0 pass, 1 fail, 0 cancel") || !strings.Contains(out.String(), "CI\tfail\tFAILURE") {
		t.Fatalf("out=%q", out.String())
	}
}

func TestGHPRChecksWatchFailFastIgnoresCancelled(t *testing.T) {
	var checkCalls int
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			checkCalls++
			pendingStatus := "queued"
			pendingConclusion := ""
			if checkCalls >= 2 {
				pendingStatus, pendingConclusion = "completed", "success"
			}
			return map[string]any{"total_count": 2, "check_runs": []map[string]any{
				{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "cancelled"},
				{"id": 2, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 202}, "name": "Integration", "status": pendingStatus, "conclusion": pendingConclusion},
			}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	sleeps := recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch", "--fail-fast"}, &out)
	// Cancelled is terminal but not failed: the watch must keep polling the
	// pending check instead of fail-fasting, and cancelled-only results exit 0
	// exactly like real gh (Failed then Pending counts decide the exit code).
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if len(*sleeps) == 0 || !strings.Contains(out.String(), "checks: 1 pending, 0 pass, 0 fail, 1 cancel") {
		t.Fatalf("sleeps=%v out=%q", *sleeps, out.String())
	}
}

func TestGHPRChecksWatchErrorsOnNoChecks(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": 0, "check_runs": []any{}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch"}, &out)
	if result.err == nil || !strings.Contains(result.err.Error(), "no checks reported") {
		t.Fatalf("zero checks must not read as green: err=%v", result.err)
	}
}

func TestGHPRChecksWatchCachedEmptyRevalidatesFresh(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch path := body["path"].(string); {
		case path == "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case strings.HasSuffix(path, "/check-runs"):
			h, _ := body["headers"].(map[string]any)
			if h["cache-control"] != "max-age=0" {
				// Stale shared-cache entry from before checks registered.
				return map[string]any{"total_count": 0, "check_runs": []any{}}
			}
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", path)
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("cached emptiness must revalidate fresh and continue: action=%v err=%v", result.action, result.err)
	}
	if !strings.Contains(out.String(), "CI\tpass") {
		t.Fatalf("out=%q", out.String())
	}
}

func TestGHPRChecksWatchFreshEmptyTerminalIsNotGreen(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch path := body["path"].(string); {
		case path == "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case strings.HasSuffix(path, "/check-runs"):
			h, _ := body["headers"].(map[string]any)
			if h["cache-control"] == "max-age=0" {
				// Terminal confirmation sees the checks vanish (rerun lag).
				return map[string]any{"total_count": 0, "check_runs": []any{}}
			}
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", path)
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch"}, &out)
	if result.err == nil || !strings.Contains(result.err.Error(), "no checks reported") {
		t.Fatalf("fresh-empty terminal must not confirm green: err=%v", result.err)
	}
}

func TestGHWatchShapeLastWatchValueWins(t *testing.T) {
	if isGHWatchShape([]string{"pr", "checks", "7", "--watch", "--watch=false"}) {
		t.Fatal("--watch --watch=false must not count as a watch shape")
	}
	if !isGHWatchShape([]string{"pr", "checks", "7", "--watch=false", "--watch"}) {
		t.Fatal("--watch=false --watch must count as a watch shape")
	}
	floored := floorGHWatchDelegateArgs([]string{"run", "watch", "42", "--", "-i1"})
	if !reflect.DeepEqual(floored, []string{"run", "watch", "42", "--interval", "30", "--", "-i1"}) {
		t.Fatalf("post-terminator tokens must stay untouched and floor injected before --, got %v", floored)
	}
}

func TestGHPRChecksWatchJSONDelegatesLikeRealGH(t *testing.T) {
	// real gh rejects --watch with --json/--jq; the shim delegates so gh
	// reports the combination itself.
	var out bytes.Buffer
	for _, args := range [][]string{
		{"checks", "7", "-R", "openclaw/octopool", "--watch", "--json", "name,bucket"},
		{"checks", "7", "-R", "openclaw/octopool", "--watch", "--jq", ".x"},
	} {
		if result := handleGHPR(t.Context(), args, &out); result.action != ghDelegate {
			t.Fatalf("args %v must delegate, got action=%v", args, result.action)
		}
	}
}

func TestGHPRChecksWatchEqualsTrueSpelling(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch=true"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("--watch=true must use the native watch path: action=%v err=%v", result.action, result.err)
	}
	for _, spelling := range []string{"--watch=true", "--watch=1", "--watch=t", "--watch=TRUE"} {
		if !isGHWatchShape([]string{"pr", "checks", "7", spelling}) {
			t.Fatalf("%s must count as a watch shape for interval flooring", spelling)
		}
	}
	for _, spelling := range []string{"--watch=false", "--watch=0", "--watch=F"} {
		if isGHWatchShape([]string{"pr", "checks", "7", spelling}) {
			t.Fatalf("%s must not count as a watch shape", spelling)
		}
	}
}

func TestGHWatchParsersHandleAttachedInterval(t *testing.T) {
	opts, ok := parseGHRunWatchOptions([]string{"42", "-i45"})
	if !ok || opts.interval != 45*time.Second {
		t.Fatalf("run watch -i45: ok=%v interval=%v", ok, opts.interval)
	}
	checkOpts, ok := parseGHPRChecksWatchOptions([]string{"7", "--watch", "-i5"})
	if !ok || checkOpts.interval != watchMinInterval {
		t.Fatalf("checks watch -i5 must floor: ok=%v interval=%v", ok, checkOpts.interval)
	}
	floored := floorGHWatchDelegateArgs([]string{"run", "watch", "42", "-i5"})
	if !reflect.DeepEqual(floored, []string{"run", "watch", "42", "-i30"}) {
		t.Fatalf("delegated -i5 must floor in place, got %v", floored)
	}
	invalid := []string{"run", "watch", "42", "--json", "x", "-i5"}
	if got := floorGHWatchDelegateArgs(invalid); !reflect.DeepEqual(got, invalid) {
		t.Fatalf("undeclared run-watch JSON must not be repaired: %v", got)
	}
	terminated := floorGHWatchDelegateArgs([]string{"run", "watch", "--", "42"})
	if !reflect.DeepEqual(terminated, []string{"run", "watch", "--interval", "30", "--", "42"}) {
		t.Fatalf("injected interval must precede the -- terminator, got %v", terminated)
	}
}

func TestGHWatchIntervalOccurrences(t *testing.T) {
	for _, test := range []struct {
		name      string
		flags     []string
		seconds   int64
		supported bool
	}{
		{"control_decimal", []string{"--interval=45"}, 45, true},
		{"regression_octal", []string{"--interval=040"}, 32, true},
		{"regression_hex", []string{"--interval=0x20"}, 32, true},
		{"regression_binary", []string{"--interval=0b100000"}, 32, true},
		{"regression_underscore", []string{"--interval=3_2"}, 32, true},
		{"regression_attached_octal", []string{"-i040"}, 32, true},
		{"regression_hex_floor", []string{"--interval=0x1"}, 30, true},
		{"control_negative_floor", []string{"--interval=-1"}, 30, true},
		{"control_zero_floor", []string{"--interval=0"}, 30, true},
		{"regression_invalid_octal_earlier", []string{"--interval=08", "--interval=45"}, 0, false},
		{"control_int_overflow_earlier", []string{"--interval=9223372036854775808", "--interval=45"}, 0, false},
		{"regression_positive_duration_overflow", []string{"--interval=9223372037"}, 0, false},
		{"regression_negative_duration_overflow", []string{"--interval=-9223372037"}, 0, false},
		{"control_duration_overridden", []string{"--interval=9223372037", "--interval=45"}, 45, true},
		{"control_duration_endpoint", []string{"--interval=9223372036"}, 9223372036, true},
		{"control_negative_duration_endpoint", []string{"--interval=-9223372036"}, 30, true},
	} {
		for _, command := range []string{"run", "checks"} {
			t.Run(command+"/"+test.name, func(t *testing.T) {
				var interval time.Duration
				var ok bool
				if command == "run" {
					opts, supported := parseGHRunWatchOptions(append([]string{"42"}, test.flags...))
					interval, ok = opts.interval, supported
				} else {
					opts, supported := parseGHPRChecksWatchOptions(append([]string{"7", "--watch"}, test.flags...))
					interval, ok = opts.interval, supported
				}
				if ok != test.supported || (ok && interval != time.Duration(test.seconds)*time.Second) {
					t.Fatalf("supported=%v want=%v interval=%v wantSeconds=%d", ok, test.supported, interval, test.seconds)
				}
			})
		}
	}
}

func TestGHWatchFloorValueOwnership(t *testing.T) {
	for _, test := range []struct {
		name       string
		args, want []string
	}{
		{"regression_hex_floor", []string{"run", "watch", "42", "--interval=0x1"}, []string{"run", "watch", "42", "--interval=30"}},
		{"regression_attached_hex_floor", []string{"run", "watch", "42", "-i0x1"}, []string{"run", "watch", "42", "-i30"}},
		{"regression_repo_owned_value", []string{"run", "watch", "42", "--repo", "-i1", "--compact"}, []string{"run", "watch", "42", "--repo", "-i1", "--compact", "--interval", "30"}},
		{"regression_repo_owned_delimiter", []string{"run", "watch", "42", "--repo", "--", "--compact"}, []string{"run", "watch", "42", "--repo", "--", "--compact", "--interval", "30"}},
		{"regression_discarded_interval", []string{"run", "watch", "42", "-i1", "--interval=45"}, []string{"run", "watch", "42", "-i1", "--interval=45"}},
		{"regression_invalid_earlier_octal", []string{"run", "watch", "42", "-i08", "--interval=1"}, []string{"run", "watch", "42", "-i08", "--interval=1"}},
		{"control_overridden_duration_floor", []string{"run", "watch", "42", "--interval=9223372037", "-i1"}, []string{"run", "watch", "42", "--interval=9223372037", "-i30"}},
		{"control_final_floor", []string{"run", "watch", "42", "--interval=45", "-i1"}, []string{"run", "watch", "42", "--interval=45", "-i30"}},
		{"control_original_large_spelling", []string{"run", "watch", "42", "--interval=0x20"}, []string{"run", "watch", "42", "--interval=0x20"}},
		{"control_duration_overflow_untouched", []string{"run", "watch", "42", "--interval=9223372037"}, []string{"run", "watch", "42", "--interval=9223372037"}},
		{"control_after_delimiter", []string{"run", "watch", "42", "--", "-i1"}, []string{"run", "watch", "42", "--interval", "30", "--", "-i1"}},
		{"control_false_watch", []string{"pr", "checks", "7", "--watch=false", "-i1"}, []string{"pr", "checks", "7", "--watch=false", "-i1"}},
		{"control_repo_owned_watch", []string{"pr", "checks", "7", "--repo", "--watch", "-i1"}, []string{"pr", "checks", "7", "--repo", "--watch", "-i1"}},
		{"control_unknown_value_ownership", []string{"run", "watch", "42", "--unknown", "-i1"}, []string{"run", "watch", "42", "--unknown", "-i1"}},
		{"regression_run_attached_repo", []string{"run", "watch", "42", "-Racme/repo", "-i1"}, []string{"run", "watch", "42", "-Racme/repo", "-i30"}},
		{"regression_pr_attached_repo", []string{"pr", "checks", "7", "-Racme/repo", "--watch", "--required", "-i1"}, []string{"pr", "checks", "7", "-Racme/repo", "--watch", "--required", "-i30"}},
		{"control_attached_repo_false_watch", []string{"pr", "checks", "7", "-Racme/repo", "--watch=false", "-i1"}, []string{"pr", "checks", "7", "-Racme/repo", "--watch=false", "-i1"}},
		{"control_attached_repo_invalid_interval", []string{"run", "watch", "42", "-Racme/repo", "-i08", "--interval=1"}, []string{"run", "watch", "42", "-Racme/repo", "-i08", "--interval=1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := append([]string(nil), test.args...)
			got := floorGHWatchDelegateArgs(test.args)
			if !reflect.DeepEqual(got, test.want) || !reflect.DeepEqual(test.args, original) {
				t.Fatalf("floored=%q want=%q caller=%q", got, test.want, test.args)
			}
		})
	}
}

func TestGHReadShortBoolOccurrences(t *testing.T) {
	for _, test := range []struct {
		name     string
		args     []string
		raw      string
		web      bool
		rejected bool
	}{
		{"false_assignment", []string{"-w=false"}, "false", false, false},
		{"zero_assignment", []string{"-w=0"}, "0", false, false},
		{"long_then_short", []string{"--web=true", "-w=false"}, "false", false, false},
		{"short_then_long", []string{"-w=true", "--web=false"}, "false", false, false},
		{"short_true", []string{"-w=true"}, "true", true, false},
		{"bare_short_control", []string{"-w"}, "true", true, false},
		{"long_false_control", []string{"--web=false"}, "false", false, false},
		{"lone_equals_control", []string{"-w="}, "", false, true},
		{"cluster_control", []string{"-wf"}, "", false, true},
		{"attached_false_control", []string{"-wfalse"}, "", false, true},
		{"invalid_bool_control", []string{"-w=no"}, "", false, true},
		{"invalid_earlier_control", []string{"-w=no", "--web=false"}, "", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := append([]string(nil), test.args...)
			specs := typedReadSpecs("pr checks", "", "--web,-w --watch")
			parsed, unsupported, err := parseReadOptions(test.args, specs)
			if !reflect.DeepEqual(test.args, original) {
				t.Fatalf("caller argv changed: %q", test.args)
			}
			if test.rejected {
				if err == nil && !unsupported {
					t.Fatal("invalid or clustered shorthand accepted")
				}
				return
			}
			if err != nil || unsupported || !parsed.has("--web") || parsed.has("--watch") || parsed.values["--web"].boolean != test.web || parsed.values["--web"].raw != test.raw {
				t.Fatalf("err=%v unsupported=%v values=%+v; want web=%v raw=%q and no watch", err, unsupported, parsed.values, test.web, test.raw)
			}
			if !reflect.DeepEqual(parsed.argv, original) || len(parsed.ordered) != len(test.args) {
				t.Fatalf("raw ownership lost: %+v", parsed)
			}
			for i, occurrence := range parsed.ordered {
				if occurrence.name != "--web" || occurrence.start != i || occurrence.end != i+1 {
					t.Fatalf("alias occurrence lost: %+v", occurrence)
				}
			}
		})
	}
}

func TestGHWatchShortBoolFloorOwnership(t *testing.T) {
	for _, test := range []struct {
		name        string
		flags, want []string
	}{
		{"false", []string{"--watch", "-w=false", "-i1"}, []string{"--watch", "-w=false", "-i30"}},
		{"zero", []string{"--watch", "-w=0", "-i1"}, []string{"--watch", "-w=0", "-i30"}},
		{"lower_f", []string{"--watch", "-w=f", "-i1"}, []string{"--watch", "-w=f", "-i30"}},
		{"upper_f", []string{"--watch", "-w=F", "-i1"}, []string{"--watch", "-w=F", "-i30"}},
		{"upper_false", []string{"--watch", "-w=FALSE", "-i1"}, []string{"--watch", "-w=FALSE", "-i30"}},
		{"title_false", []string{"--watch", "-w=False", "-i1"}, []string{"--watch", "-w=False", "-i30"}},
		{"mixed_final_short", []string{"--watch", "--web=true", "-w=false", "-i1"}, []string{"--watch", "--web=true", "-w=false", "-i30"}},
		{"mixed_final_long", []string{"--watch", "-w=true", "--web=false", "-i1"}, []string{"--watch", "-w=true", "--web=false", "-i30"}},
		{"effective_only", []string{"--watch", "-i1", "-w=0", "--interval=0x1"}, []string{"--watch", "-i1", "-w=0", "--interval=30"}},
		{"default_before_terminator", []string{"--watch", "-w=false", "--", "-i1"}, []string{"--watch", "-w=false", "--interval", "30", "--", "-i1"}},
		{"long_false_control", []string{"--watch", "--web=false", "--required", "-i1"}, []string{"--watch", "--web=false", "--required", "-i30"}},
		{"lone_equals_control", []string{"--watch", "-w=", "-i1"}, []string{"--watch", "-w=", "-i1"}},
		{"cluster_control", []string{"--watch", "-wf", "-i1"}, []string{"--watch", "-wf", "-i1"}},
		{"invalid_bool_control", []string{"--watch", "-w=no", "--web=false", "-i1"}, []string{"--watch", "-w=no", "--web=false", "-i1"}},
		{"terminator_control", []string{"--", "--watch", "-w=false", "-i1"}, []string{"--", "--watch", "-w=false", "-i1"}},
		{"owned_web_control", []string{"--watch", "--jq", "-w=false", "-i1"}, []string{"--watch", "--jq", "-w=false", "-i30"}},
		{"owned_watch_control", []string{"--jq", "--watch", "-w=false", "-i1"}, []string{"--jq", "--watch", "-w=false", "-i1"}},
		{"false_watch_control", []string{"--watch", "-w=false", "--watch=false", "-i1"}, []string{"--watch", "-w=false", "--watch=false", "-i1"}},
		{"web_is_not_watch_control", []string{"-w=true", "-i1"}, []string{"-w=true", "-i1"}},
		{"large_raw_control", []string{"--watch", "-w=false", "-i0x20"}, []string{"--watch", "-w=false", "-i0x20"}},
		{"invalid_interval_control", []string{"--watch", "-w=false", "-i08", "-i1"}, []string{"--watch", "-w=false", "-i08", "-i1"}},
		{"duration_overflow_control", []string{"--watch", "-w=false", "--interval=9223372037"}, []string{"--watch", "-w=false", "--interval=9223372037"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			args := append([]string{"pr", "checks", "7", "-R", "acme/repo"}, test.flags...)
			original := append([]string(nil), args...)
			want := append([]string{"pr", "checks", "7", "-R", "acme/repo"}, test.want...)
			if got := floorGHWatchDelegateArgs(args); !reflect.DeepEqual(got, want) || !reflect.DeepEqual(args, original) {
				t.Fatalf("floored=%q want=%q caller=%q", got, want, args)
			}
		})
	}
}

func TestGHRunWatchNativeIntervalSleep(t *testing.T) {
	for _, raw := range []string{"040", "0x20"} {
		t.Run(raw, func(t *testing.T) {
			calls := 0
			relayTestServer(t, func(req map[string]any) any {
				if strings.HasSuffix(req["path"].(string), "/jobs") {
					return map[string]any{"total_count": 0, "jobs": []any{}}
				}
				calls++
				if calls == 1 {
					return map[string]any{"status": "queued"}
				}
				return map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 3}
			})
			sleeps := recordWatchSleeps(t)
			result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "acme/repo", "--interval", raw}, &bytes.Buffer{})
			if result.action != ghComplete || result.err != nil || !reflect.DeepEqual(*sleeps, []time.Duration{32 * time.Second}) {
				t.Fatalf("action=%v err=%v sleeps=%v", result.action, result.err, *sleeps)
			}
		})
	}
}

func TestGHPRChecksWatchRevalidatesHeadBeforeTerminal(t *testing.T) {
	checkFetches := []string{}
	relayTestServer(t, func(body map[string]any) any {
		switch path := body["path"].(string); {
		case path == "/repos/openclaw/octopool/pulls/7":
			headers, _ := body["headers"].(map[string]any)
			if headers["cache-control"] == "max-age=0" {
				return map[string]any{"head": map[string]any{"sha": "newsha", "ref": "feature"}}
			}
			sha := "oldsha"
			if len(checkFetches) > 0 {
				sha = "newsha"
			}
			return map[string]any{"head": map[string]any{"sha": sha, "ref": "feature"}}
		case strings.HasSuffix(path, "/check-runs"):
			sha := strings.Split(path, "/")[5]
			checkFetches = append(checkFetches, sha)
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": sha, "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", path)
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	// tick(oldsha) -> terminal confirm rejects on fresh head; tick(newsha) ->
	// terminal -> fresh confirm sweep re-reads newsha's checks.
	if len(checkFetches) != 3 || checkFetches[0] != "oldsha" || checkFetches[1] != "newsha" || checkFetches[2] != "newsha" {
		t.Fatalf("check fetches = %v, want stale head rejected then re-polled with fresh confirm", checkFetches)
	}
}

func TestGHRunWatchConfirmsTerminalWithFreshRead(t *testing.T) {
	freshRunReads := 0
	relayTestServer(t, func(body map[string]any) any {
		switch path := body["path"].(string); {
		case path == "/repos/openclaw/octopool/actions/runs/42":
			headers, _ := body["headers"].(map[string]any)
			if headers["cache-control"] == "max-age=0" {
				freshRunReads++
				if freshRunReads == 1 {
					// The rerun is live even though the cache still says done.
					return map[string]any{"id": 42, "status": "in_progress"}
				}
			}
			conclusion := "failure"
			if freshRunReads > 0 {
				conclusion = "success"
			}
			return map[string]any{"id": 42, "status": "completed", "conclusion": conclusion, "run_attempt": 2}
		case strings.HasSuffix(path, "/jobs"):
			if h, _ := body["headers"].(map[string]any); h["cache-control"] != "max-age=0" {
				t.Fatal("terminal jobs read must bypass cached staleness")
			}
			return map[string]any{"total_count": 0, "jobs": []any{}}
		default:
			t.Fatalf("unexpected path = %v", path)
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "openclaw/octopool", "--exit-status"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if freshRunReads != 2 {
		t.Fatalf("fresh run reads = %d, want stale terminal rejected then confirmed", freshRunReads)
	}
	if !strings.Contains(out.String(), "completed -> in_progress") || !strings.Contains(out.String(), "Run 42 completed with 'success'") {
		t.Fatalf("out=%q", out.String())
	}
}

func TestGHPRChecksWatchConfirmsRerunSameHead(t *testing.T) {
	freshCheckReads := 0
	relayTestServer(t, func(body map[string]any) any {
		switch path := body["path"].(string); {
		case path == "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case strings.HasSuffix(path, "/check-runs"):
			if h, _ := body["headers"].(map[string]any); h["cache-control"] == "max-age=0" {
				freshCheckReads++
				if freshCheckReads == 1 {
					// Rerun in flight: same head SHA, cached payload obsolete.
					return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "in_progress"}}}
				}
			}
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path = %v", path)
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if freshCheckReads != 2 {
		t.Fatalf("fresh check reads = %d, want rerun detected then confirmed", freshCheckReads)
	}
}

func TestGHPRChecksWatchJQWithoutJSONDelegates(t *testing.T) {
	if _, ok := parseGHPRChecksWatchOptions([]string{"7", "--watch", "--jq", ".x"}); ok {
		t.Fatal("--jq without --json must delegate to real gh")
	}
}

func TestWatchSafeTextStripsControlSequences(t *testing.T) {
	if got := watchSafeText("ok\x1b[31mred\x9bx\x00\ttab"); got != "ok[31mred\uFFFDxtab" {
		t.Fatalf("got %q", got)
	}
}

func TestGHRunWatchPaginatesCompletedRunJobs(t *testing.T) {
	jobsRequests := []string{}
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/actions/runs/42":
			return map[string]any{"id": 42, "status": "completed", "conclusion": "success", "run_attempt": 2, "head_sha": "owned-head"}
		case "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs":
			page := body["query"].(map[string]any)["page"].(string)
			jobsRequests = append(jobsRequests, page)
			jobs := []map[string]any{}
			count := relayPageSize
			offset := 0
			if page == "2" {
				count = 50
				offset = relayPageSize
			}
			for index := 0; index < count; index++ {
				jobs = append(jobs, map[string]any{"id": offset + index + 1, "name": "job", "status": "completed", "conclusion": "success", "run_id": 42, "head_sha": "owned-head", "run_attempt": 1})
			}
			return map[string]any{"total_count": 150, "jobs": jobs}
		default:
			t.Fatalf("unexpected path = %v", body["path"])
			return nil
		}
	})
	recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"watch", "42", "-R", "openclaw/octopool"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if len(jobsRequests) != 2 || jobsRequests[0] != "1" || jobsRequests[1] != "2" {
		t.Fatalf("jobs pages requested = %v", jobsRequests)
	}
	if got := strings.Count(out.String(), "job job: success"); got != 150 {
		t.Fatalf("job lines = %d, want 150", got)
	}
}

func TestGHWatchAttachedRepoNativeHandoff(t *testing.T) {
	for _, test := range []struct {
		name string
		repo []string
	}{
		{"attached", []string{"-Racme/repo"}},
		{"separate_control", []string{"-R", "acme/repo"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := 0
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) { data++ })
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "")
			capturePath := captureRewriteGH(t)
			args := append([]string{"pr", "checks", "7"}, test.repo...)
			args = append(args, "--watch", "--required", "-i1")
			original := append([]string(nil), args...)
			var out bytes.Buffer
			err := runGH(t.Context(), args, &out, io.Discard)
			if err != nil || data != 0 || policies.Load() != 2 || out.String() != "child stdout\n" {
				t.Fatalf("watch handoff: err=%v data=%d policies=%d output=%q", err, data, policies.Load(), out.String())
			}
			capture := readRewriteCapture(t, capturePath)
			want := append([]string(nil), args...)
			want[len(want)-1] = "-i30"
			if !reflect.DeepEqual(capture.Args, want) || !reflect.DeepEqual(args, original) {
				t.Fatalf("native watch interval/argv: got=%q want=%q caller=%q", capture.Args, want, args)
			}
		})
	}
}

func TestGHWatchShortBoolNativeHandoff(t *testing.T) {
	for _, test := range []struct {
		name        string
		flags, want []string
	}{
		{"false", []string{"--watch", "-w=false", "-i1"}, []string{"--watch", "-w=false", "-i30"}},
		{"zero", []string{"--watch", "-w=0", "-i1"}, []string{"--watch", "-w=0", "-i30"}},
		{"mixed_final_short", []string{"--watch", "--web=true", "-w=false", "-i1"}, []string{"--watch", "--web=true", "-w=false", "-i30"}},
		{"mixed_final_long", []string{"--watch", "-w=true", "--web=false", "-i1"}, []string{"--watch", "-w=true", "--web=false", "-i30"}},
		{"long_required_control", []string{"--watch", "--web=false", "--required", "-i1"}, []string{"--watch", "--web=false", "--required", "-i30"}},
		{"lone_equals_control", []string{"--watch", "-w=", "-i1"}, []string{"--watch", "-w=", "-i1"}},
		{"cluster_control", []string{"--watch", "-wf", "-i1"}, []string{"--watch", "-wf", "-i1"}},
		{"invalid_bool_control", []string{"--watch", "-w=no", "-i1"}, []string{"--watch", "-w=no", "-i1"}},
		{"false_watch_control", []string{"--watch=false", "-w=false", "-i1"}, []string{"--watch=false", "-w=false", "-i1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := 0
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) { data++ })
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "")
			capturePath := captureRewriteGH(t)
			args := append([]string{"pr", "checks", "7", "-R", "acme/repo"}, test.flags...)
			original := append([]string(nil), args...)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			// Each capture child emits one marker; exact output also proves one handoff.
			if err != nil || data != 0 || policies.Load() != 2 || out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
				t.Fatalf("handoff: err=%v data=%d policies=%d stdout=%q stderr=%q", err, data, policies.Load(), out.String(), stderr.String())
			}
			capture := readRewriteCapture(t, capturePath)
			want := append([]string{"pr", "checks", "7", "-R", "acme/repo"}, test.want...)
			if !reflect.DeepEqual(capture.Args, want) || !reflect.DeepEqual(args, original) || capture.Env["GH_HOST"] != "github.com" || capture.Stdin != "" {
				t.Fatalf("capture=%+v want args=%q caller=%q", capture, want, args)
			}
		})
	}
}

func TestGHWatchDelegatesWithFlooredInterval(t *testing.T) {
	emptyRewriteTestServer(t)
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "unsupported pr checks flag",
			args: []string{"pr", "checks", "7", "--watch", "--required", "-i=5"},
			want: "real-gh:pr checks 7 --watch --required -i=30",
		},
		{
			name: "missing run id",
			args: []string{"run", "watch"},
			want: "real-gh:run watch --interval 30",
		},
		{
			name: "unknown run flag",
			args: []string{"run", "watch", "42", "--web"},
			want: "real-gh:run watch 42 --web",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
			var out bytes.Buffer
			if err := runGH(t.Context(), test.args, &out, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			if got := strings.TrimSpace(out.String()); got != test.want {
				t.Fatalf("got=%q want=%q", got, test.want)
			}
		})
	}
}

func TestWatchTickRetriesThreeConsecutiveErrors(t *testing.T) {
	sleeps := recordWatchSleeps(t)
	backoff := newWatchBackoff(30 * time.Second)
	calls := 0
	err := retryWatchTick(t.Context(), &backoff, func() error {
		calls++
		return errors.New("relay unavailable")
	})
	if err == nil || calls != 3 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	if want := []time.Duration{30 * time.Second, 60 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps=%v want=%v", *sleeps, want)
	}
}

func TestWatchTickBailsImmediatelyOnDeterministicRefusal(t *testing.T) {
	sleeps := recordWatchSleeps(t)
	backoff := newWatchBackoff(30 * time.Second)
	calls := 0
	err := retryWatchTick(t.Context(), &backoff, func() error {
		calls++
		return localFallbackError{Reason: "repo_not_public"}
	})
	if !shouldRunRealGH(err) || calls != 1 {
		t.Fatalf("err=%v calls=%d, want immediate fallback-eligible error", err, calls)
	}
	if len(*sleeps) != 0 {
		t.Fatalf("sleeps=%v, want none before deterministic refusal surfaces", *sleeps)
	}
}

func TestWatchTickBailsImmediatelyOnTypedRelayError(t *testing.T) {
	sleeps := recordWatchSleeps(t)
	backoff := newWatchBackoff(30 * time.Second)
	calls := 0
	want := &relayResponseError{
		Status:   http.StatusInternalServerError,
		apiError: apiError{Code: "internal_error", RequestID: "request-final"},
	}
	err := retryWatchTick(t.Context(), &backoff, func() error {
		calls++
		return want
	})
	if err != want || calls != 1 {
		t.Fatalf("err=%v calls=%d, want final typed relay error once", err, calls)
	}
	if len(*sleeps) != 0 {
		t.Fatalf("sleeps=%v, want none after client retry exhaustion", *sleeps)
	}
}

func TestWatchErrorClassification(t *testing.T) {
	explicitRelay := &relayResponseError{
		Status: http.StatusFailedDependency,
		apiError: apiError{
			Code: "fallback_local", Details: apiErrorDetails{FallbackReason: "relay_overloaded"},
		},
	}
	explicit, _ := localFallbackFromRelayError(explicitRelay)
	auth, _ := localFallbackFromRelayError(&relayResponseError{
		Status:   http.StatusUnauthorized,
		apiError: apiError{Code: "invalid_auth"},
	})
	for _, test := range []struct {
		name     string
		err      error
		progress bool
		action   ghAction
	}{
		{name: "explicit before progress", err: explicit, action: ghFail},
		{name: "explicit after progress", err: explicit, progress: true, action: ghHandoffAfterOutput},
		{name: "auth after progress", err: auth, progress: true, action: ghFail},
		{name: "local fallback after progress", err: localFallbackError{Reason: "pagination_exhausted"}, progress: true, action: ghFail},
		{name: "service error after progress", err: &relayResponseError{Status: http.StatusServiceUnavailable, apiError: apiError{Code: "admin_unconfigured"}}, progress: true, action: ghFail},
		{name: "transport error after progress", err: errors.New("connection reset"), progress: true, action: ghFail},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := ghWatchCompleted(watchError(test.err, test.progress))
			if result.action != test.action {
				t.Fatalf("action=%v, want %v; err=%v", result.action, test.action, result.err)
			}
		})
	}
}

func TestGHRunWatchPrivateRepoBeforeProgressDelegates(t *testing.T) {
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
	relayTestServer(t, func(map[string]any) any { return relayFallbackFixture("repo_not_public") })
	var stdout, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"run", "watch", "42", "-R", "openclaw/octopool"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if strings.Count(stdout.String(), fakeGHArgvPrefix) != 1 {
		t.Fatalf("stdout=%q, want one real-gh invocation", stdout.String())
	}
	if strings.Contains(stdout.String(), "Watching run") ||
		!strings.Contains(stderr.String(), "falling back to real gh") ||
		strings.Contains(stderr.String(), "continuing watch") {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestGHWatchNoFallbackBlocksBeforeAndAfterProgress(t *testing.T) {
	for _, afterProgress := range []bool{false, true} {
		name := "before progress"
		if afterProgress {
			name = "after progress"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
			recordWatchSleeps(t)
			calls := 0
			relayTestServer(t, func(map[string]any) any {
				calls++
				if !afterProgress || calls > 1 {
					return relayFallbackFixture("relay_overloaded")
				}
				return map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 1}
			})
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"run", "watch", "42", "-R", "openclaw/octopool"}, &stdout, &stderr)
			if err == nil || strings.Contains(stdout.String(), fakeGHArgvPrefix) {
				t.Fatalf("err=%v stdout=%q", err, stdout.String())
			}
			if stderr.Len() != 0 {
				t.Fatalf("disabled fallback must not print a handoff: %q", stderr.String())
			}
		})
	}
}

func TestGHRunWatchMissingAttemptDoesNotHandoff(t *testing.T) {
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
	recordWatchSleeps(t)
	relayTestServer(t, func(map[string]any) any {
		return map[string]any{"status": "completed", "conclusion": "success"}
	})
	var stdout, stderr bytes.Buffer
	err := runGH(t.Context(), []string{"run", "watch", "42", "-R", "openclaw/octopool"}, &stdout, &stderr)
	if err == nil || strings.Contains(stdout.String(), fakeGHArgvPrefix) {
		t.Fatalf("err=%v stdout=%q", err, stdout.String())
	}
	if !strings.Contains(stdout.String(), "Watching run") || stderr.Len() != 0 {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestGHPRChecksWatchAuthFailureDoesNotHandoff(t *testing.T) {
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
	recordWatchSleeps(t)
	relayTestServer(t, func(body map[string]any) any {
		path := body["path"].(string)
		switch {
		case strings.HasSuffix(path, "/pulls/7"):
			headers, _ := body["headers"].(map[string]any)
			if headers["cache-control"] == "max-age=0" {
				return relayErrorFixture(http.StatusUnauthorized, apiError{
					Code: "invalid_auth", Message: "Invalid caller token",
				})
			}
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case strings.HasSuffix(path, "/check-runs"):
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"total_count": 0, "statuses": []any{}}
		default:
			t.Fatalf("unexpected path %q", path)
			return nil
		}
	})
	var stdout, stderr bytes.Buffer
	err := runGH(t.Context(), []string{"pr", "checks", "7", "-R", "openclaw/octopool", "--watch"}, &stdout, &stderr)
	if err == nil || strings.Contains(stdout.String(), fakeGHArgvPrefix) {
		t.Fatalf("err=%v stdout=%q", err, stdout.String())
	}
	if !strings.Contains(stdout.String(), "checks:") {
		t.Fatalf("expected progress before confirmation failure: %q", stdout.String())
	}
}

func relayFallbackFixture(reason string) relayTestResponse {
	return relayErrorFixture(http.StatusFailedDependency, apiError{
		Code: "fallback_local", Message: "Run locally", Details: apiErrorDetails{FallbackReason: reason},
	})
}

func relayErrorFixture(status int, apiErr apiError) relayTestResponse {
	return relayTestResponse{Status: status, Body: apiErrorResponse{Error: apiErr}}
}

func recordWatchSleeps(t *testing.T) *[]time.Duration {
	t.Helper()
	original := sleepContext
	durations := []time.Duration{}
	sleepContext = func(_ context.Context, duration time.Duration) error {
		durations = append(durations, duration)
		return nil
	}
	t.Cleanup(func() { sleepContext = original })
	return &durations
}

func assertExitCode(t *testing.T, err error, code int) {
	t.Helper()
	var exit exitCodeError
	if !errors.As(err, &exit) || exit.Code != code {
		t.Fatalf("err=%v, want exit code %d", err, code)
	}
}

func TestPRChecksFreshMetadataPagesAndMaps(t *testing.T) {
	f := newPRChecksFixture()
	for i := 0; i < 100; i++ {
		f.runs = append(f.runs, map[string]any{"id": 1000 + i, "head_sha": metadataHead, "check_suite_id": 1000 + i, "workflow_id": 401, "name": "wrong", "event": "push"})
		f.workflows = append(f.workflows, map[string]any{"id": 1000 + i, "name": "unrelated", "state": "active", "path": ".github/workflows/other.yml"})
	}
	generation := 0
	relayTestServer(t, func(r map[string]any) any {
		headers, _ := r["headers"].(map[string]any)
		if headers["cache-control"] != "max-age=0" {
			t.Errorf("fresh acquisition page must bypass cache: %v", r)
		}
		f.runs[0].(map[string]any)["event"] = []string{"push", "pull_request"}[generation]
		f.workflows[0].(map[string]any)["name"] = []string{"Old CI", "New CI"}[generation]
		return f.response(t, r)
	})
	client, err := newGHRelayClient()
	if err != nil {
		t.Fatal(err)
	}
	for generation = 0; generation < 2; generation++ {
		items, err := prCheckItemsForSHAFresh(t.Context(), client, "acme/repo", metadataHead)
		if err != nil {
			t.Fatal(err)
		}
		row := items[0]
		if row.Workflow != []string{"Old CI", "New CI"}[generation] || row.Event != []string{"push", "pull_request"}[generation] {
			t.Errorf("fresh maps must be acquisition-owned: %v", row)
		}
	}
	if f.calls("/actions/runs") != 4 || f.calls("/actions/workflows") != 4 {
		t.Errorf("all metadata pages must be reacquired: runs=%d catalogue=%d", f.calls("/actions/runs"), f.calls("/actions/workflows"))
	}
}

func TestPRChecksWatchHeadChangesDuringHydration(t *testing.T) {
	for _, stage := range []string{"contexts", "catalogue"} {
		t.Run(stage, func(t *testing.T) {
			f := newPRChecksFixture()
			relayTestServer(t, func(r map[string]any) any {
				body := f.response(t, r)
				path := r["path"].(string)
				if stage == "contexts" && strings.HasSuffix(path, "/status") || stage == "catalogue" && strings.HasSuffix(path, "/actions/workflows") {
					f.head = map[string]any{"sha": strings.Repeat("f", 40), "ref": "feature"}
				}
				return body
			})
			client, err := newGHRelayClient()
			if err != nil {
				t.Fatal(err)
			}
			items, confirmed, err := confirmPRChecksTerminal(t.Context(), client, ghPRChecksWatchOptions{repo: "acme/repo", number: "7"}, metadataHead)
			if err != nil || confirmed || len(items) != 0 {
				t.Errorf("head moved during terminal hydration: confirmed=%v items=%d err=%v", confirmed, len(items), err)
			}
			if f.calls("/pulls/7") != 2 || f.requests[len(f.requests)-1]["path"] != "/repos/acme/repo/pulls/7" {
				t.Errorf("terminal hydration needs final live head read: %v", f.requests)
			}
			for _, r := range f.requests {
				h, _ := r["headers"].(map[string]any)
				if h["cache-control"] != "max-age=0" {
					t.Errorf("non-fresh confirmation read: %v", r)
				}
			}
		})
	}
}

func TestPRChecksWatchMetadataFailureOwnership(t *testing.T) {
	for _, scenario := range []string{"typed-before", "typed-after", "relay-before", "relay-after", "no-fallback-before", "no-fallback-after"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPRChecksFixture()
			after := strings.HasSuffix(scenario, "after")
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				req := decodeCLIRequest(t, w, r)
				body := f.response(t, req)
				headers, _ := req["headers"].(map[string]any)
				if req["path"] == "/repos/acme/repo/actions/workflows" && (!after || headers["cache-control"] == "max-age=0") {
					if strings.HasPrefix(scenario, "typed") {
						body = map[string]any{"total_count": 0, "workflows": []any{}}
					} else {
						writeCLIFallback(t, w, "repo_not_public")
						return
					}
				}
				writeCLIEnvelope(t, w, body)
			})
			capture := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if strings.HasPrefix(scenario, "no-fallback") {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "checks", "7", "-R", "acme/repo", "--watch"}, &out, &stderr)
			childAllowed := scenario == "typed-before" || strings.HasPrefix(scenario, "relay")
			if childAllowed {
				if err != nil || strings.Count(out.String(), "child stdout\n") != 1 {
					t.Fatalf("one guarded child expected: err=%v out=%q stderr=%q", err, out.String(), stderr.String())
				}
				if _, e := os.Stat(capture); e != nil {
					t.Error("missing child capture")
				}
				boundary := "falling back to real gh"
				if after {
					boundary = "continuing watch with real gh"
				}
				if strings.Count(stderr.String(), boundary) != 1 {
					t.Errorf("one fallback boundary: %q", stderr.String())
				}
			} else {
				if err == nil || strings.Contains(out.String(), "child stdout") || strings.Contains(out.String(), "unit\t") || strings.Contains(stderr.String(), "real gh") {
					t.Errorf("no final output/handoff after client failure or NO_FALLBACK: err=%v out=%q stderr=%q", err, out.String(), stderr.String())
				}
				if _, e := os.Stat(capture); !os.IsNotExist(e) {
					t.Error("forbidden native child ran")
				}
				if after && isLocalFallback(err) && !strings.HasPrefix(scenario, "no-fallback") {
					t.Errorf("client failure after progress retained fallback type: %v", err)
				}
			}
			if after != strings.Contains(out.String(), "checks:") {
				t.Errorf("progress ownership: after=%v out=%q", after, out.String())
			}
		})
	}
}

func TestPRChecksWatchActivePolicyDelegatesBeforeHandler(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		t.Error("active-policy watch must retain pre-handler delegation")
		w.WriteHeader(400)
	})
	capture := captureRewriteGH(t)
	var out, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"pr", "checks", "7", "-R", "acme/repo", "--watch", "--interval", "1"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if out.String() != "child stdout\n" {
		t.Fatalf("output=%q", out.String())
	}
	if _, err := os.Stat(capture); err != nil {
		t.Fatal(err)
	}
}

func TestPRChecksWatchStaleRemainsPending(t *testing.T) {
	f := newPRChecksFixture()
	relayTestServer(t, func(r map[string]any) any {
		if r["path"] == "/repos/acme/repo/commits/"+metadataHead+"/check-runs" {
			conclusion := "success"
			if f.calls("/check-runs") == 0 {
				conclusion = "stale"
			}
			f.checks[0].(map[string]any)["conclusion"] = conclusion
		}
		return f.response(t, r)
	})
	sleeps := recordWatchSleeps(t)
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "acme/repo", "--watch"}, &out)
	if result.err != nil || result.action != ghComplete || !reflect.DeepEqual(*sleeps, []time.Duration{30 * time.Second}) || !strings.Contains(out.String(), "checks: 1 pending, 0 pass, 0 fail, 0 cancel") || !strings.Contains(out.String(), "unit\tpass\tSUCCESS") {
		t.Fatalf("stale must remain pending until next completion: result=%+v sleeps=%v out=%q", result, *sleeps, out.String())
	}
}
