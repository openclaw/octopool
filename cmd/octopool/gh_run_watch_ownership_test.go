package main

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestGHRunWatchKeepsRelayOwnership(t *testing.T) {
	for _, phase := range []string{"initial", "poll", "confirmation", "jobs"} {
		for _, reason := range []string{"pagination_exhausted", "relay_overloaded", "repo_not_public", "route_denied"} {
			if phase == "initial" && reason == "repo_not_public" {
				continue // The initial private-repository lookup deliberately delegates.
			}
			t.Run(phase+"/"+reason, func(t *testing.T) {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
				useTestRelayRetryDelays(t, time.Millisecond, time.Millisecond)
				t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
				sleeps := recordWatchSleeps(t)
				runCalls, failedCalls := 0, 0
				relayTestServer(t, func(body map[string]any) any {
					isJobs := strings.HasSuffix(body["path"].(string), "/jobs")
					if !isJobs {
						runCalls++
					}
					fail := phase == "initial" || phase == "jobs" && isJobs ||
						(phase == "poll" || phase == "confirmation") && runCalls > 1
					if fail {
						failedCalls++
						return relayFallbackFixture(reason)
					}
					status := "completed"
					if phase == "poll" {
						status = "in_progress"
					}
					return map[string]any{"status": status, "conclusion": "success", "run_attempt": 2}
				})
				var stdout, stderr bytes.Buffer
				err := runGH(t.Context(), []string{"run", "watch", "42", "-R", "openclaw/octopool", "--exit-status"}, &stdout, &stderr)
				if err == nil || shouldRunRealGH(err) || !strings.Contains(err.Error(), reason) ||
					strings.Contains(stdout.String(), fakeGHArgvPrefix) || strings.Contains(stderr.String(), "real gh") {
					t.Fatalf("err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
				}
				wantFailures := 1
				if reason == "relay_overloaded" {
					wantFailures = 3
				}
				wantSleeps := 0
				if phase == "poll" {
					wantSleeps = 1
				}
				wantSleeps += wantFailures - 1 // The relay client shares the sleep hook.
				if failedCalls != wantFailures || len(*sleeps) != wantSleeps {
					t.Fatalf("failed calls=%d sleeps=%v", failedCalls, *sleeps)
				}
				if strings.Contains(stdout.String(), "completed with") || strings.Contains(stdout.String(), "job ") {
					t.Fatalf("failure printed a final summary: %q", stdout.String())
				}
			})
		}
	}
}

func TestGHRunWatchRejectsIncompleteJobs(t *testing.T) {
	for _, variant := range []string{"rerun count mismatch", "missing count", "fractional count", "changed count", "next link", "short next page", "cap"} {
		t.Run(variant, func(t *testing.T) {
			t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			recordWatchSleeps(t)
			jobCalls := 0
			relayTestServer(t, func(body map[string]any) any {
				if !strings.HasSuffix(body["path"].(string), "/jobs") {
					return map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 2}
				}
				jobCalls++
				count, total := 1, any(3)
				headers := map[string]string{}
				switch variant {
				case "missing count":
					total = nil
				case "fractional count":
					total = 1.5
				case "changed count":
					count, total = relayPageSize, 150
					if jobCalls == 2 {
						count, total = 50, 151
					}
				case "next link":
					total = 1
					headers["Link"] = `<https://api.github.com/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs?page=2>; rel="next"`
				case "short next page":
					count, total = relayPageSize, 150
					if jobCalls == 2 {
						count = 1
					}
				case "cap":
					count, total = relayPageSize, maxRelayPages*relayPageSize+1
				}
				jobs := make([]map[string]any, count)
				for index := range jobs {
					jobs[index] = map[string]any{"id": jobCalls*relayPageSize + index, "name": "Swift", "conclusion": "success"}
				}
				return relayTestResponse{Headers: headers, Body: map[string]any{"total_count": total, "jobs": jobs}}
			})
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"run", "watch", "42", "-R", "openclaw/octopool"}, &stdout, &stderr)
			if err == nil || strings.Contains(stdout.String(), fakeGHArgvPrefix) || strings.Contains(stdout.String(), "job ") || strings.Contains(stdout.String(), "completed with") {
				t.Fatalf("err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
			}
			wantCalls := 1
			if variant == "changed count" || variant == "short next page" {
				wantCalls = 2
			} else if variant == "cap" {
				wantCalls = maxRelayPages
			}
			if jobCalls != wantCalls {
				t.Fatalf("job calls=%d, want %d", jobCalls, wantCalls)
			}
		})
	}
}

func TestGHRunWatchRerunAttemptAndExitStatus(t *testing.T) {
	for _, conclusion := range []string{"success", "failure", "cancelled", "timed_out"} {
		for _, exitStatus := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/exit-status=%t", conclusion, exitStatus), func(t *testing.T) {
				runCalls, jobCalls := 0, 0
				recordWatchSleeps(t)
				relayTestServer(t, func(body map[string]any) any {
					switch body["path"] {
					case "/repos/openclaw/octopool/actions/runs/42":
						runCalls++
						if runCalls == 1 {
							return map[string]any{"status": "completed", "conclusion": "failure", "run_attempt": 1}
						}
						if body["headers"].(map[string]any)["cache-control"] != "max-age=0" {
							t.Error("confirmation must be fresh")
						}
						return map[string]any{"status": "completed", "conclusion": conclusion, "run_attempt": 2}
					case "/repos/openclaw/octopool/actions/runs/42/attempts/2/jobs":
						jobCalls++
						// Preserve reused successes if the attempt endpoint returns them;
						// never fetch attempt 1 to reconstruct or replace this snapshot.
						return map[string]any{"total_count": 3, "jobs": []map[string]any{
							{"id": 1, "name": "actions", "run_attempt": 1, "conclusion": "success"},
							{"id": 2, "name": "JavaScript", "run_attempt": 1, "conclusion": "success"},
							{"id": 3, "name": "Swift", "run_attempt": 2, "conclusion": conclusion},
						}}
					default:
						t.Errorf("unexpected path %v", body["path"])
						return nil
					}
				})
				var stdout bytes.Buffer
				args := []string{"watch", "42", "-R", "openclaw/octopool"}
				if exitStatus {
					args = append(args, "--exit-status")
				}
				result := handleGHRun(t.Context(), args, &stdout)
				if exitStatus && conclusion != "success" {
					assertExitCode(t, result.err, 1)
				} else if result.action != ghComplete || result.err != nil {
					t.Fatalf("action=%v err=%v", result.action, result.err)
				}
				if runCalls != 2 || jobCalls != 1 || strings.Count(stdout.String(), "job ") != 3 ||
					!strings.Contains(stdout.String(), "Run 42 completed with '"+conclusion+"'") {
					t.Fatalf("runs=%d jobs=%d stdout=%q", runCalls, jobCalls, stdout.String())
				}
			})
		}
	}
}

func TestCLIRunWatchPaginationFailureDoesNotLaunchNative(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	for _, phase := range []string{"initial", "confirmation", "jobs"} {
		t.Run(phase, func(t *testing.T) {
			calls := 0
			server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
				calls++
				failAt := map[string]int{"initial": 1, "confirmation": 2, "jobs": 3}[phase]
				if calls >= failAt {
					writeCLIFallback(t, w, "pagination_exhausted")
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 2})
			})
			result := runCLI(t, bin, server.URL, map[string]string{
				"OCTOPOOL_GH_PATH": fakeGHExit(t, 0), "OCTOPOOL_NO_FALLBACK": "", "OCTOPOOL_RELAY_RETRIES": "0",
			}, "gh", "run", "watch", "42", "-R", "openclaw/octopool", "--exit-status")
			if result.err == nil || strings.Contains(result.stdout, fakeGHArgvPrefix) || !strings.Contains(result.stderr, "pagination_exhausted") {
				t.Fatalf("calls=%d err=%v stdout=%q stderr=%q", calls, result.err, result.stdout, result.stderr)
			}
		})
	}
}

func TestGHRunWatchMissingMetadataStops(t *testing.T) {
	for _, phase := range []string{"initial status", "confirmed status", "confirmed conclusion"} {
		t.Run(phase, func(t *testing.T) {
			t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
			sleeps := recordWatchSleeps(t)
			calls := 0
			relayTestServer(t, func(map[string]any) any {
				calls++
				if calls > 2 {
					return relayFallbackFixture("metadata_request_bound")
				}
				body := map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 2}
				if phase == "initial status" || calls > 1 {
					field := "status"
					if phase == "confirmed conclusion" {
						field = "conclusion"
					}
					delete(body, field)
				}
				return body
			})
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"run", "watch", "42", "-R", "openclaw/octopool"}, &stdout, &stderr)
			if err == nil || strings.Contains(stdout.String(), fakeGHArgvPrefix) || strings.Contains(stdout.String(), "completed with") || calls > 2 || len(*sleeps) != 0 {
				t.Fatalf("err=%v calls=%d sleeps=%v stdout=%q", err, calls, *sleeps, stdout.String())
			}
		})
	}
}
