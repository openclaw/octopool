package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

const metadataHead = "0123456789abcdef0123456789abcdef01234567"

// OpenClaw scripts/pr-lib/worktree.sh:pr_meta_json reads this complete shape.
const metadataFields = "number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,url,body,labels,assignees,changedFiles,additions,deletions,statusCheckRollup,files"

func TestRunGHPRViewMetadataUnderActivePolicy(t *testing.T) {
	for _, test := range []struct{ fresh, fields string }{
		{"", metadataFields}, {"1", metadataFields},
		{"", metadataFields + "," + metadataFields},
		{"", "assignees,assignees," + metadataFields},
	} {
		t.Run("fresh="+test.fresh+"/"+test.fields, func(t *testing.T) {
			t.Setenv("OCTOPOOL_FRESH", test.fresh)
			prCalls := 0
			paths := []string{}
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				path := request["path"].(string)
				paths = append(paths, path)
				headers, _ := request["headers"].(map[string]any)
				immutableOrDescriptive := path == "/users/contributor" || strings.HasSuffix(path, "/files")
				if (!immutableOrDescriptive || test.fresh == "1") && headers["cache-control"] != "max-age=0" {
					t.Errorf("metadata request must be fresh: %#v", request)
				}
				switch path {
				case "/repos/acme/repo/pulls/1":
					prCalls++
					writeCLIEnvelope(t, w, map[string]any{
						"number": 1, "title": "Metadata", "state": "open", "draft": false,
						"user": map[string]any{"id": 13, "node_id": "U_contributor", "login": "contributor", "type": "User"}, "base": map[string]any{"ref": "main"},
						"html_url": "https://github.com/acme/repo/pull/1", "body": "Read metadata", "labels": []any{},
						"changed_files": 1, "additions": 2, "deletions": 1,
						"head": map[string]any{
							"sha": metadataHead, "ref": "feature",
							"repo": map[string]any{"node_id": "R_fork", "id": 12, "name": "repo", "full_name": "contributor/repo"},
							"user": map[string]any{"node_id": "U_contributor", "id": 13, "login": "contributor"},
						},
						"assignees": []any{map[string]any{"node_id": "U_contributor", "id": 13, "login": "contributor"}},
					})
				case "/repos/acme/repo/pulls/1/files":
					if request["route_hint"].(map[string]any)["pr_head_sha"] != metadataHead {
						t.Error("files not bound to metadata head")
					}
					writeCLIEnvelope(t, w, []any{map[string]any{"filename": "fixed.go", "additions": 2, "deletions": 1, "status": "modified"}})
				case "/repos/acme/repo/commits/" + metadataHead + "/check-runs":
					writeCLIEnvelope(t, w, map[string]any{"total_count": 2, "check_runs": []any{
						map[string]any{"id": 1, "name": "unit", "status": "completed", "conclusion": "success", "started_at": "2026-08-29T01:00:00Z", "completed_at": "2026-08-29T01:01:00Z", "details_url": "https://example.test/unit", "check_suite": map[string]any{"id": 42}, "app": map[string]any{"slug": "github-actions"}},
						map[string]any{"id": 2, "name": "external", "status": "queued", "conclusion": nil, "started_at": nil, "completed_at": nil, "details_url": nil, "check_suite": map[string]any{"id": 43}, "app": map[string]any{"slug": "third-party"}},
					}})
				case "/repos/acme/repo/commits/" + metadataHead + "/status":
					writeCLIEnvelope(t, w, map[string]any{"total_count": 1, "statuses": []any{map[string]any{"id": 1, "context": "ci/external", "state": "pending", "target_url": "https://example.test/status", "created_at": "2026-08-29T01:02:00Z"}}})
				case "/users/contributor":
					writeCLIEnvelope(t, w, map[string]any{"node_id": "U_contributor", "id": 13, "login": "contributor", "name": "Contributor", "type": "User"})
				case "/repos/acme/repo/actions/runs":
					query := request["query"].(map[string]any)
					if query["head_sha"] != metadataHead {
						t.Errorf("workflow query = %#v", query)
					}
					writeCLIEnvelope(t, w, map[string]any{"total_count": 1, "workflow_runs": []any{map[string]any{"id": 1, "head_sha": metadataHead, "check_suite_id": 42, "name": "CI"}}})
				default:
					t.Errorf("unexpected metadata path %q", path)
					w.WriteHeader(400)
				}
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", test.fields}, &out, io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{
				"number": float64(1), "headRefOid": metadataHead,
				"title": "Metadata", "state": "OPEN", "isDraft": false,
				"author": map[string]any{"id": "U_contributor", "is_bot": false, "login": "contributor", "name": "Contributor"}, "baseRefName": "main", "headRefName": "feature",
				"url": "https://github.com/acme/repo/pull/1", "body": "Read metadata", "labels": []any{},
				"changedFiles": float64(1), "additions": float64(2), "deletions": float64(1),
				"files":               []any{map[string]any{"path": "fixed.go", "additions": float64(2), "deletions": float64(1), "changeType": "MODIFIED"}},
				"headRepository":      map[string]any{"id": "R_fork", "name": "repo", "nameWithOwner": "contributor/repo"},
				"headRepositoryOwner": map[string]any{"id": "U_contributor", "login": "contributor", "name": "Contributor"},
				"assignees":           []any{map[string]any{"id": "U_contributor", "login": "contributor", "name": "Contributor", "databaseId": float64(13)}},
				"statusCheckRollup": []any{
					map[string]any{"__typename": "CheckRun", "name": "unit", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-08-29T01:00:00Z", "completedAt": "2026-08-29T01:01:00Z", "detailsUrl": "https://example.test/unit"},
					map[string]any{"__typename": "CheckRun", "name": "external", "workflowName": "", "status": "QUEUED", "conclusion": "", "startedAt": "0001-01-01T00:00:00Z", "completedAt": "0001-01-01T00:00:00Z", "detailsUrl": ""},
					map[string]any{"__typename": "StatusContext", "context": "ci/external", "state": "PENDING", "targetUrl": "https://example.test/status", "startedAt": "2026-08-29T01:02:00Z"},
				},
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("metadata = %s, want %#v", out.String(), want)
			}
			if prCalls != 2 || len(paths) != 7 || paths[len(paths)-1] != "/repos/acme/repo/pulls/1" {
				t.Errorf("hydration must finish with head verification: %v", paths)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("metadata unexpectedly ran native gh")
			}
		})
	}
}

func TestRunGHPRViewRollupRejectsUnstableHead(t *testing.T) {
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	for _, scenario := range []string{"missing", "moved", "missing-final"} {
		t.Run(scenario, func(t *testing.T) {
			prCalls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				path := request["path"].(string)
				switch {
				case path == "/repos/acme/repo/pulls/1":
					prCalls++
					sha := metadataHead
					if scenario == "missing" || (scenario == "missing-final" && prCalls == 2) {
						sha = ""
					} else if scenario == "moved" && prCalls == 2 {
						sha = strings.Repeat("f", 40)
					}
					writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": sha}})
				case strings.HasSuffix(path, "/check-runs"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 0, "check_runs": []any{}})
				case strings.HasSuffix(path, "/status"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 0, "statuses": []any{}})
				default:
					t.Errorf("unexpected request %s", path)
					w.WriteHeader(400)
				}
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "statusCheckRollup"}, &out, io.Discard); err == nil {
				t.Fatal("unstable head unexpectedly succeeded")
			}
			if out.Len() != 0 {
				t.Fatalf("published partial metadata: %q", out.String())
			}
			wantCalls := 2
			if scenario == "missing" {
				wantCalls = 1
			}
			if prCalls != wantCalls {
				t.Fatalf("head checks = %d, want %d", prCalls, wantCalls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unstable head unexpectedly ran native gh")
			}
		})
	}
}

func TestRunGHPRViewRollupPaginates(t *testing.T) {
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	pages := map[string]int{}
	relayTestServer(t, func(request map[string]any) any {
		path := request["path"].(string)
		if strings.HasSuffix(path, "/pulls/1") {
			return map[string]any{"head": map[string]any{"sha": metadataHead}}
		}
		pages[path]++
		page := pages[path]
		count := 100
		if page == 2 {
			count = 1
		}
		items := make([]any, count)
		key := "check_runs"
		for i := range items {
			suite := (page-1)*100 + i + 1
			switch {
			case strings.HasSuffix(path, "/check-runs"):
				items[i] = map[string]any{"id": suite, "name": fmt.Sprintf("job-%d", suite), "status": "completed", "conclusion": "success", "check_suite": map[string]any{"id": suite}, "app": map[string]any{"slug": "github-actions"}}
			case strings.HasSuffix(path, "/status"):
				key = "statuses"
				items[i] = map[string]any{"id": suite, "context": fmt.Sprintf("status-%d", suite), "state": "success"}
			case strings.HasSuffix(path, "/actions/runs"):
				key = "workflow_runs"
				items[i] = map[string]any{"id": suite, "head_sha": metadataHead, "check_suite_id": suite, "name": fmt.Sprintf("workflow-%d", suite)}
			default:
				t.Fatalf("unexpected path %q", path)
			}
		}
		return map[string]any{"total_count": 101, key: items}
	})
	capture := captureRewriteGH(t)
	var out bytes.Buffer
	err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "statusCheckRollup"}, &out, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	var got struct{ StatusCheckRollup []map[string]any }
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.StatusCheckRollup) != 202 || got.StatusCheckRollup[100]["workflowName"] != "workflow-101" || got.StatusCheckRollup[201]["context"] != "status-101" {
		t.Fatalf("incomplete rollup: %s", out.String())
	}
	for path, count := range pages {
		if count != 2 {
			t.Errorf("%s pages = %d", path, count)
		}
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("pagination unexpectedly ran native gh")
	}
}

func TestRunGHPRViewDeletedForkOwner(t *testing.T) {
	for _, deletedOwner := range []bool{false, true} {
		t.Run(fmt.Sprint(deletedOwner), func(t *testing.T) {
			var owner any
			wantOwner := map[string]any{"login": ""}
			if !deletedOwner {
				owner = map[string]any{"node_id": "O_org", "login": "org"}
				wantOwner = map[string]any{"id": "O_org", "login": "org"}
			}
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				switch request["path"] {
				case "/repos/acme/repo/pulls/1":
					writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"repo": nil, "user": owner}, "assignees": []any{}})
				case "/users/org":
					writeCLIEnvelope(t, w, map[string]any{"node_id": "O_org", "id": 14, "login": "org", "name": "Organization", "type": "Organization"})
				default:
					t.Errorf("unexpected request: %#v", request)
					w.WriteHeader(400)
				}
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "headRepository,headRepositoryOwner,assignees"}, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"assignees": []any{}, "headRepository": nil, "headRepositoryOwner": wantOwner}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("deleted fork projection = %s, want %#v", out.String(), want)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("deleted fork unexpectedly ran native gh")
			}
		})
	}
}

func TestRunGHPRViewMetadataFailsClosedDuringHydration(t *testing.T) {
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	for _, scenario := range []string{"identity", "assignees-missing", "assignees-null", "assignees-object", "workflow-bound", "workflow-head", "workflow-missing", "policy-change"} {
		t.Run(scenario, func(t *testing.T) {
			workflowCalls := 0
			setPolicy := func() {}
			policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				path := request["path"].(string)
				switch {
				case strings.HasSuffix(path, "/pulls/1"):
					pr := map[string]any{"head": map[string]any{"sha": metadataHead, "user": map[string]any{"node_id": "U_user", "login": "user"}}}
					if scenario == "assignees-null" {
						pr["assignees"] = nil
					}
					if scenario == "assignees-object" {
						pr["assignees"] = map[string]any{}
					}
					writeCLIEnvelope(t, w, pr)
				case path == "/users/user":
					writeCLIEnvelope(t, w, map[string]any{"node_id": "U_different", "id": 12, "login": "user", "name": "User", "type": "User"})
				case strings.HasSuffix(path, "/check-runs"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 1, "check_runs": []any{map[string]any{"id": 1, "name": "unit", "check_suite": map[string]any{"id": 42}, "app": map[string]any{"slug": "github-actions"}}}})
				case strings.HasSuffix(path, "/status"):
					if scenario == "policy-change" {
						setPolicy()
					}
					writeCLIEnvelope(t, w, map[string]any{"total_count": 0, "statuses": []any{}})
				case strings.HasSuffix(path, "/actions/runs"):
					workflowCalls++
					total := 1
					if scenario == "workflow-bound" {
						total = 1001
					}
					runs := []any{map[string]any{"id": 1, "head_sha": strings.Repeat("f", 40), "check_suite_id": 42, "name": "wrong-head"}}
					if scenario == "workflow-missing" {
						total = 0
						runs = []any{}
					}
					writeCLIEnvelope(t, w, map[string]any{"total_count": total, "workflow_runs": runs})
				default:
					t.Errorf("unexpected path %s", path)
					w.WriteHeader(400)
				}
			})
			setPolicy = func() { policy.Store(strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "head_sha")) }
			capture := captureRewriteGH(t)
			fields := "statusCheckRollup"
			if scenario == "identity" {
				fields = "headRepositoryOwner"
			}
			if strings.HasPrefix(scenario, "assignees-") {
				fields = "assignees"
			}
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", fields}, &out, io.Discard); err == nil {
				t.Fatal("incomplete or forbidden hydration succeeded")
			}
			if out.Len() != 0 {
				t.Fatalf("partial metadata = %q", out.String())
			}
			wantCalls := 1
			if scenario == "policy-change" || scenario == "identity" || strings.HasPrefix(scenario, "assignees-") {
				wantCalls = 0
			}
			if workflowCalls != wantCalls {
				t.Errorf("workflow calls = %d, want %d", workflowCalls, wantCalls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("rejected hydration unexpectedly ran native gh")
			}
		})
	}
}

func TestRunGHPRViewMetadataTypedFallback(t *testing.T) {
	for _, scenario := range []string{"head-moved", "workflow-limit"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			prCalls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				req := decodeCLIRequest(t, w, r)
				path := req["path"].(string)
				switch {
				case strings.HasSuffix(path, "/pulls/1"):
					prCalls++
					sha := metadataHead
					if prCalls == 2 {
						sha = strings.Repeat("f", 40)
					}
					writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": sha}})
				case strings.HasSuffix(path, "/check-runs"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 1, "check_runs": []any{map[string]any{"id": 1, "status": "completed", "conclusion": "success", "app": map[string]any{"slug": "github-actions"}, "check_suite": map[string]any{"id": 42}}}})
				case strings.HasSuffix(path, "/status"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 0, "statuses": []any{}})
				case strings.HasSuffix(path, "/actions/runs"):
					total := 1
					if scenario == "workflow-limit" {
						total = 1001
					}
					writeCLIEnvelope(t, w, map[string]any{"total_count": total, "workflow_runs": []any{map[string]any{"id": 1, "head_sha": metadataHead, "check_suite_id": 42, "name": "CI"}}})
				default:
					t.Errorf("unexpected path %s", path)
					w.WriteHeader(400)
				}
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "statusCheckRollup"}, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			if out.String() != "child stdout\n" {
				t.Fatalf("partial JSON before fallback: %q", out.String())
			}
			got := readRewriteCapture(t, capture)
			want := []string{"pr", "view", "1", "--repo=acme/repo", "--json=statusCheckRollup"}
			if !reflect.DeepEqual(got.Args, want) || got.Env["GH_HOST"] != "github.com" {
				t.Fatalf("fallback=%+v", got)
			}
		})
	}
}

func TestRunGHPRViewMetadataUpstreamFailuresStayClosed(t *testing.T) {
	for _, phase := range []string{"profile", "checks", "statuses", "workflows", "final-head"} {
		for _, upstream := range []int{403, 404, 500} {
			t.Run(fmt.Sprintf("%s/%d", phase, upstream), func(t *testing.T) {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				prCalls := 0
				rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					req := decodeCLIRequest(t, w, r)
					path := req["path"].(string)
					current := ""
					var data any
					switch {
					case strings.HasSuffix(path, "/pulls/1"):
						prCalls++
						if prCalls == 2 {
							current = "final-head"
						}
						data = map[string]any{"head": map[string]any{"sha": metadataHead, "user": map[string]any{"login": "alice", "node_id": "U_alice"}}}
					case path == "/users/alice":
						current = "profile"
						data = map[string]any{"login": "alice", "node_id": "U_alice", "id": 12, "type": "User", "name": nil}
					case strings.HasSuffix(path, "/check-runs"):
						current = "checks"
						data = map[string]any{"total_count": 1, "check_runs": []any{map[string]any{"id": 1, "name": "unit", "status": "completed", "conclusion": "success", "check_suite": map[string]any{"id": 42}, "app": map[string]any{"slug": "github-actions"}}}}
					case strings.HasSuffix(path, "/status"):
						current = "statuses"
						data = map[string]any{"total_count": 0, "statuses": []any{}}
					case strings.HasSuffix(path, "/actions/runs"):
						current = "workflows"
						data = map[string]any{"total_count": 1, "workflow_runs": []any{map[string]any{"id": 1, "check_suite_id": 42, "head_sha": metadataHead, "name": "CI"}}}
					default:
						t.Errorf("unexpected request: %s", path)
						w.WriteHeader(400)
						return
					}
					if current == phase {
						_ = json.NewEncoder(w).Encode(map[string]any{"status": upstream, "body_encoding": "json", "body": map[string]any{"message": "upstream failure"}})
						return
					}
					writeCLIEnvelope(t, w, data)
				})
				capture := captureRewriteGH(t)
				var out bytes.Buffer
				err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "headRepositoryOwner,statusCheckRollup"}, &out, io.Discard)
				if err == nil || out.Len() != 0 {
					t.Fatalf("upstream failure: err=%v out=%q", err, out.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("upstream error unexpectedly delegated")
				}
			})
		}
	}
}
