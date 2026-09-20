package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestRunListCommitEventFiltersUseREST(t *testing.T) {
	for _, active := range []bool{false, true} {
		for _, test := range []struct {
			name     string
			flags    []string
			query    map[string]any
			workflow bool
			fresh    bool
		}{
			{"commit", []string{"--commit", runExportHead}, map[string]any{"head_sha": runExportHead}, false, false},
			{"short commit", []string{"-c", runExportHead}, map[string]any{"head_sha": runExportHead}, false, false},
			{"attached commit", []string{"-c" + runExportHead}, map[string]any{"head_sha": runExportHead}, false, false},
			{"event", []string{"--event=pull_request"}, map[string]any{"event": "pull_request"}, false, false},
			{"short event", []string{"-e", "pull_request"}, map[string]any{"event": "pull_request"}, false, false},
			{"attached event", []string{"-epull_request"}, map[string]any{"event": "pull_request"}, false, false},
			{"workflow and fresh", []string{"--commit=" + runExportHead, "-e=pull_request", "--workflow", "ci.yml"}, map[string]any{"head_sha": runExportHead, "event": "pull_request"}, true, true},
			{"last aliases win", []string{"--commit=old", "-c", runExportHead, "-epush", "--event", "pull_request"}, map[string]any{"head_sha": runExportHead, "event": "pull_request"}, false, false},
			{"empty last values remove filters", []string{"-c", runExportHead, "--commit=", "--event=push", "-e", ""}, map[string]any{}, false, false},
			{"literal case and equals", []string{"-c=", "--event=PULL_REQUEST"}, map[string]any{"head_sha": "=", "event": "PULL_REQUEST"}, false, false},
		} {
			t.Run(test.name+"/active="+strconv.FormatBool(active), func(t *testing.T) {
				policy := rewriteEmptyTestPolicy
				if active {
					policy = rewriteActiveTestPolicy
				}
				f := newRunExportFixture()
				rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					var request map[string]any
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
						return
					}
					writeCLIEnvelope(t, w, f.response(t, request))
				})
				capture := captureRewriteGH(t)
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				t.Setenv("OCTOPOOL_FRESH", "")
				if test.fresh {
					t.Setenv("OCTOPOOL_FRESH", "1")
				}
				args := append([]string{"gh", "run", "list", "-R", "acme/repo", "--limit=1", "--json=databaseId"}, test.flags...)
				var stdout, stderr bytes.Buffer
				err := run(t.Context(), args, &stdout, &stderr)
				_, nativeErr := os.Stat(capture)
				if err != nil || !os.IsNotExist(nativeErr) || stdout.String() != "[{\"databaseId\":42}]\n" || len(f.requests) != 1 {
					t.Fatalf("err=%v stdout=%q stderr=%q requests=%v native=%v", err, stdout.String(), stderr.String(), f.paths(), nativeErr)
				}
				wantPath := "/repos/acme/repo/actions/runs"
				if test.workflow {
					wantPath = "/repos/acme/repo/actions/workflows/ci.yml/runs"
				}
				test.query["per_page"] = "1"
				if f.requests[0]["path"] != wantPath || !reflect.DeepEqual(f.requests[0]["query"], test.query) {
					t.Fatalf("request=%v want path=%s query=%v", f.requests[0], wantPath, test.query)
				}
				headers, _ := f.requests[0]["headers"].(map[string]any)
				if headers["x-octopool-public-shape"] != nil || (test.fresh && headers["cache-control"] != "max-age=0") || (!test.fresh && headers["cache-control"] != nil) {
					t.Fatalf("REST/freshness contract changed: %v", headers)
				}
			})
		}
	}
}

func TestRunListFiltersPreserveNativeAndProtectionBoundaries(t *testing.T) {
	for _, flags := range [][]string{{"--commit", runExportHead}, {"--event", "pull_request"}, {"--commit", runExportHead, "--json", "databaseId", "--limit", "101"}, {"--event", "pull_request", "--json", "databaseId", "--created", "2026-01-01"}} {
		t.Run(strings.Join(flags, " "), func(t *testing.T) {
			var calls int
			rewriteTestServer(t, rewriteActiveTestPolicy, func(http.ResponseWriter, *http.Request) { calls++ })
			capture := captureRewriteGH(t)
			var stdout, stderr bytes.Buffer
			args := append([]string{"gh", "run", "list", "-R", "acme/repo"}, flags...)
			if err := run(t.Context(), args, &stdout, &stderr); err != nil {
				t.Fatal(err)
			}
			if calls != 0 || stdout.String() != "child stdout\n" {
				t.Fatalf("calls=%d output=%q", calls, stdout.String())
			}
			native := readRewriteCapture(t, capture)
			for _, flag := range flags {
				if !slices.Contains(native.Args, flag) {
					t.Fatalf("native argument lost: %s in %v", flag, native.Args)
				}
			}
		})
	}
	for _, flag := range []string{"--commit", "--event"} {
		t.Run("overwritten protected "+flag, func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capture := captureRewriteGH(t)
			var stdout, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "run", "list", "-R", "acme/repo", "--json", "databaseId", flag, "internal-model", flag, "safe"}, &stdout, &stderr)
			if !errors.Is(err, errRewriteBlocked) || stdout.Len() != 0 {
				t.Fatalf("err=%v output=%q", err, stdout.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("protected input reached native gh")
			}
		})
	}
}

func TestRunListCommitGuardsCanonicalQueryKey(t *testing.T) {
	for _, machine := range []bool{false, true} {
		t.Run("machine="+strconv.FormatBool(machine), func(t *testing.T) {
			var calls int
			policy := strings.Replace(rewriteActiveTestPolicy, "internal-model", "head_sha", 1)
			rewriteTestServer(t, policy, func(http.ResponseWriter, *http.Request) { calls++ })
			capture := captureRewriteGH(t)
			args := []string{"gh", "run", "list", "-R", "acme/repo", "--commit", runExportHead}
			if machine {
				args = append(args, "--json", "databaseId")
			}
			var stdout, stderr bytes.Buffer
			err := run(t.Context(), args, &stdout, &stderr)
			if !errors.Is(err, errRewriteBlocked) || stdout.Len() != 0 || calls != 0 {
				t.Fatalf("err=%v output=%q data calls=%d", err, stdout.String(), calls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("protected query key reached native gh")
			}
		})
	}
}

func TestRunListFilterFallbackRetainsFilters(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(disabled), func(t *testing.T) {
			var calls int
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, _ *http.Request) { calls++; writeCLIFallback(t, w, "repo_not_public") })
			capture := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if disabled {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			var stdout, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "run", "list", "-R", "acme/repo", "--json", "databaseId", "-c" + runExportHead, "--event", "pull_request"}, &stdout, &stderr)
			if calls != 1 {
				t.Fatalf("relay calls=%d", calls)
			}
			if disabled {
				if !isLocalFallback(err) || stdout.Len() != 0 {
					t.Fatalf("err=%v output=%q", err, stdout.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("disabled fallback reached native gh")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				native := readRewriteCapture(t, capture)
				want := []string{"run", "list", "--repo=acme/repo", "--json", "databaseId", "-c" + runExportHead, "--event", "pull_request"}
				if !slices.Equal(native.Args, want) {
					t.Fatalf("native filters changed: %v", native.Args)
				}
			}
		})
	}
}
