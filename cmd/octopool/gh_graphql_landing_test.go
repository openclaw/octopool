package main

import (
	"bytes"
	"errors"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func landingGraphQLArgs(query, numberKey string) []string {
	return []string{"api", "graphql", "--hostname", "github.com", "-f", "query=" + query, "-f", "owner=acme", "-f", "name=repo", "-F", numberKey + "=7"}
}

func TestLandingGraphQLRelay(t *testing.T) {
	for _, policy := range []string{rewriteEmptyTestPolicy, rewriteActiveTestPolicy} {
		for _, test := range []struct {
			name, query, shape, numberKey, cursor string
		}{
			{"summary", githubLandingQueryPullRequestCISummary, publicShapePullRequestCISummary, "pr", ""},
			{"detail", githubLandingQueryPullRequestCIRollup, publicShapePullRequestCIRollup, "pr", ""},
			{"detail-page", githubLandingQueryPullRequestCIRollup, publicShapePullRequestCIRollup, "pr", "synthetic-cursor="},
			{"merge-snapshot", githubLandingQueryPullRequestMergeSnapshot, publicShapePullRequestMergeSnapshot, "number", ""},
		} {
			t.Run(policy+"/"+test.name, func(t *testing.T) {
				calls := 0
				body := map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"headRefOid": metadataHead, "state": "OPEN"}}}}
				rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					request := decodeCLIRequest(t, w, r)
					headers, _ := request["headers"].(map[string]any)
					if request["method"] != "GET" || request["path"] != "/repos/acme/repo/pulls/7" || headers["x-octopool-public-shape"] != test.shape || headers["cache-control"] != "max-age=0" {
						t.Errorf("request=%#v", request)
					}
					query, _ := request["query"].(map[string]any)
					if test.cursor == "" && len(query) != 0 || test.cursor != "" && !reflect.DeepEqual(query, map[string]any{"cursor": test.cursor}) {
						t.Errorf("query=%#v", query)
					}
					writeCLIEnvelope(t, w, body)
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				capture := captureRewriteGH(t)
				query := strings.ReplaceAll(test.query, "{", "{\n  ")
				args := append(landingGraphQLArgs(query, test.numberKey), "-H", "Cache-Control: max-age=0")
				if test.cursor != "" {
					args = append(args, "-f", "cursor="+test.cursor)
				}
				var out, stderr bytes.Buffer
				if err := runGH(t.Context(), args, &out, &stderr); err != nil || calls != 1 || !strings.Contains(out.String(), metadataHead) || stderr.Len() != 0 {
					t.Fatalf("err=%v calls=%d out=%q stderr=%q", err, calls, out.String(), stderr.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("known public query dispatched native gh")
				}
			})
		}
	}
}

func TestLandingGraphQLNativeBoundaries(t *testing.T) {
	for _, test := range []struct {
		name  string
		query string
		extra []string
	}{
		{"viewer", `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){viewerMergeBodyText(mergeType:SQUASH)}}}`, nil},
		{"mutation", strings.Replace(githubLandingQueryPullRequestCISummary, "query(", "mutation(", 1), nil},
		{"unknown-field", strings.Replace(githubLandingQueryPullRequestCISummary, "headRefOid", "headRefOid body", 1), nil},
		{"split-name", strings.Replace(githubLandingQueryPullRequestCISummary, "headRefOid", "headRef Oid", 1), nil},
		{"extra-variable", githubLandingQueryPullRequestCISummary, []string{"-f", "extra=value"}},
		{"summary-cursor", githubLandingQueryPullRequestCISummary, []string{"-f", "cursor=synthetic"}},
		{"duplicate-variable", githubLandingQueryPullRequestCISummary, []string{"-F", "pr=8"}},
		{"enterprise", githubLandingQueryPullRequestCISummary, []string{"--hostname=enterprise.example"}},
		{"conditional", githubLandingQueryPullRequestCISummary, []string{"-H", `If-None-Match: "fixture"`}},
		{"paginate", githubLandingQueryPullRequestCISummary, []string{"--paginate"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
			capture := captureRewriteGH(t)
			args := append(landingGraphQLArgs(test.query, "pr"), test.extra...)
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) {
				t.Fatalf("native arguments changed: %q", got.Args)
			}
		})
	}
}

func TestLandingGraphQLAmbientEnterpriseStaysNative(t *testing.T) {
	rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	t.Setenv("GH_HOST", "enterprise.example")
	capture := captureRewriteGH(t)
	hosted := landingGraphQLArgs(githubLandingQueryPullRequestCISummary, "pr")
	args := append(append([]string{}, hosted[:2]...), hosted[4:]...)
	var out, stderr bytes.Buffer
	if err := runGH(t.Context(), args, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) || got.Env["GH_HOST"] != "enterprise.example" {
		t.Fatalf("native host changed: args=%q host=%q", got.Args, got.Env["GH_HOST"])
	}
}

func TestLandingGraphQLPolicyDenial(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capture := captureRewriteGH(t)
	args := append(landingGraphQLArgs(githubLandingQueryPullRequestCIRollup, "pr"), "-f", "cursor=internal-model")
	var out, stderr bytes.Buffer
	if err := runGH(t.Context(), args, &out, &stderr); !errors.Is(err, errRewriteBlocked) {
		t.Fatalf("expected structural policy denial, got %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("policy denial dispatched native gh")
	}
}

func TestLandingGraphQLResponseBoundaries(t *testing.T) {
	for _, test := range []struct {
		name string
		body any
	}{
		{"old-worker", map[string]any{"number": 7}},
		{"graphql-error", map[string]any{"errors": []any{map[string]any{"message": "synthetic failure"}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			relayTestServer(t, func(map[string]any) any { return test.body })
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if test.name == "old-worker" {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), landingGraphQLArgs(githubLandingQueryPullRequestCISummary, "pr"), &out, &stderr)
			if err == nil || test.name == "old-worker" && out.Len() != 0 || test.name == "graphql-error" && !strings.Contains(out.String(), "synthetic failure") {
				t.Fatalf("err=%v output=%q", err, out.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("error response dispatched native gh")
			}
		})
	}
}
