package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
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
				pr := map[string]any{"headRefOid": metadataHead, "state": "OPEN"}
				if test.shape == publicShapePullRequestMergeSnapshot {
					pr["headRefName"] = "feature"
				}
				body := map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
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

func TestLandingGraphQLFreshObservations(t *testing.T) {
	for _, query := range []struct{ name, text, numberKey string }{
		{"summary", githubLandingQueryPullRequestCISummary, "pr"},
		{"detail", githubLandingQueryPullRequestCIRollup, "pr"},
		{"merge-snapshot", githubLandingQueryPullRequestMergeSnapshot, "number"},
	} {
		for _, cache := range []string{"default", "explicit-cache"} {
			t.Run(query.name+"/"+cache, func(t *testing.T) {
				var calls atomic.Int64
				newHead := strings.Repeat("f", 40)
				rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					request := decodeCLIRequest(t, w, r)
					headers, _ := request["headers"].(map[string]any)
					call := calls.Add(1)
					head := metadataHead
					// The cached first observation survives an upstream head change;
					// only revalidation can confirm the new head on the second read.
					if call > 1 && headers["cache-control"] == "max-age=0" {
						head = newHead
					}
					if cache == "explicit-cache" && headers["cache-control"] != "max-age=30" {
						t.Errorf("explicit cache age changed: %v", headers)
					}
					pr := map[string]any{"headRefOid": head}
					if query.numberKey == "number" {
						pr["headRefName"] = "feature"
					}
					writeCLIEnvelope(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}})
				})
				t.Setenv("OCTOPOOL_FRESH", "")
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				args := landingGraphQLArgs(query.text, query.numberKey)
				if cache == "explicit-cache" {
					args = append(args, "-H", "Cache-Control: max-age=30")
				}
				for observation := 0; observation < 2; observation++ {
					var out, stderr bytes.Buffer
					if err := runGH(t.Context(), args, &out, &stderr); err != nil || stderr.Len() != 0 {
						t.Fatalf("observation=%d err=%v stderr=%q", observation, err, stderr.String())
					}
					var response struct {
						Data struct {
							Repository struct {
								PullRequest struct{ HeadRefOid string }
							}
						}
					}
					if err := json.Unmarshal(out.Bytes(), &response); err != nil {
						t.Fatal(err)
					}
					want := metadataHead
					if observation == 1 && cache == "default" {
						want = newHead
					}
					if response.Data.Repository.PullRequest.HeadRefOid != want {
						t.Fatalf("observation=%d head=%s want=%s", observation, response.Data.Repository.PullRequest.HeadRefOid, want)
					}
				}
				if calls.Load() != 2 {
					t.Fatalf("observations made %d relay requests, want 2", calls.Load())
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

func TestLandingGraphQLLocalPolicy(t *testing.T) {
	for _, test := range []struct{ name, query, numberKey, pattern string }{
		{"summary-field", githubLandingQueryPullRequestCISummary, "pr", "headRefOid"},
		{"merge-ref", githubLandingQueryPullRequestMergeSnapshot, "number", "refs/heads/main"},
		{"endpoint", githubLandingQueryPullRequestCISummary, "pr", "^/graphql$"},
	} {
		for _, stage := range []string{"initial", "refresh", "native"} {
			t.Run(test.name+"/"+stage, func(t *testing.T) {
				local := filepath.Join(t.TempDir(), "local-policy.json")
				policyBody, err := json.Marshal(map[string]any{
					"schema_version": 1,
					"rules":          []stringRewriteRule{{Pattern: test.pattern, Replacement: "public"}},
				})
				if err != nil {
					t.Fatal(err)
				}
				dataCalls := 0
				policies := rewriteTestServerPolicySequence(t, func(call int64) (string, int) {
					if stage == "refresh" && call == 2 {
						// The initial CLI check passed; the per-request admission must
						// reload and enforce the newly added local rule as well.
						if err := os.WriteFile(local, policyBody, 0600); err != nil {
							t.Error(err)
							return "", http.StatusInternalServerError
						}
					}
					return rewriteEmptyTestPolicy, http.StatusOK
				}, func(w http.ResponseWriter, r *http.Request) {
					dataCalls++
					writeCLIEnvelope(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"state": "OPEN"}}}})
				})
				initial := policyBody
				if stage == "refresh" {
					initial = []byte(`{"schema_version":1,"rules":[]}`)
				}
				if err := os.WriteFile(local, initial, 0600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", local)
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				capture := captureRewriteGH(t)
				args := landingGraphQLArgs(test.query, test.numberKey)
				if stage == "native" {
					args = append(args, "--include")
				}
				var out, stderr bytes.Buffer
				err = runGH(t.Context(), args, &out, &stderr)
				if stage == "native" && test.name != "endpoint" {
					if err != nil || dataCalls != 0 || out.String() != "child stdout\n" {
						t.Fatalf("native control failed: err=%v data=%d out=%q", err, dataCalls, out.String())
					}
					child := readRewriteCapture(t, capture)
					if strings.Contains(strings.Join(child.Args, " "), test.pattern) || !strings.Contains(strings.Join(child.Args, " "), "public") {
						t.Fatalf("native query lost local rewriting: %q", child.Args)
					}
					return
				}
				if !errors.Is(err, errRewriteBlocked) || dataCalls != 0 || out.Len() != 0 || stderr.Len() != 0 {
					t.Fatalf("local %s policy was bypassed: err=%v data=%d out=%q stderr=%q", stage, err, dataCalls, out.String(), stderr.String())
				}
				if stage != "native" {
					wantPolicies := int64(1)
					if stage == "refresh" {
						wantPolicies = 2
					}
					if policies.Load() != wantPolicies {
						t.Fatalf("policy admission count=%d, want %d", policies.Load(), wantPolicies)
					}
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("local policy denial dispatched native gh")
				}
			})
		}
	}
}

func TestLandingGraphQLResponseBoundaries(t *testing.T) {
	for _, test := range []struct {
		name, encoding      string
		status              int
		body                any
		noFallback, native  bool
		wantOutput, wantErr string
	}{
		{"old-worker-no-fallback", "json", 200, map[string]any{"number": 7}, true, false, "", "unsupported_graphql_landing_shape"},
		{"old-worker-fallback", "json", 200, map[string]any{"number": 7}, false, true, "child stdout\n", ""},
		{"graphql-error", "json", 200, map[string]any{"errors": []any{map[string]any{"message": "synthetic failure"}}}, false, false, "{\"errors\":[{\"message\":\"synthetic failure\"}]}\n", "GraphQL request failed"},
		{"service-error", "json", 503, map[string]any{"message": "unavailable"}, false, false, `{"message":"unavailable"}`, "github returned status 503"},
		{"unauthorized", "json", 401, map[string]any{"message": "Bad credentials"}, false, false, `{"message":"Bad credentials"}`, "github returned status 401"},
		{"forbidden", "json", 403, map[string]any{"message": "Forbidden"}, false, false, `{"message":"Forbidden"}`, "github returned status 403"},
		{"non-json-error", "text", 503, "<html>unavailable</html>", false, false, "<html>unavailable</html>", "github returned status 503"},
		{"malformed-json-error", "text", 502, "{\"message\":", false, false, "{\"message\":", "github returned status 502"},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				body, err := json.Marshal(test.body)
				if err != nil {
					t.Error(err)
					return
				}
				if err := json.NewEncoder(w).Encode(relayEnvelope{Status: test.status, BodyEncoding: test.encoding, Body: body}); err != nil {
					t.Error(err)
				}
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if test.noFallback {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			capture := captureRewriteGH(t)
			args := landingGraphQLArgs(githubLandingQueryPullRequestCISummary, "pr")
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			if calls != 1 || out.String() != test.wantOutput || test.wantErr == "" && err != nil || test.wantErr != "" && (err == nil || !strings.Contains(err.Error(), test.wantErr)) {
				t.Fatalf("calls=%d err=%v output=%q stderr=%q", calls, err, out.String(), stderr.String())
			}
			if test.native {
				if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) {
					t.Fatalf("old-worker fallback changed native arguments: %q", got.Args)
				}
			} else if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("error response dispatched native gh")
			}
			if test.status >= 400 && (isLocalFallback(err) || stderr.Len() != 0) {
				t.Fatalf("upstream failure became a native handoff: err=%v stderr=%q", err, stderr.String())
			}
		})
	}
}

func TestLandingGraphQLMergeProjectionFallback(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(map[bool]string{false: "native", true: "no-fallback"}[blocked], func(t *testing.T) {
			relayTestServer(t, func(map[string]any) any {
				return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"headRefOid": metadataHead}}}}
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if blocked {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			capture := captureRewriteGH(t)
			args := landingGraphQLArgs(githubLandingQueryPullRequestMergeSnapshot, "number")
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			if blocked {
				if err == nil || out.Len() != 0 {
					t.Fatalf("old projection must fail before output: err=%v out=%q", err, out.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("disabled fallback dispatched native gh")
				}
				return
			}
			if err != nil || out.String() != "child stdout\n" {
				t.Fatalf("fallback must emit only native output: err=%v out=%q", err, out.String())
			}
			if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) {
				t.Fatalf("native query changed: %q", got.Args)
			}
		})
	}
}
