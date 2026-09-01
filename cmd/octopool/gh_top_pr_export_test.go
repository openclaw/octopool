package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func prDetailSelections() []struct {
	name  string
	flags []string
	jq    bool
} {
	return []struct {
		name  string
		flags []string
		jq    bool
	}{
		{"commits", []string{"--json", "commits"}, false},
		{"comments", []string{"--json", "comments"}, false},
		{"reviews", []string{"--json", "reviews"}, false},
		{"author_before_commits", []string{"--json", "number,author,commits"}, false},
		{"files_before_comments", []string{"--json=files,comments,title"}, false},
		{"rollup_before_reviews", []string{"--json", "statusCheckRollup,reviews,number"}, false},
		{"reordered_repeated", []string{"--json", `"reviews",author`, "--json=files,commits,comments,reviews,author,statusCheckRollup", "--json="}, false},
		{"jq_native_owns_filter", []string{"--json", "author,commits,files", "--jq", "(", "-q", `"LOCAL JQ MUST NOT RUN"`}, true},
		{"jq_short_equals_literal", []string{"--json=comments,number", "-q="}, true},
	}
}

func TestPRDetailExportTypedBeforeClient(t *testing.T) {
	for _, field := range []string{"commits", "comments", "reviews"} {
		t.Run(field, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_TOKEN", "")
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{"view", "7", "-R", "acme/repo", "--json", field}, &out)
			var fallback localFallbackError
			if result.action != ghFail || !errors.As(result.err, &fallback) || fallback.Reason != "unsupported_pr_detail_export" || fallback.Relay != nil || out.Len() != 0 {
				t.Fatalf("detail must remain accepted and fail typed before relay client/auth: action=%v err=%v out=%q", result.action, result.err, out.String())
			}
		})
	}
}

func TestRunGHPRDetailExportNativeBoundary(t *testing.T) {
	for _, active := range []bool{false, true} {
		for _, noFallback := range []bool{false, true} {
			for _, test := range prDetailSelections() {
				t.Run(fmt.Sprintf("active=%v/no-fallback=%v/%s", active, noFallback, test.name), func(t *testing.T) {
					if test.jq && !jqAvailable() {
						t.Skip("existing jq required for relay eligibility")
					}
					policy := rewriteEmptyTestPolicy
					if active {
						policy = rewriteActiveTestPolicy
					}
					var paths []string
					checks := newPRChecksFixture()
					_, policies := rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
						req := decodeCLIRequest(t, w, r)
						paths = append(paths, req["path"].(string))
						writeCLIEnvelope(t, w, prDetailExportResponse(t, checks, req))
					})
					t.Setenv("OCTOPOOL_NO_FALLBACK", "")
					if noFallback {
						t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
					}
					t.Setenv("GH_HOST", "github.com")
					t.Setenv("GH_REPO", "acme/inherited")
					capture := captureRewriteGH(t)
					t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", capture+".calls")
					args := append([]string{"pr", "view", "7", "-Racme/repo"}, test.flags...)
					original := append([]string(nil), args...)
					var stdout, stderr bytes.Buffer
					err := runGH(t.Context(), args, &stdout, &stderr)
					calls, callErr := os.ReadFile(capture + ".calls")
					t.Logf("boundary policies=%d data=%d paths=%v child=%d err=%v stdout=%q stderr=%q", policies.Load(), len(paths), paths, strings.Count(string(calls), "child\n"), err, stdout.String(), stderr.String())
					if !reflect.DeepEqual(args, original) || os.Getenv("GH_HOST") != "github.com" || os.Getenv("GH_REPO") != "acme/inherited" {
						t.Error("caller argv/environment mutated")
					}
					if len(paths) != 0 {
						t.Errorf("detail preflight must do zero relay DATA, including earlier hydration: %v", paths)
					}
					if noFallback {
						var fallback localFallbackError
						if !errors.As(err, &fallback) || fallback.Reason != "unsupported_pr_detail_export" || fallback.Relay != nil {
							t.Errorf("NO_FALLBACK must return exact local typed projection refusal, got %T: %v", err, err)
						}
						if policies.Load() != 1 || stdout.Len() != 0 || stderr.Len() != 0 || !os.IsNotExist(callErr) {
							t.Error("NO_FALLBACK must stop after initial policy, without child/local JSON/jq/output")
						}
						if _, err := os.Stat(capture); !os.IsNotExist(err) {
							t.Error("NO_FALLBACK ran native child")
						}
						return
					}
					if err != nil || stdout.String() != "child stdout\n" || stderr.String() != "octopool: octopool requested local gh fallback: unsupported_pr_detail_export; falling back to real gh\nchild stderr\n" || string(calls) != "child\n" || callErr != nil || policies.Load() != 2 {
						t.Error("typed handoff must precede exactly one synthetic native child, which owns all stdout/jq; only initial and final policy reads")
					}
					if _, statErr := os.Stat(capture); statErr != nil {
						t.Errorf("missing synthetic native capture: %v", statErr)
						return
					}
					got := readRewriteCapture(t, capture)
					want := original
					wantRepo := "acme/inherited"
					if active {
						want = append([]string{"pr", "view", "7", "--repo=acme/repo"}, test.flags...)
						wantRepo = ""
					}
					if !reflect.DeepEqual(got.Args, want) || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != wantRepo || got.Stdin != "" || len(got.Files) != 0 {
						t.Errorf("native argv/pins/streams: got=%+v want argv=%q repo=%q", got, want, wantRepo)
					}
				})
			}
		}
	}
}

func TestRunGHPRDetailExportPolicyBoundaries(t *testing.T) {
	for _, field := range []string{"commits", "comments", "reviews"} {
		for _, stage := range []string{"initial-denial", "final-denial", "final-unavailable"} {
			t.Run(field+"/"+stage, func(t *testing.T) {
				var data atomic.Int64
				policies := rewriteTestServerPolicySequence(t, func(ordinal int64) (string, int) {
					if ordinal == 1 && stage != "initial-denial" {
						return rewriteActiveTestPolicy, http.StatusOK
					}
					if ordinal > 2 {
						t.Error("unexpected extra policy read")
					}
					if stage == "final-unavailable" {
						return "", http.StatusServiceUnavailable
					}
					return strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "acme/repo"), http.StatusOK
				}, func(w http.ResponseWriter, r *http.Request) {
					data.Add(1)
					t.Error("policy boundary must prevent data")
					w.WriteHeader(http.StatusBadRequest)
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				capture := captureRewriteGH(t)
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), []string{"pr", "view", "7", "-R", "acme/repo", "--json", "author,files,statusCheckRollup," + field}, &out, &stderr)
				wantErr := errRewriteBlocked
				if stage == "final-unavailable" {
					wantErr = errRewritePolicy
				}
				wantPolicies, wantStderr := int64(2), "octopool: octopool requested local gh fallback: unsupported_pr_detail_export; falling back to real gh\n"
				if stage == "initial-denial" {
					wantPolicies, wantStderr = 1, ""
				}
				t.Logf("policies=%d data=%d err=%v stdout=%q stderr=%q", policies.Load(), data.Load(), err, out.String(), stderr.String())
				if !errors.Is(err, wantErr) || isLocalFallback(err) || policies.Load() != wantPolicies || data.Load() != 0 || out.Len() != 0 || stderr.String() != wantStderr {
					t.Error("initial policy owns denial; final policy must freshly block the typed native handoff")
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Error("policy refusal ran native child")
				}
			})
		}
	}
}

func TestRunGHPRDetailExportDirectDelegationControls(t *testing.T) {
	for _, test := range []struct {
		name, selector string
		flags          []string
		active, noJQ   bool
	}{
		{"unknown_field_before", "7", []string{"--json=unknown,commits", "--json=reviews"}, true, false},
		{"unknown_field_after", "7", []string{"--json=comments", "--json=unknown"}, true, false},
		{"unknown_flag_before", "7", []string{"--future", "--json=commits"}, true, false},
		{"unknown_flag_after", "7", []string{"--json=reviews", "--future"}, true, false},
		{"unknown_flag_owns_detail_text", "7", []string{"--future", "--json=comments", "--json=number"}, true, false},
		{"zero_json", "7", []string{"--json="}, true, false},
		{"missing_jq", "7", []string{"--json=commits", "--jq=.commits"}, true, true},
		{"unmodeled_selector_empty_policy", "branch-name", []string{"--json=reviews"}, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := rewriteEmptyTestPolicy
			if test.active {
				policy = rewriteActiveTestPolicy
			}
			var data atomic.Int64
			_, policies := rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
				data.Add(1)
				t.Error("direct delegation requested data")
				w.WriteHeader(http.StatusBadRequest)
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "")
			capture := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", capture+".calls")
			if test.noJQ {
				t.Setenv("PATH", t.TempDir())
			}
			args := append([]string{"pr", "view", test.selector, "-R", "acme/repo"}, test.flags...)
			original := append([]string(nil), args...)
			var out, stderr bytes.Buffer
			result := handleGHPR(t.Context(), args[1:], &out)
			if result.action != ghDelegate || result.err != nil || out.Len() != 0 || data.Load() != 0 || policies.Load() != 0 {
				t.Fatalf("unmodeled shape must stay direct delegation: %+v out=%q", result, out.String())
			}
			err := runGH(t.Context(), args, &out, &stderr)
			calls, callErr := os.ReadFile(capture + ".calls")
			if err != nil || out.String() != "child stdout\n" || stderr.String() != "child stderr\n" || policies.Load() != 2 || data.Load() != 0 || string(calls) != "child\n" || callErr != nil || !reflect.DeepEqual(args, original) {
				t.Fatalf("direct protected delegation must ignore typed-only NO_FALLBACK: err=%v out=%q stderr=%q policies=%d data=%d calls=%q", err, out.String(), stderr.String(), policies.Load(), data.Load(), calls)
			}
			want := original
			if test.active {
				repoArgs := []string{"pr", "view", test.selector, "--repo=acme/repo"}
				if strings.HasPrefix(test.name, "unknown_flag") {
					repoArgs = []string{"pr", "view", test.selector, "-R", "github.com/acme/repo"}
				}
				want = append(repoArgs, test.flags...)
			}
			got := readRewriteCapture(t, capture)
			if !reflect.DeepEqual(got.Args, want) || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" || got.Stdin != "" {
				t.Fatalf("direct argv/pin mismatch: got=%+v want=%q", got, want)
			}
		})
	}
}

func TestRunGHPRDetailExportRemainingProjectionControl(t *testing.T) {
	checks := newPRChecksFixture()
	var paths []string
	relayTestServer(t, func(req map[string]any) any {
		paths = append(paths, req["path"].(string))
		return prDetailExportResponse(t, checks, req)
	})
	capture := captureRewriteGH(t)
	var out bytes.Buffer
	err := runGH(t.Context(), []string{"pr", "view", "7", "-R", "acme/repo", "--json=number,title,author,files,statusCheckRollup"}, &out, io.Discard)
	var got map[string]any
	if err != nil || json.Unmarshal(out.Bytes(), &got) != nil {
		t.Fatalf("legitimate shared fixture must fully hydrate: err=%v out=%q", err, out.String())
	}
	if len(got) != 5 || got["number"] != float64(7) || got["title"] != "Detail fixture" || !reflect.DeepEqual(got["author"], map[string]any{"id": "U_alice", "login": "alice", "name": "Alice", "is_bot": false}) || !reflect.DeepEqual(got["files"], []any{map[string]any{"path": "proof.go", "changeType": "ADDED", "additions": float64(1), "deletions": float64(0)}}) {
		t.Errorf("remaining projection: %s", out.String())
	}
	rollup, ok := got["statusCheckRollup"].([]any)
	if !ok || len(rollup) != 1 || rollup[0].(map[string]any)["workflowName"] != "CI" || len(paths) != 8 || paths[len(paths)-1] != "/repos/acme/repo/pulls/7" {
		t.Errorf("rollup/head acquisition: paths=%v output=%s", paths, out.String())
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Error("remaining projection delegated")
	}
}

func TestRunGHPRViewAuthorNativeShape(t *testing.T) {
	for _, test := range []struct {
		name        string
		author      any
		profileName any
		want        map[string]any
	}{
		{"user", map[string]any{"id": 12, "node_id": "U_alice", "login": "alice", "type": "User", "url": "https://example.test/alice"}, "Alice", map[string]any{"id": "U_alice", "login": "alice", "name": "Alice", "is_bot": false}},
		{"null-name", map[string]any{"id": 12, "node_id": "U_alice", "login": "alice", "type": "User"}, nil, map[string]any{"id": "U_alice", "login": "alice", "name": "", "is_bot": false}},
		{"bot", map[string]any{"id": 13, "node_id": "B_clockwork", "login": "clockwork[bot]", "type": "Bot"}, nil, map[string]any{"login": "app/clockwork", "is_bot": true}},
		{"deleted", nil, nil, map[string]any{"login": "app/", "is_bot": true}},
	} {
		for _, repeated := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/repeated=%v", test.name, repeated), func(t *testing.T) {
				profileCalls := 0
				rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					req := decodeCLIRequest(t, w, r)
					switch req["path"] {
					case "/repos/acme/repo/pulls/1":
						if headers, _ := req["headers"].(map[string]any); headers["x-octopool-public-shape"] != nil {
							t.Error("author needs full REST identity")
						}
						writeCLIEnvelope(t, w, map[string]any{"user": test.author, "number": 1})
					case "/users/alice":
						profileCalls++
						writeCLIEnvelope(t, w, map[string]any{"id": 12, "node_id": "U_alice", "login": "alice", "type": "User", "name": test.profileName})
					default:
						t.Errorf("unexpected request: %v", req["path"])
						w.WriteHeader(400)
					}
				})
				capture := captureRewriteGH(t)
				fields := "author"
				if repeated {
					fields = "number,author,author"
				}
				var out bytes.Buffer
				if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", fields}, &out, io.Discard); err != nil {
					t.Fatal(err)
				}
				var got map[string]any
				if err := json.Unmarshal(out.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got["author"], test.want) {
					t.Fatalf("author=%#v want=%#v", got["author"], test.want)
				}
				wantCalls := 0
				if test.want["is_bot"] == false {
					wantCalls = 1
				}
				if profileCalls != wantCalls {
					t.Fatalf("profile calls=%d want=%d", profileCalls, wantCalls)
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("unexpected native fallback")
				}
			})
		}
	}
}

func TestRunGHPRViewRepeatedOptionHydration(t *testing.T) {
	for _, test := range []struct {
		name  string
		flags []string
	}{
		{"control_one_occurrence", []string{"--json", "number,author,author"}},
		{"regression_across_occurrences", []string{"--json", "number,author", "--json", "author"}},
		{"regression_quoted_occurrence", []string{"--json", `"number",author`, "--json", "author"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var paths []string
			relayTestServer(t, func(req map[string]any) any {
				paths = append(paths, req["path"].(string))
				switch req["path"] {
				case "/repos/acme/repo/pulls/7":
					return map[string]any{"number": 7, "user": map[string]any{"node_id": "U_alice", "login": "alice", "type": "User"}}
				case "/users/alice":
					return map[string]any{"id": 12, "node_id": "U_alice", "login": "alice", "name": "Alice", "type": "User"}
				default:
					t.Errorf("unexpected hydration path %v", req["path"])
					return nil
				}
			})
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), append([]string{"pr", "view", "7", "-R", "acme/repo"}, test.flags...), &out)
			if result.action != ghComplete || result.err != nil || !reflect.DeepEqual(paths, []string{"/repos/acme/repo/pulls/7", "/users/alice"}) || !strings.Contains(out.String(), `"number":7`) || !strings.Contains(out.String(), `"name":"Alice"`) {
				t.Fatalf("action=%v err=%v paths=%v output=%q", result.action, result.err, paths, out.String())
			}
		})
	}
}

func TestRunGHPRViewLabelsNativeShape(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(fmt.Sprint(empty), func(t *testing.T) {
			labels := []any{}
			want := []any{}
			if !empty {
				// Keep upstream order, including node IDs that would sort differently.
				for i, description := range []any{nil, "", "Description"} {
					id, name := fmt.Sprintf("LA_%d", 3-i), fmt.Sprintf("label-%d", i)
					labels = append(labels, map[string]any{"id": i + 1, "node_id": id, "name": name, "description": description, "color": "abc123", "url": "https://example.test/label", "default": false})
					text, _ := description.(string)
					want = append(want, map[string]any{"id": id, "name": name, "description": text, "color": "abc123"})
				}
			}
			relayTestServer(t, func(req map[string]any) any {
				if req["path"] != "/repos/acme/repo/pulls/1" {
					t.Fatalf("unexpected request: %v", req["path"])
				}
				return map[string]any{"labels": labels}
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "labels,labels"}, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got["labels"], want) {
				t.Fatalf("labels=%#v want=%#v", got["labels"], want)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unexpected native fallback")
			}
		})
	}
}

func TestRunGHPRViewFilesNativeShape(t *testing.T) {
	for _, test := range []struct{ rest, native string }{
		{"added", "ADDED"}, {"removed", "DELETED"}, {"modified", "MODIFIED"},
		{"renamed", "RENAMED"}, {"copied", "COPIED"}, {"changed", "CHANGED"},
	} {
		t.Run(test.rest, func(t *testing.T) {
			calls := 0
			relayTestServer(t, func(req map[string]any) any {
				if strings.HasSuffix(req["path"].(string), "/files") {
					calls++
					return []any{map[string]any{"filename": "new.txt", "previous_filename": "old.txt", "additions": 2, "deletions": 1, "status": test.rest}}
				}
				return map[string]any{"head": map[string]any{"sha": metadataHead}}
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "files,files"}, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := []any{map[string]any{"path": "new.txt", "additions": float64(2), "deletions": float64(1), "changeType": test.native}}
			if !reflect.DeepEqual(got["files"], want) {
				t.Fatalf("files=%#v want=%#v", got["files"], want)
			}
			if calls != 1 {
				t.Fatalf("file calls=%d", calls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unexpected native fallback")
			}
		})
	}
}

func TestRunGHPRViewFilesUnsupportedStatus(t *testing.T) {
	// REST admits unchanged, but GraphQL PatchStatus has no equivalent.
	for _, status := range []any{nil, "", "unchanged", "future-status", "MODIFIED", 1} {
		for _, noFallback := range []string{"", "1"} {
			t.Run(fmt.Sprintf("%v/no-fallback=%s", status, noFallback), func(t *testing.T) {
				t.Setenv("OCTOPOOL_NO_FALLBACK", noFallback)
				rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					req := decodeCLIRequest(t, w, r)
					if strings.HasSuffix(req["path"].(string), "/files") {
						file := map[string]any{"filename": "unknown.txt", "additions": 0, "deletions": 0}
						if status != nil {
							file["status"] = status
						}
						writeCLIEnvelope(t, w, []any{map[string]any{"filename": "valid.txt", "status": "added", "additions": 1, "deletions": 0}, file})
						return
					}
					writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": metadataHead}})
				})
				capture := captureRewriteGH(t)
				var out bytes.Buffer
				err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "files"}, &out, io.Discard)
				if noFallback == "1" {
					if err == nil || out.Len() != 0 {
						t.Fatalf("partial JSON: err=%v out=%q", err, out.String())
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("native fallback ran")
					}
				} else {
					if err != nil || out.String() != "child stdout\n" {
						t.Fatalf("partial JSON before fallback: err=%v out=%q", err, out.String())
					}
					got := readRewriteCapture(t, capture)
					if got.Env["GH_HOST"] != "github.com" {
						t.Fatalf("unpinned fallback: %+v", got)
					}
				}
			})
		}
	}
}

func TestRunGHPRViewAuthorRechecksPolicy(t *testing.T) {
	profileCalls := 0
	updatePolicy := func() {}
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		req := decodeCLIRequest(t, w, r)
		if req["path"] == "/repos/acme/repo/pulls/1" {
			updatePolicy()
			writeCLIEnvelope(t, w, map[string]any{"user": map[string]any{"login": "alice", "node_id": "U_alice", "id": 12, "type": "User"}})
			return
		}
		profileCalls++
		t.Errorf("forbidden profile request: %v", req["path"])
		w.WriteHeader(400)
	})
	updatePolicy = func() { policy.Store(strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "/users/")) }
	capture := captureRewriteGH(t)
	var out bytes.Buffer
	err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "author"}, &out, io.Discard)
	if err == nil || out.Len() != 0 || profileCalls != 0 {
		t.Fatalf("err=%v output=%q profile calls=%d", err, out.String(), profileCalls)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("policy denial delegated")
	}
}

func TestRunGHPRViewExportIncompleteShapes(t *testing.T) {
	for _, test := range []struct {
		name, field string
		body        map[string]any
	}{
		{"missing-author", "author", map[string]any{}},
		{"unknown-author", "author", map[string]any{"user": map[string]any{"login": "other", "node_id": "M_other", "type": "Mannequin"}}},
		{"unknown-bot-login", "author", map[string]any{"user": map[string]any{"login": "unmapped-bot", "type": "Bot"}}},
		{"missing-label-id", "labels", map[string]any{"labels": []any{map[string]any{"name": "bug", "description": "", "color": "abc123"}}}},
		{"null-labels", "labels", map[string]any{"labels": nil}},
		{"invalid-description", "labels", map[string]any{"labels": []any{map[string]any{"node_id": "LA_bug", "name": "bug", "description": 12, "color": "abc123"}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			relayTestServer(t, func(req map[string]any) any {
				if req["path"] != "/repos/acme/repo/pulls/1" {
					t.Fatalf("unexpected request: %v", req["path"])
				}
				return test.body
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", test.field}, &out, io.Discard)
			if err == nil || out.Len() != 0 {
				t.Fatalf("err=%v output=%q", err, out.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unexpected fallback")
			}
		})
	}
}
