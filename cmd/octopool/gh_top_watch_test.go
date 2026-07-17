package main

import (
	"bytes"
	"context"
	"errors"
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
			statuses := []string{"queued", "in_progress", "in_progress", "completed"}
			return map[string]any{"status": statuses[runCalls-1], "conclusion": "failure"}
		case "/repos/openclaw/octopool/actions/runs/42/jobs":
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
	if runCalls != 4 || jobsCalls != 1 {
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
		if calls == 2 {
			status = "completed"
			conclusion = "success"
		}
		return map[string]any{"status": status, "conclusion": conclusion}
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
		return map[string]any{"status": "completed", "conclusion": "success"}
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
		return map[string]any{"status": "completed", "conclusion": "failure"}
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
			if checkCalls == 2 {
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
		"checks: 1 pending, 1 pass, 0 fail",
		"checks: 0 pending, 2 pass, 0 fail",
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
	if checkCalls != 1 || len(*sleeps) != 0 {
		t.Fatalf("check calls=%d sleeps=%v", checkCalls, *sleeps)
	}
	if !strings.Contains(out.String(), "checks: 1 pending, 0 pass, 1 fail") || !strings.Contains(out.String(), "CI\tfail\tFAILURE") {
		t.Fatalf("out=%q", out.String())
	}
}

func TestGHPRChecksWatchJSONFinalSnapshot(t *testing.T) {
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
	result := handleGHPR(t.Context(), []string{"checks", "7", "-R", "openclaw/octopool", "--watch", "--json", "name,bucket"}, &out)
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if !strings.Contains(out.String(), `[{"bucket":"pass","name":"CI"}]`) {
		t.Fatalf("out=%q", out.String())
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

func TestWatchFallbackOnlyBeforeProgress(t *testing.T) {
	fallback := localFallbackError{Reason: "route denied"}
	if err := watchError(fallback, false); !shouldRunRealGH(err) {
		t.Fatalf("first-tick error should preserve fallback: %v", err)
	}
	if err := watchError(fallback, true); shouldRunRealGH(err) || err.Error() != fallback.Error() {
		t.Fatalf("post-progress error should fail locally: %v", err)
	}
}

func recordWatchSleeps(t *testing.T) *[]time.Duration {
	t.Helper()
	original := watchSleep
	durations := []time.Duration{}
	watchSleep = func(_ context.Context, duration time.Duration) error {
		durations = append(durations, duration)
		return nil
	}
	t.Cleanup(func() { watchSleep = original })
	return &durations
}

func assertExitCode(t *testing.T, err error, code int) {
	t.Helper()
	var exit exitCodeError
	if !errors.As(err, &exit) || exit.Code != code {
		t.Fatalf("err=%v, want exit code %d", err, code)
	}
}
