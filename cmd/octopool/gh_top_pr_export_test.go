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
