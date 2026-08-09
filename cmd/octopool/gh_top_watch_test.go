package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
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
					"name": "Test", "status": "completed", "conclusion": "failure",
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
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
					{"name": "CI", "status": status, "conclusion": conclusion, "details_url": "https://example.test/ci"},
					{"name": "Lint", "status": "completed", "conclusion": "success", "details_url": "https://example.test/lint"},
				},
			}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"statuses": []any{}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			checkCalls++
			return map[string]any{"total_count": 2, "check_runs": []map[string]any{
				{"name": "CI", "status": "completed", "conclusion": "failure"},
				{"name": "Integration", "status": "queued"},
			}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"statuses": []any{}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			checkCalls++
			pendingStatus := "queued"
			pendingConclusion := ""
			if checkCalls >= 2 {
				pendingStatus, pendingConclusion = "completed", "success"
			}
			return map[string]any{"total_count": 2, "check_runs": []map[string]any{
				{"name": "CI", "status": "completed", "conclusion": "cancelled"},
				{"name": "Integration", "status": pendingStatus, "conclusion": pendingConclusion},
			}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"statuses": []any{}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case strings.HasSuffix(path, "/check-runs"):
			h, _ := body["headers"].(map[string]any)
			if h["cache-control"] != "max-age=0" {
				// Stale shared-cache entry from before checks registered.
				return map[string]any{"total_count": 0, "check_runs": []any{}}
			}
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case strings.HasSuffix(path, "/check-runs"):
			h, _ := body["headers"].(map[string]any)
			if h["cache-control"] == "max-age=0" {
				// Terminal confirmation sees the checks vanish (rerun lag).
				return map[string]any{"total_count": 0, "check_runs": []any{}}
			}
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"statuses": []any{}}
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
	floored := floorGHWatchDelegateArgs([]string{"run", "watch", "42", "--json", "x", "-i5"})
	if !reflect.DeepEqual(floored, []string{"run", "watch", "42", "--json", "x", "-i30"}) {
		t.Fatalf("delegated -i5 must floor in place, got %v", floored)
	}
	terminated := floorGHWatchDelegateArgs([]string{"run", "watch", "--", "42"})
	if !reflect.DeepEqual(terminated, []string{"run", "watch", "--interval", "30", "--", "42"}) {
		t.Fatalf("injected interval must precede the -- terminator, got %v", terminated)
	}
}

func TestGHPRChecksWatchRevalidatesHeadBeforeTerminal(t *testing.T) {
	checkFetches := []string{}
	relayTestServer(t, func(body map[string]any) any {
		switch path := body["path"].(string); {
		case path == "/repos/openclaw/octopool/pulls/7":
			headers, _ := body["headers"].(map[string]any)
			if headers["cache-control"] == "max-age=0" {
				return map[string]any{"head": map[string]any{"sha": "newsha"}}
			}
			sha := "oldsha"
			if len(checkFetches) > 0 {
				sha = "newsha"
			}
			return map[string]any{"head": map[string]any{"sha": sha}}
		case strings.HasSuffix(path, "/check-runs"):
			sha := strings.Split(path, "/")[5]
			checkFetches = append(checkFetches, sha)
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"statuses": []any{}}
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case strings.HasSuffix(path, "/check-runs"):
			if h, _ := body["headers"].(map[string]any); h["cache-control"] == "max-age=0" {
				freshCheckReads++
				if freshCheckReads == 1 {
					// Rerun in flight: same head SHA, cached payload obsolete.
					return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "in_progress"}}}
				}
			}
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(path, "/status"):
			return map[string]any{"statuses": []any{}}
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
			return map[string]any{"id": 42, "status": "completed", "conclusion": "success", "run_attempt": 1}
		case "/repos/openclaw/octopool/actions/runs/42/attempts/1/jobs":
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
				jobs = append(jobs, map[string]any{"id": offset + index, "name": "job", "status": "completed", "conclusion": "success"})
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

func TestGHWatchDelegatesWithFlooredInterval(t *testing.T) {
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
			want: "real-gh:run watch 42 --web --interval 30",
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

func TestGHWatchExplicitRelayFallbackBeforeProgressDelegates(t *testing.T) {
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
	relayTestServer(t, func(map[string]any) any { return relayFallbackFixture("relay_overloaded") })
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
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case strings.HasSuffix(path, "/check-runs"):
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}}
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
