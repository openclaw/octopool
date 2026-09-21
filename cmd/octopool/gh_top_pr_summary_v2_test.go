package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const summaryV2Fields = "state,headRefOid,mergeCommit,isDraft,author,url"

func TestPRViewSummaryV2Headers(t *testing.T) {
	for _, fields := range []string{summaryV2Fields, summaryV2Fields + ",merged,headRepositoryOwner", summaryV2Fields + ",files,statusCheckRollup"} {
		got := prViewHeaders(ghTopOptions{json: strings.Split(fields, ",")})
		if got["x-octopool-public-shape"] != "pr-summary-v2" {
			t.Fatalf("fields=%s headers=%v", fields, got)
		}
		t.Logf("--json %s -> %v", fields, got)
	}
	for _, field := range []string{"mergeable", "mergeStateStatus", "reviewDecision", "body", "labels", "comments", "reviews", "commits", "headRepository", "mergedBy"} {
		if got := prViewHeaders(ghTopOptions{json: strings.Split(summaryV2Fields+","+field, ",")}); got != nil {
			t.Fatalf("%s unexpectedly enabled the page shape: %v", field, got)
		}
	}
	t.Log("adding mergeable -> no public-shape header")
}

func TestRunGHPRViewSummaryV2Projection(t *testing.T) {
	for _, test := range []struct {
		name, state, login, actorType string
		draft, merged                 bool
	}{
		{"open", "OPEN", "contributor", "User", false, false},
		{"draft", "DRAFT", "contributor", "User", true, false},
		{"merged", "MERGED", "contributor", "User", false, true},
		{"bot", "OPEN", "dependabot[bot]", "Bot", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_FRESH", "")
			prCalls, profileCalls := 0, 0
			relayTestServer(t, func(request map[string]any) any {
				path := request["path"].(string)
				if path == "/repos/acme/repo/pulls/1" {
					prCalls++
					headers, _ := request["headers"].(map[string]any)
					if headers["x-octopool-public-shape"] != "pr-summary-v2" || headers["cache-control"] != "max-age=0" {
						t.Fatalf("headers=%#v", headers)
					}
					pr := map[string]any{
						"state": test.state, "draft": test.draft, "merged": test.merged,
						"user": map[string]any{"login": test.login}, "html_url": "https://github.com/acme/repo/pull/1",
						"head": map[string]any{"sha": metadataHead, "user": map[string]any{"login": "contributor"}},
					}
					if test.merged {
						pr["merge_commit_sha"] = metadataHead
					}
					return pr
				}
				profileCalls++
				if path == "/users/contributor" {
					return map[string]any{"id": 13, "node_id": "U_contributor", "login": "contributor", "type": "User", "name": "Contributor"}
				}
				if path == "/users/dependabot%5Bbot%5D" {
					return map[string]any{"id": 14, "node_id": "B_dependabot", "login": test.login, "type": test.actorType, "name": nil}
				}
				t.Fatalf("unexpected path %s", path)
				return nil
			})
			var out bytes.Buffer
			fields := summaryV2Fields + ",merged,headRepositoryOwner"
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", fields}, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			var mergeCommit any
			state := "OPEN"
			if test.merged {
				mergeCommit = map[string]any{"oid": metadataHead}
				state = "MERGED"
			}
			author := map[string]any{"id": "U_contributor", "is_bot": false, "login": "contributor", "name": "Contributor"}
			wantProfiles := 1
			if test.actorType == "Bot" {
				author = map[string]any{"is_bot": true, "login": "app/dependabot"}
				wantProfiles = 2
			}
			want := map[string]any{
				"state": state, "headRefOid": metadataHead, "mergeCommit": mergeCommit, "isDraft": test.draft,
				"author": author, "url": "https://github.com/acme/repo/pull/1", "merged": test.merged,
				"headRepositoryOwner": map[string]any{"id": "U_contributor", "login": "contributor", "name": "Contributor"},
			}
			if !reflect.DeepEqual(got, want) || prCalls != 1 || profileCalls != wantProfiles {
				t.Fatalf("got=%s want=%#v PR calls=%d profiles=%d", out.String(), want, prCalls, profileCalls)
			}
			t.Logf("v2 + max-age=0: %s", out.String())
		})
	}
}

func TestRunGHPRViewSummaryV2ExactRetry(t *testing.T) {
	for _, missing := range []string{"draft", "user", "head-owner"} {
		t.Run(missing, func(t *testing.T) {
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_FRESH", "")
			calls := 0
			var out bytes.Buffer
			relayTestServer(t, func(request map[string]any) any {
				calls++
				if request["path"] != "/repos/acme/repo/pulls/1" || calls > 2 || out.Len() != 0 {
					t.Fatalf("retry must precede hydration/output: calls=%d request=%#v output=%q", calls, request, out.String())
				}
				headers, _ := request["headers"].(map[string]any)
				if headers["cache-control"] != "max-age=0" {
					t.Fatalf("retry lost freshness: %#v", headers)
				}
				if calls == 1 {
					if headers["x-octopool-public-shape"] != "pr-summary-v2" {
						t.Fatalf("initial headers=%#v", headers)
					}
					pr := map[string]any{"state": "CLOSED", "merged": false, "draft": false,
						"user": map[string]any{"login": "contributor"}, "head": map[string]any{"sha": "old-head", "user": map[string]any{"login": "contributor"}},
						"html_url": "https://github.com/acme/repo/pull/1"}
					if missing == "head-owner" {
						delete(pr["head"].(map[string]any), "user")
					} else {
						delete(pr, missing)
					}
					return pr
				}
				if _, hasShape := headers["x-octopool-public-shape"]; hasShape {
					t.Fatalf("exact retry retained shape: %#v", headers)
				}
				return map[string]any{"state": "closed", "merged": false, "draft": true, "user": nil,
					"head": map[string]any{"sha": metadataHead, "user": nil}, "merge_commit_sha": "synthetic-test-merge"}
			})
			fields := summaryV2Fields + ",headRepositoryOwner"
			if err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", fields}, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"state": "CLOSED", "isDraft": true, "mergeCommit": nil, "headRefOid": metadataHead,
				"author": map[string]any{"is_bot": true, "login": "app/"}, "headRepositoryOwner": map[string]any{"login": ""}}
			if calls != 2 || !reflect.DeepEqual(got, want) {
				t.Fatalf("calls=%d output=%s want=%#v", calls, out.String(), want)
			}
			t.Logf("v2 missing %s -> exact relay retry, max-age=0, NO_FALLBACK=1: %s", missing, out.String())
		})
	}
}

func TestRunGHPRViewSummaryV2RetryFailure(t *testing.T) {
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	calls := 0
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			writeCLIEnvelope(t, w, map[string]any{"state": "CLOSED"})
		} else {
			writeCLIEnvelope(t, w, "invalid PR body")
		}
	})
	var out bytes.Buffer
	err := runGH(t.Context(), []string{"pr", "view", "1", "-R", "acme/repo", "--json", "isDraft"}, &out, io.Discard)
	if err == nil || calls != 2 || out.Len() != 0 {
		t.Fatalf("err=%v calls=%d output=%q", err, calls, out.String())
	}
}

func TestPRLoginOnlyHydrationIdentityChecks(t *testing.T) {
	for _, test := range []struct {
		name    string
		source  map[string]any
		profile map[string]any
	}{
		{"mismatched-node", map[string]any{"login": "alice", "node_id": "U_other"}, nil},
		{"empty-source-node", map[string]any{"login": "alice", "node_id": ""}, nil},
		{"wrong-login", map[string]any{"login": "alice"}, map[string]any{"login": "other"}},
		{"missing-profile-node", map[string]any{"login": "alice"}, map[string]any{"node_id": nil}},
		{"missing-profile-type", map[string]any{"login": "alice"}, map[string]any{"type": nil}},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := map[string]any{"id": float64(1), "node_id": "U_alice", "login": "alice", "type": "User", "name": "Alice"}
			for key, value := range test.profile {
				profile[key] = value
			}
			_, err := relayPRUser(t.Context(), ghRelayClient{}, test.source, map[string]map[string]any{"alice": profile})
			if err == nil {
				t.Fatal("accepted incomplete or mismatched profile")
			}
		})
	}
}
