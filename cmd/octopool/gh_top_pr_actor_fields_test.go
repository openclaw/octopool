package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestRunGHPRViewMaintainerCanModify(t *testing.T) {
	for _, value := range []bool{true, false} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			t.Setenv("OCTOPOOL_FRESH", "")
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				checkPRMergeableRequest(t, request)
				return map[string]any{"maintainer_can_modify": value}
			})
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{
				"view", "7", "--repo", "openclaw/octopool", "--json", "maintainerCanModify",
			}, &out)
			want := fmt.Sprintf("{\"maintainerCanModify\":%t}\n", value)
			if result.err != nil || result.action != ghComplete || calls != 1 || out.String() != want {
				t.Fatalf("action=%v err=%v calls=%d output=%q, want %q", result.action, result.err, calls, out.String(), want)
			}
		})
	}
}

// Native gh v2.101.0 queries mergedBy exactly like author, but stores *Author:
// null stays null; a User exports id/name, and a Bot exports only is_bot/login.
func TestRunGHPRViewMergedByNativeShape(t *testing.T) {
	for _, test := range []struct {
		name, want string
		actor      any
		profile    map[string]any
	}{
		{"unmerged", "null", nil, nil},
		{"user", `{"id":"U_alice","is_bot":false,"login":"alice","name":"Alice"}`, map[string]any{"id": 12, "node_id": "U_alice", "login": "alice", "type": "User"}, prActorProfile("U_alice", "Alice")},
		{"null name", `{"id":"U_alice","is_bot":false,"login":"alice","name":""}`, map[string]any{"node_id": "U_alice", "login": "alice", "type": "User"}, prActorProfile("U_alice", nil)},
		{"hydrated type", `{"id":"U_alice","is_bot":false,"login":"alice","name":"Alice"}`, map[string]any{"node_id": "U_alice", "login": "alice"}, prActorProfile("U_alice", "Alice")},
		{"bot", `{"is_bot":true,"login":"app/clockwork"}`, map[string]any{"id": 13, "node_id": "B_clockwork", "login": "clockwork[bot]", "type": "Bot"}, nil},
	} {
		for _, fields := range []string{"mergedBy", "author,mergedBy,mergedBy", "mergedBy,author"} {
			t.Run(test.name+"/"+fields, func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "")
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				prCalls, profileCalls := 0, 0
				rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					request := decodeCLIRequest(t, w, r)
					switch request["path"] {
					case "/repos/openclaw/octopool/pulls/7":
						prCalls++
						checkPRMergeableRequest(t, request)
						writeCLIEnvelope(t, w, map[string]any{"merged_by": test.actor, "user": test.actor})
					case "/users/alice":
						profileCalls++
						headers, _ := request["headers"].(map[string]any)
						if headers["cache-control"] != "max-age=3600" {
							t.Errorf("identity metadata should remain cache-eligible: %v", headers)
						}
						writeCLIEnvelope(t, w, test.profile)
					default:
						t.Errorf("unexpected request: %v", request["path"])
						w.WriteHeader(http.StatusBadRequest)
					}
				})
				var out bytes.Buffer
				err := runGH(t.Context(), []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", fields}, &out, io.Discard)
				want := `{"mergedBy":` + test.want + "}\n"
				if strings.Contains(fields, "author") {
					author := test.want
					if test.actor == nil {
						author = `{"is_bot":true,"login":"app/"}`
					}
					want = `{"author":` + author + `,"mergedBy":` + test.want + "}\n"
				}
				wantProfiles := 0
				if test.profile != nil {
					wantProfiles = 1
				}
				if err != nil || prCalls != 1 || profileCalls != wantProfiles || out.String() != want {
					t.Fatalf("err=%v PR calls=%d profiles=%d output=%q, want profiles=%d output=%q", err, prCalls, profileCalls, out.String(), wantProfiles, want)
				}
			})
		}
	}
}

func prActorProfile(nodeID string, name any) map[string]any {
	return map[string]any{"id": 12, "node_id": nodeID, "login": "alice", "type": "User", "name": name}
}

func TestRunGHPRViewActorFieldsProjection(t *testing.T) {
	for _, test := range []struct{ fields, jq, want string }{
		{"headRefOid,state,mergeable,autoMergeRequest,maintainerCanModify,mergedBy", "", `{"autoMergeRequest":null,"headRefOid":"` + prMergeableTestHead + `","maintainerCanModify":true,"mergeable":"MERGEABLE","mergedBy":null,"state":"OPEN"}` + "\n"},
		{"mergedBy,maintainerCanModify,mergedBy", "", "{\"maintainerCanModify\":true,\"mergedBy\":null}\n"},
		{"maintainerCanModify,mergedBy", `(.maintainerCanModify == true) and has("mergedBy") and (.mergedBy == null)`, "true\n"},
	} {
		t.Run(test.fields+"/"+test.jq, func(t *testing.T) {
			if test.jq != "" && !jqAvailable() {
				t.Skip("jq is not installed")
			}
			t.Setenv("OCTOPOOL_FRESH", "")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				checkPRMergeableRequest(t, request)
				pr := prMergeableFixture(true, true)
				pr["auto_merge"], pr["maintainer_can_modify"], pr["merged_by"] = nil, true, nil
				return pr
			})
			args := []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", test.fields}
			if test.jq != "" {
				args = append(args, "--jq", test.jq)
			}
			var out bytes.Buffer
			err := runGH(t.Context(), args, &out, io.Discard)
			if err != nil || calls != 1 || out.String() != test.want {
				t.Fatalf("err=%v calls=%d output=%q, want %q", err, calls, out.String(), test.want)
			}
		})
	}
}

func TestRunGHPRViewActorFieldsFallback(t *testing.T) {
	for _, test := range []struct {
		name, fields string
		pr, profile  map[string]any
	}{
		{"missing permission", "maintainerCanModify", map[string]any{}, nil},
		{"null permission", "maintainerCanModify", map[string]any{"maintainer_can_modify": nil}, nil},
		{"string permission", "maintainerCanModify", map[string]any{"maintainer_can_modify": "false"}, nil},
		{"numeric permission", "maintainerCanModify", map[string]any{"maintainer_can_modify": 1}, nil},
		{"object permission", "maintainerCanModify", map[string]any{"maintainer_can_modify": map[string]any{}}, nil},
		{"missing merger", "mergedBy", map[string]any{}, nil},
		{"boolean merger", "mergedBy", map[string]any{"merged_by": false}, nil},
		{"string merger", "mergedBy", map[string]any{"merged_by": "alice"}, nil},
		{"empty merger", "mergedBy", map[string]any{"merged_by": map[string]any{}}, nil},
		{"unknown merger type", "mergedBy", map[string]any{"merged_by": map[string]any{"login": "alice", "type": "Mannequin"}}, nil},
		{"invalid bot login", "mergedBy", map[string]any{"merged_by": map[string]any{"login": "clockwork", "type": "Bot"}}, nil},
		{"empty source node ID", "mergedBy", map[string]any{"merged_by": map[string]any{"login": "alice", "node_id": "", "type": "User"}}, nil},
		{"mismatched identity", "mergedBy", map[string]any{"merged_by": map[string]any{"login": "alice", "node_id": "U_different", "type": "User"}}, prActorProfile("U_alice", "Alice")},
		{"incomplete profile", "mergedBy", map[string]any{"merged_by": map[string]any{"login": "alice", "node_id": "U_alice", "type": "User"}}, map[string]any{"id": 12, "node_id": "U_alice", "login": "alice", "type": "User"}},
		{"invalid profile name", "mergedBy", map[string]any{"merged_by": map[string]any{"login": "alice", "node_id": "U_alice", "type": "User"}}, prActorProfile("U_alice", 12)},
		{"cached page projection", "headRefOid,maintainerCanModify,mergedBy", map[string]any{"head": map[string]any{"sha": prMergeableTestHead}}, nil},
		{"GraphQL keys are not REST evidence", "maintainerCanModify,mergedBy", map[string]any{"maintainerCanModify": true, "mergedBy": nil}, nil},
		{"invalid merger after valid permission", "maintainerCanModify,mergedBy", map[string]any{"maintainer_can_modify": true, "merged_by": false}, nil},
	} {
		for _, noFallback := range []string{"", "1"} {
			t.Run(test.name+"/no-fallback="+noFallback, func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "")
				t.Setenv("OCTOPOOL_NO_FALLBACK", noFallback)
				t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
				prCalls, profileCalls := 0, 0
				relayTestServer(t, func(request map[string]any) any {
					switch request["path"] {
					case "/repos/openclaw/octopool/pulls/7":
						prCalls++
						checkPRMergeableRequest(t, request)
						return relayTestResponse{Body: test.pr, Relay: relayMeta{Cache: "hit", RouteKind: "pr_view"}}
					case "/users/alice":
						profileCalls++
						return test.profile
					default:
						t.Errorf("unexpected request: %v", request["path"])
						return nil
					}
				})
				args := []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", test.fields}
				var out bytes.Buffer
				err := runGH(t.Context(), args, &out, io.Discard)
				want := ""
				if noFallback == "1" {
					if !isLocalFallback(err) {
						t.Fatalf("expected typed local fallback, got %v", err)
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					want = "real-gh:" + strings.Join(args, " ") + "\n"
				}
				wantProfiles := 0
				if test.profile != nil {
					wantProfiles = 1
				}
				if prCalls != 1 || profileCalls != wantProfiles || out.String() != want {
					t.Fatalf("PR calls=%d profiles=%d output=%q, want profiles=%d output=%q", prCalls, profileCalls, out.String(), wantProfiles, want)
				}
			})
		}
	}
}

func TestRunGHPRViewMergedByLookupErrorsRemainTerminal(t *testing.T) {
	for _, failure := range []string{"upstream", "policy"} {
		t.Run(failure, func(t *testing.T) {
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			profileCalls := 0
			updatePolicy := func() {}
			policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				if request["path"] == "/repos/openclaw/octopool/pulls/7" {
					checkPRMergeableRequest(t, request)
					if failure == "policy" {
						updatePolicy()
					}
					writeCLIEnvelope(t, w, map[string]any{"merged_by": map[string]any{"login": "alice", "node_id": "U_alice", "type": "User"}})
					return
				}
				profileCalls++
				if request["path"] != "/users/alice" || failure == "policy" {
					t.Errorf("unexpected profile request: %v", request["path"])
				}
				http.Error(w, "synthetic upstream failure", http.StatusBadRequest)
			})
			updatePolicy = func() { policy.Store(strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "/users/")) }
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", "mergedBy"}, &out, io.Discard)
			wantProfiles := 1
			if failure == "policy" {
				wantProfiles = 0
				if !errors.Is(err, errRewriteBlocked) {
					t.Errorf("expected policy denial, got %v", err)
				}
			}
			if err == nil || isLocalFallback(err) || out.Len() != 0 || profileCalls != wantProfiles {
				t.Fatalf("err=%v output=%q profile calls=%d, want %d", err, out.String(), profileCalls, wantProfiles)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("lookup failure delegated to native gh")
			}
		})
	}
}

func TestRunGHPRActorFieldsListAndSearchDelegate(t *testing.T) {
	for _, fields := range []string{"maintainerCanModify", "mergedBy", "state,maintainerCanModify,mergedBy"} {
		for _, prefix := range [][]string{{"pr", "list"}, {"search", "prs"}} {
			t.Run(strings.Join(prefix, " ")+"/"+fields, func(t *testing.T) {
				emptyRewriteTestServer(t)
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
				args := append(append([]string{}, prefix...), "--repo", "openclaw/octopool", "--json", fields)
				var out bytes.Buffer
				result := runGHTopLevel(t.Context(), args, &out)
				if result.err != nil || result.action != ghDelegate || out.Len() != 0 {
					t.Fatalf("action=%v err=%v output=%q", result.action, result.err, out.String())
				}
				err := runGH(t.Context(), args, &out, io.Discard)
				want := "real-gh:" + strings.Join(args, " ") + "\n"
				if err != nil || out.String() != want {
					t.Fatalf("err=%v output=%q, want %q", err, out.String(), want)
				}
			})
		}
	}
}
