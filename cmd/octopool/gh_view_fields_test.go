package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func viewFieldFixture(t *testing.T, name, kind string) []byte {
	t.Helper()
	extension := ".txt"
	if kind == "graphql" {
		extension = ".json"
	}
	raw, err := os.ReadFile(filepath.Join("testdata", "view-fields", name+"."+kind+extension))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPRAutoMergeNativeFixtures(t *testing.T) {
	for _, name := range []string{"auto-user", "auto-bot", "auto-deleted", "auto-null-text", "auto-disabled"} {
		for _, jq := range []string{"", ".autoMergeRequest"} {
			t.Run(name+jq, func(t *testing.T) {
				if jq != "" && !jqAvailable() {
					t.Skip("jq unavailable")
				}
				var pr map[string]json.RawMessage
				if err := json.Unmarshal(viewFieldFixture(t, name, "graphql"), &pr); err != nil {
					t.Fatal(err)
				}
				value, err := mapPRAutoMerge(pr["autoMergeRequest"])
				if err != nil {
					t.Fatal(err)
				}
				raw, err := marshalGHFields(map[string]any{"autoMergeRequest": value}, []string{"autoMergeRequest"}, nil)
				if err != nil {
					t.Fatal(err)
				}
				var out bytes.Buffer
				if err := writeGHViewJSON(t.Context(), &out, raw, jq); err != nil {
					t.Fatal(err)
				}
				kind := "native"
				if jq != "" {
					kind = "jq"
				}
				if want := viewFieldFixture(t, name, kind); !bytes.Equal(out.Bytes(), want) {
					t.Fatalf("got %s want %s", out.Bytes(), want)
				}
			})
		}
	}
}

func TestIssueReasonNativeFixtures(t *testing.T) {
	for _, name := range []string{"issue-open", "issue-completed", "issue-not-planned", "issue-reopened"} {
		for _, jq := range []string{"", "{stateReason,assignees}"} {
			t.Run(name+jq, func(t *testing.T) {
				if jq != "" && !jqAvailable() {
					t.Skip("jq unavailable")
				}
				var gql map[string]any
				if err := json.Unmarshal(viewFieldFixture(t, name, "graphql"), &gql); err != nil {
					t.Fatal(err)
				}
				reason := gql["stateReason"]
				if reason != nil {
					reason = strings.ToLower(reason.(string))
				}
				calls := 0
				relayTestServer(t, func(request map[string]any) any {
					calls++
					if request["path"] == "/users/alice" {
						return prActorProfile("U_alice", "Alice")
					}
					headers, _ := request["headers"].(map[string]any)
					if request["path"] != "/repos/openclaw/octopool/issues/7" || headers["cache-control"] != "max-age=0" || headers["x-octopool-public-shape"] != nil {
						t.Errorf("request=%v", request)
					}
					return map[string]any{"state": strings.ToLower(gql["state"].(string)), "state_reason": reason, "title": gql["title"], "assignees": []any{map[string]any{"login": "alice", "node_id": "U_alice"}}}
				})
				args := []string{"view", "7", "-R", "openclaw/octopool", "--json", "stateReason,assignees,state,title"}
				if jq != "" {
					args = append(args, "--jq", jq)
				}
				var out bytes.Buffer
				result := handleGHIssue(t.Context(), args, &out)
				kind := "native"
				if jq != "" {
					kind = "jq"
				}
				if result.err != nil || result.action != ghComplete || calls != 2 || !bytes.Equal(out.Bytes(), viewFieldFixture(t, name, kind)) {
					t.Fatalf("err=%v calls=%d got=%s want=%s", result.err, calls, out.Bytes(), viewFieldFixture(t, name, kind))
				}
			})
		}
	}
}

func TestIssueReasonUnsupported(t *testing.T) {
	for _, issue := range []map[string]any{{}, {"state_reason": 42}, {"state_reason": "future"}, {"state_reason": false}, {"state_reason": map[string]any{}}} {
		if err := normalizeIssueStateReason(issue); !isLocalFallback(err) {
			t.Fatalf("issue=%v err=%v", issue, err)
		}
	}
	emptyRewriteTestServer(t)
	var out bytes.Buffer
	result := handleGHIssue(t.Context(), []string{"list", "-R", "openclaw/octopool", "--json", "stateReason"}, &out)
	if result.action != ghDelegate {
		t.Fatalf("list action=%v", result.action)
	}
}

func TestPRAutoMergeLiveHydration(t *testing.T) {
	for _, changedHead := range []bool{false, true} {
		t.Run(map[bool]string{false: "stable", true: "moving"}[changedHead], func(t *testing.T) {
			var pr map[string]any
			if err := json.Unmarshal(viewFieldFixture(t, "auto-user", "graphql"), &pr); err != nil {
				t.Fatal(err)
			}
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				headers, _ := request["headers"].(map[string]any)
				if headers["cache-control"] != "max-age=0" {
					t.Errorf("not live: %v", request)
				}
				if calls == 2 {
					if headers["x-octopool-public-shape"] != publicShapePullRequestAutoMerge {
						t.Errorf("shape: %v", request)
					}
					return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
				}
				head := prMergeableTestHead
				if calls == 3 && changedHead {
					head = strings.Repeat("a", 40)
				}
				return map[string]any{"head": map[string]any{"sha": head}, "auto_merge": map[string]any{"merge_method": "squash"}}
			})
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{"view", "7", "-R", "openclaw/octopool", "--json", "autoMergeRequest,autoMergeRequest"}, &out)
			if changedHead {
				if !isLocalFallback(result.err) || out.Len() != 0 {
					t.Fatalf("err=%v out=%s", result.err, out.String())
				}
			} else if result.err != nil || !bytes.Equal(out.Bytes(), viewFieldFixture(t, "auto-user", "native")) {
				t.Fatalf("err=%v out=%s", result.err, out.String())
			}
			if calls != 3 {
				t.Errorf("calls=%d", calls)
			}
		})
	}
}

func TestPRAutoMergeIncomplete(t *testing.T) {
	for _, raw := range []string{`{}`, `{"mergeMethod":"SQUASH"}`, `false`, `"bad"`, ``} {
		if _, err := mapPRAutoMerge(json.RawMessage(raw)); !isLocalFallback(err) {
			t.Fatalf("raw=%s err=%v", raw, err)
		}
	}
}

func TestJournalNativeIssueFieldNames(t *testing.T) {
	for _, field := range strings.Fields("stateReason blockedBy blocking closedByPullRequestsReferences isPinned issueType projectCards subIssues subIssuesSummary") {
		if got := journalJSONFields(field + ",title"); strings.Contains(got, ":field") {
			t.Errorf("%s = %s", field, got)
		}
	}
}

func TestPRAutoMergeRejectsIncompleteProjection(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(map[string]any) any
	}{
		{"old worker", func(pr map[string]any) any { return map[string]any{"auto_merge": nil} }},
		{"graphql errors", func(pr map[string]any) any {
			return map[string]any{"errors": []any{map[string]any{"message": "unavailable"}}, "data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
		}},
		{"wrong head", func(pr map[string]any) any {
			pr["headRefOid"] = strings.Repeat("a", 40)
			return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
		}},
		{"missing auto merge", func(pr map[string]any) any {
			delete(pr, "autoMergeRequest")
			return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var pr map[string]any
			if err := json.Unmarshal(viewFieldFixture(t, "auto-user", "graphql"), &pr); err != nil {
				t.Fatal(err)
			}
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				if calls == 1 {
					return map[string]any{"head": map[string]any{"sha": prMergeableTestHead}, "auto_merge": map[string]any{"merge_method": "squash"}}
				}
				return test.edit(pr)
			})
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{"view", "7", "-R", "openclaw/octopool", "--json", "autoMergeRequest"}, &out)
			if !isLocalFallback(result.err) || out.Len() != 0 || calls != 2 {
				t.Fatalf("err=%v calls=%d out=%s", result.err, calls, out.String())
			}
		})
	}
}

func TestGHViewNativeNumericJQ(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq unavailable")
	}
	var out bytes.Buffer
	err := writeGHViewJSON(t.Context(), &out, []byte(`{}`), `1/3,1.0,1e20,-0.5,true,null,"a\nb"`)
	want, readErr := os.ReadFile(filepath.Join("testdata", "view-fields", "numbers.jq.txt"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if err != nil || !bytes.Equal(out.Bytes(), want) {
		t.Fatalf("err=%v got=%q want=%q", err, out.String(), want)
	}
}

func TestPRMergeStateNativeBundle(t *testing.T) {
	for _, jq := range []string{"", ".mergeStateStatus"} {
		t.Run(jq, func(t *testing.T) {
			if jq != "" && !jqAvailable() {
				t.Skip("jq unavailable")
			}
			var pr map[string]any
			if err := json.Unmarshal(viewFieldFixture(t, "merge-state", "graphql"), &pr); err != nil {
				t.Fatal(err)
			}
			gqlCalls := 0
			relayTestServer(t, func(request map[string]any) any {
				if request["path"] == "/users/alice" {
					return prActorProfile("U_alice", "Alice")
				}
				headers, _ := request["headers"].(map[string]any)
				if headers["cache-control"] != "max-age=0" {
					t.Errorf("not live: %v", request)
				}
				if headers["x-octopool-public-shape"] == publicShapePullRequestMergeSnapshot {
					gqlCalls++
					return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
				}
				return map[string]any{"head": map[string]any{"sha": prMergeableTestHead}, "additions": 4, "deletions": 2, "user": map[string]any{"login": "alice", "type": "User", "node_id": "U_alice"}, "draft": true, "maintainer_can_modify": false, "state": "open", "number": 7, "title": "Synthetic <PR>", "mergeable_state": "unstable"}
			})
			args := []string{"view", "7", "-R", "openclaw/octopool", "--json", "additions,author,deletions,isDraft,maintainerCanModify,mergeStateStatus,number,state,title"}
			if jq != "" {
				args = append(args, "--jq", jq)
			}
			var out bytes.Buffer
			result := handleGHPR(t.Context(), args, &out)
			kind := "native"
			if jq != "" {
				kind = "jq"
			}
			if result.err != nil || gqlCalls != 1 || !bytes.Equal(out.Bytes(), viewFieldFixture(t, "merge-state", kind)) {
				t.Fatalf("err=%v got=%s want=%s", result.err, out.Bytes(), viewFieldFixture(t, "merge-state", kind))
			}
		})
	}
}

func TestPRMergeStateRefusesUnprovenSnapshot(t *testing.T) {
	for _, failure := range []string{"missing", "null", "unknown", "wrong-head", "moving-head"} {
		t.Run(failure, func(t *testing.T) {
			reads := 0
			relayTestServer(t, func(request map[string]any) any {
				headers, _ := request["headers"].(map[string]any)
				if headers["x-octopool-public-shape"] == publicShapePullRequestMergeSnapshot {
					pr := map[string]any{"id": "PR_synthetic", "headRefOid": prMergeableTestHead, "mergeStateStatus": "CLEAN"}
					switch failure {
					case "missing":
						delete(pr, "mergeStateStatus")
					case "null":
						pr["mergeStateStatus"] = nil
					case "unknown":
						pr["mergeStateStatus"] = "FUTURE"
					case "wrong-head":
						pr["headRefOid"] = strings.Repeat("a", 40)
					}
					return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
				}
				reads++
				head := prMergeableTestHead
				if failure == "moving-head" && reads > 1 {
					head = strings.Repeat("a", 40)
				}
				return map[string]any{"head": map[string]any{"sha": head}}
			})
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{"view", "7", "-R", "openclaw/octopool", "--json", "mergeStateStatus"}, &out)
			if !isLocalFallback(result.err) || out.Len() != 0 {
				t.Fatalf("err=%v out=%s", result.err, out.String())
			}
		})
	}
}
