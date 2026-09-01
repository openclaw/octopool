package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestRunOwnershipFreshAndHistoricalHead(t *testing.T) {
	for _, id := range []string{"33167365292", "33167365221"} {
		for _, fresh := range []bool{false, true} {
			t.Run(id+"/fresh="+strconv.FormatBool(fresh), func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "0")
				if fresh {
					t.Setenv("OCTOPOOL_FRESH", "1")
				}
				const head = "224a80eeebec678db6646ef888f5bbc89caf63c4"
				var paths []string
				relayTestServer(t, func(body map[string]any) any {
					path := body["path"].(string)
					paths = append(paths, path)
					headers, _ := body["headers"].(map[string]any)
					if fresh && headers["cache-control"] != "max-age=0" {
						t.Errorf("%s headers=%v, want max-age=0", path, headers)
					}
					if !fresh && headers["cache-control"] != nil {
						t.Errorf("ordinary %s read bypasses cache: %v", path, headers)
					}
					if strings.HasSuffix(path, "/jobs") {
						return map[string]any{"total_count": 0, "jobs": []any{}}
					}
					if path == "/repos/openclaw/Peekaboo/actions/workflows/9" {
						return map[string]any{"id": 9, "name": "CI", "path": ".github/workflows/ci.yml", "state": "active"}
					}
					numericID, _ := strconv.ParseInt(id, 10, 64)
					return map[string]any{"id": numericID, "workflow_id": 9, "head_sha": head, "head_branch": "fixture-branch", "event": "pull_request", "name": "historical label", "run_attempt": 1, "pull_requests": []any{map[string]any{"head": map[string]any{"sha": "9999999999999999999999999999999999999999"}}}}
				})
				var out bytes.Buffer
				result := handleGHRun(t.Context(), []string{"view", id, "-R", "openclaw/Peekaboo", "--json", "databaseId,headSha,headBranch,event,workflowName,jobs"}, &out)
				if result.err != nil || result.action != ghComplete {
					t.Fatalf("result=%+v", result)
				}
				var got map[string]any
				if err := json.Unmarshal(out.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if got["headSha"] != head || got["workflowName"] != "CI" {
					t.Fatalf("historical head mapping=%v", got)
				}
				if !reflect.DeepEqual(paths, []string{
					"/repos/openclaw/Peekaboo/actions/runs/" + id,
					"/repos/openclaw/Peekaboo/actions/runs/" + id + "/attempts/1/jobs",
					"/repos/openclaw/Peekaboo/actions/workflows/9",
				}) {
					t.Fatalf("paths=%v", paths)
				}
			})
		}
	}
}

func TestRelayFreshPreservesExplicitHeadersAndCallerMap(t *testing.T) {
	t.Setenv("OCTOPOOL_FRESH", "1")
	var seen map[string]any
	relayTestServer(t, func(body map[string]any) any { seen, _ = body["headers"].(map[string]any); return map[string]any{} })
	client, err := newGHRelayClient()
	if err != nil {
		t.Fatal(err)
	}
	for _, headers := range []map[string]string{nil, {"x-octopool-public-shape": "actions-summary-v1"}, {"cache-control": "max-age=60"}, {"cache-control": ""}} {
		before := maps.Clone(headers)
		_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/Peekaboo/actions/runs/33167365292", headers: headers})
		if err != nil {
			t.Fatal(err)
		}
		want, explicit := headers["cache-control"]
		if !explicit {
			want = "max-age=0"
		}
		if seen["cache-control"] != want {
			t.Errorf("headers=%v want cache-control=%q", seen, want)
		}
		if !maps.Equal(headers, before) {
			t.Errorf("mutated caller headers: before=%v after=%v", before, headers)
		}
	}
	request, delegate, err := parseGHAPIArgs([]string{"repos/openclaw/Peekaboo/actions/runs/33167365292", "-H", "Cache-Control: max-age=60"})
	if err != nil || delegate {
		t.Fatalf("delegate=%v err=%v", delegate, err)
	}
	if _, err := client.do(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	if seen["cache-control"] != "max-age=60" {
		t.Fatalf("raw explicit headers=%v", seen)
	}
}

func TestRunExportRESTTransport(t *testing.T) {
	for _, command := range []string{"list", "view", "raw"} {
		t.Run(command, func(t *testing.T) {
			f := newRunExportFixture()
			job := runExportJob(7)
			f.jobs = map[string]any{"total_count": 1, "jobs": []any{job}}
			relayTestServer(t, func(req map[string]any) any {
				body := f.response(t, req)
				headers, _ := req["headers"].(map[string]any)
				if headers["x-octopool-public-shape"] != nil {
					t.Errorf("machine JSON opted into unproved page shape: path=%v headers=%v", req["path"], headers)
					if strings.HasSuffix(req["path"].(string), "/jobs") {
						pageJob := maps.Clone(job)
						pageJob["started_at"] = "2026-01-02T03:04:07Z" // Earliest step, not actual job start.
						return map[string]any{"total_count": 1, "jobs": []any{pageJob}}
					}
					pageRun := maps.Clone(f.run)
					pageRun["name"], pageRun["updated_at"] = "page workflow label", "2026-01-02T03:06:06Z"
					delete(pageRun, "workflow_id")
					if command == "list" {
						return map[string]any{"total_count": 1, "workflow_runs": []any{pageRun}}
					}
					return pageRun
				}
				return body
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_FRESH", "0")
			capture := captureRewriteGH(t)
			args := runExportArgs(command, "name,updatedAt")
			if command == "view" {
				args = runExportArgs(command, "name,updatedAt,jobs")
			}
			if command == "raw" {
				args = []string{"api", "repos/acme/repo/actions/runs/42"}
			}
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("transport proof delegated")
			}
			if !strings.Contains(out.String(), `"name":"source run label"`) || !strings.Contains(out.String(), "2026-01-02T03:06:05Z") {
				t.Errorf("page reconstruction projected as native REST: %s", out.String())
			}
			for _, req := range f.requests {
				headers, _ := req["headers"].(map[string]any)
				if headers["cache-control"] != nil {
					t.Errorf("ordinary REST lost shared-cache eligibility: %v", headers)
				}
			}
			if command == "view" && !strings.Contains(out.String(), `"startedAt":"2026-01-02T03:04:06Z"`) {
				t.Errorf("page earliest-step time exported as native job start: %s", out.String())
			}
			if command == "raw" {
				if !strings.Contains(out.String(), `"workflow_id":9`) || !strings.Contains(out.String(), `"run_attempt":3`) {
					t.Error("raw REST was projected")
				}
			}
			wantPaths := []string{"/repos/acme/repo/actions/runs/42"}
			if command == "list" {
				wantPaths[0] = "/repos/acme/repo/actions/runs"
			}
			if command == "view" {
				wantPaths = append(wantPaths, "/repos/acme/repo/actions/runs/42/attempts/3/jobs")
			}
			if !reflect.DeepEqual(f.paths(), wantPaths) {
				t.Errorf("canonical routes %v want %v", f.paths(), wantPaths)
			}
		})
	}
}

func TestRunExportPolicyAndNativeBoundary(t *testing.T) {
	for _, scenario := range []string{
		"supported", "domain_no_fallback", "domain_native", "pagination_native",
		"initial_denial", "metadata_denial", "final_domain_denial", "final_pagination_denial",
		"late_step_no_jq", "late_workflow_no_jq",
	} {
		t.Run(scenario, func(t *testing.T) {
			if strings.Contains(scenario, "jq") && !jqAvailable() {
				t.Skip("existing jq required for relay eligibility")
			}
			f := newRunExportFixture()
			fields := "databaseId,number"
			wantCalls, wantPolicies := 1, int64(2)
			wantReason := ""
			wantNative, wantBlocked, terminal := false, false, false
			if strings.Contains(scenario, "domain") {
				f.run["run_number"] = json.RawMessage("9007199254740992")
				wantReason = "unsupported_run_export"
			}
			if strings.Contains(scenario, "pagination") {
				fields = "databaseId,jobs"
				jobs := make([]any, 100)
				for i := range jobs {
					jobs[i] = runExportJob(i + 1)
				}
				f.jobs = map[string]any{"total_count": 101, "jobs": jobs}
				wantCalls, wantPolicies, wantReason = 2, 3, "workflow jobs response requires pagination"
			}
			if scenario == "domain_native" || scenario == "pagination_native" {
				wantNative = true
				wantPolicies++
			}
			if strings.HasPrefix(scenario, "final_") {
				wantBlocked = true
				wantPolicies++
			}
			if scenario == "initial_denial" {
				wantCalls, wantPolicies, wantBlocked = 0, 1, true
			}
			if scenario == "metadata_denial" {
				fields, wantCalls, wantPolicies, wantBlocked = "databaseId,workflowName", 1, 3, true
			}
			if scenario == "late_step_no_jq" {
				fields, wantCalls, wantPolicies, terminal = "databaseId,jobs", 2, 3, true
				job := runExportJob(7)
				job["steps"] = []any{map[string]any{"number": 1}, map[string]any{"number": "2"}}
				f.jobs = map[string]any{"total_count": 1, "jobs": []any{job}}
			}
			if scenario == "late_workflow_no_jq" {
				fields, wantCalls, wantPolicies, terminal = "databaseId,workflowName", 2, 3, true
				f.lookups["9"].(map[string]any)["id"] = 10
			}
			policies := rewriteTestServerPolicySequence(t, func(n int64) (string, int) {
				if scenario == "initial_denial" || (strings.HasPrefix(scenario, "final_") && n == wantPolicies) {
					return strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "acme/repo"), http.StatusOK
				}
				if scenario == "metadata_denial" && n >= 3 {
					return strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "/actions/workflows/"), http.StatusOK
				}
				return rewriteActiveTestPolicy, http.StatusOK
			}, func(w http.ResponseWriter, r *http.Request) {
				req := decodeCLIRequest(t, w, r)
				writeCLIEnvelope(t, w, f.response(t, req))
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if scenario == "domain_no_fallback" {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "acme/inherited")
			capture := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", capture+".calls")
			args := runExportArgs("view", fields)
			if strings.Contains(scenario, "jq") {
				args = append(args, "--jq", `"LOCAL JQ PREFIX"`)
			}
			original := append([]string(nil), args...)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			calls, callErr := os.ReadFile(capture + ".calls")
			t.Logf("scenario=%s policies=%d paths=%v child=%q err=%T:%v out=%q stderr=%q", scenario, policies.Load(), f.paths(), calls, err, err, out.String(), stderr.String())
			if !reflect.DeepEqual(args, original) || os.Getenv("GH_HOST") != "github.com" || os.Getenv("GH_REPO") != "acme/inherited" {
				t.Error("caller argv/environment mutated")
			}
			if len(f.requests) != wantCalls || policies.Load() != wantPolicies {
				t.Errorf("owner reachability/data-policy budget got %d/%d want %d/%d", len(f.requests), policies.Load(), wantCalls, wantPolicies)
			}
			if wantNative {
				if err != nil || out.String() != "child stdout\n" || string(calls) != "child\n" || callErr != nil || !strings.Contains(stderr.String(), wantReason) {
					t.Errorf("whole-command guarded handoff missing: err=%v output=%q child=%q", err, out.String(), calls)
				}
				if _, e := os.Stat(capture); e == nil {
					got := readRewriteCapture(t, capture)
					wantArgs := []string{"run", "view", "42", "--repo=acme/repo", "--json", fields}
					if !reflect.DeepEqual(got.Args, wantArgs) || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" {
						t.Errorf("native host/repo pins: %+v", got)
					}
				}
				return
			}
			if !os.IsNotExist(callErr) {
				t.Errorf("unexpected native child %q (%v)", calls, callErr)
			}
			if wantBlocked {
				if !errors.Is(err, errRewriteBlocked) || isLocalFallback(err) || out.Len() != 0 {
					t.Errorf("fresh policy must block data/native without output: %v %q", err, out.String())
				}
			} else if terminal {
				assertRunExportFailure(t, out.String(), err, "terminal")
			} else if wantReason != "" {
				assertRunExportFailure(t, out.String(), err, wantReason)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertRunExportJSON(t, out.String(), `{"databaseId":42,"number":17}`)
			}
		})
	}
}
