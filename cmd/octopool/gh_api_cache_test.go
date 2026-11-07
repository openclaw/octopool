package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestRunGHAPICacheFlag(t *testing.T) {
	for policyName, policy := range map[string]string{"empty-policy": rewriteEmptyTestPolicy, "active-policy": rewriteActiveTestPolicy} {
		for _, test := range []struct {
			name, path, maxAge string
			flags              []string
			native             bool
		}{
			{name: "seconds", flags: []string{"--cache", "60s"}, maxAge: "60"},
			{name: "minutes-equals", flags: []string{"--cache=5m"}, maxAge: "300"},
			{name: "fractional-seconds", flags: []string{"--cache=1500ms"}, maxAge: "1"},
			{name: "subsecond", flags: []string{"--cache=500ms"}, maxAge: "0"},
			{name: "explicit-header", flags: []string{"--cache", "60s", "-H", "Cache-Control: max-age=0"}, maxAge: "0"},
			{name: "explicit-header-first", flags: []string{"--header=Cache-Control: max-age=0", "--cache=5m"}, maxAge: "0"},
			{name: "explicit-host", flags: []string{"--hostname", "github.com", "--cache", "60s"}, maxAge: "60"},
			{name: "invalid", flags: []string{"--cache", "bogus"}, native: true},
			{name: "zero", flags: []string{"--cache", "0s"}, native: true},
			{name: "negative", flags: []string{"--cache=-1s"}, native: true},
			{name: "overflow", flags: []string{"--cache=999999999999h"}, native: true},
			{name: "post", flags: []string{"-X", "POST", "--cache", "60s"}, native: true},
			{name: "rate-limit", path: "rate_limit", flags: []string{"--cache=60s"}, native: true},
			{name: "absolute-rate-limit", path: "/rate_limit", flags: []string{"--cache", "60s"}, native: true},
		} {
			t.Run(policyName+"/"+test.name, func(t *testing.T) {
				path := test.path
				if path == "" {
					path = "repos/o/r/actions/runs/1/jobs"
				}
				calls := 0
				rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					request := decodeCLIRequest(t, w, r)
					headers, _ := request["headers"].(map[string]any)
					if test.native || request["method"] != "GET" || request["path"] != "/"+path || headers["cache-control"] != "max-age="+test.maxAge {
						t.Errorf("unexpected relay request: %#v", request)
					}
					writeCLIEnvelope(t, w, map[string]any{"jobs": []any{}})
				})
				t.Setenv("OCTOPOOL_FRESH", "")
				capture := captureRewriteGH(t)
				t.Setenv("OCTOPOOL_TEST_GRAPHQL_PROBE", capture+".probe")
				args := append([]string{"api", path}, test.flags...)
				var out, stderr bytes.Buffer
				if err := runGH(t.Context(), args, &out, &stderr); err != nil {
					t.Fatal(err)
				}
				if test.native {
					if calls != 0 {
						t.Fatalf("native request made %d relay calls", calls)
					}
					if test.path == "rate_limit" {
						if _, err := os.Stat(capture + ".probe"); err != nil {
							t.Fatalf("native rate-limit probe did not run: %v", err)
						}
					} else {
						got := readRewriteCapture(t, capture).Args
						wantOpts, wantErr := parseRewriteAPI(args[1:])
						gotOpts, gotErr := parseRewriteAPI(got[1:])
						if wantErr != nil || gotErr != nil || gotOpts.endpoint != wantOpts.endpoint || gotOpts.cache != wantOpts.cache || gotOpts.method != wantOpts.method {
							t.Fatalf("native args = %q, want equivalent to %q (parse errors: %v, %v)", got, args, gotErr, wantErr)
						}
					}
				} else {
					if calls != 1 || out.String() != "{\"jobs\":[]}\n" || stderr.Len() != 0 {
						t.Fatalf("relay calls=%d stdout=%q stderr=%q", calls, out.String(), stderr.String())
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("cacheable read dispatched native gh")
					}
				}
			})
		}
	}
}

func TestParseRewriteAPICacheFlag(t *testing.T) {
	for _, flags := range [][]string{{"--cache", "60s"}, {"--cache=60s"}} {
		opts, err := parseRewriteAPI(append([]string{"repos/o/r/actions/runs/1/jobs"}, flags...))
		if err != nil || opts.cache != "60s" || !reflect.DeepEqual(opts.output, []string{"--cache=60s"}) {
			t.Fatalf("cache flag not retained: opts=%#v err=%v", opts, err)
		}
	}
	for _, flags := range [][]string{{"--cache", "60s", "--cache=5m"}, {"--cache=60s", "--cache", "60s"}, {"--cache"}} {
		if _, err := parseRewriteAPI(append([]string{"repos/o/r/actions/runs/1/jobs"}, flags...)); !errors.Is(err, errRewriteBlocked) {
			t.Fatalf("duplicate or missing cache flag value should be blocked: flags=%q err=%v", flags, err)
		}
	}
}

func TestRunGHAPICacheFlagPolicyGuard(t *testing.T) {
	policy := strings.Replace(rewriteActiveTestPolicy, "internal-model", "max-age=60", 1)
	calls := 0
	rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
		calls++
	})
	capture := captureRewriteGH(t)
	var out, stderr bytes.Buffer
	err := runGH(t.Context(), []string{"api", "repos/o/r/actions/runs/1/jobs", "--cache=60s"}, &out, &stderr)
	if !errors.Is(err, errRewriteBlocked) || calls != 0 || out.Len() != 0 {
		t.Fatalf("generated cache header escaped policy: err=%v calls=%d stdout=%q", err, calls, out.String())
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("policy denial dispatched native gh")
	}
}

func TestRunGHAPICacheFlagGraphQL(t *testing.T) {
	for policyName, policy := range map[string]string{"empty-policy": rewriteEmptyTestPolicy, "active-policy": rewriteActiveTestPolicy} {
		for _, test := range []struct {
			name, method, path, cache string
			args                      []string
		}{
			{"repository", "POST", "/graphql", "max-age=60", append(repositoryReadArgs(repositoryReadQuery), "--cache", "5m")},
			{"landing", "GET", "/repos/acme/repo/pulls/7", "max-age=300", append(landingGraphQLArgs(githubLandingQueryPullRequestCISummary, "pr"), "--cache=5m")},
		} {
			t.Run(policyName+"/"+test.name, func(t *testing.T) {
				calls := 0
				rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					request := decodeCLIRequest(t, w, r)
					headers, _ := request["headers"].(map[string]any)
					if request["method"] != test.method || request["path"] != test.path || headers["cache-control"] != test.cache {
						t.Errorf("unexpected GraphQL relay request: %#v", request)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{
						"status": 200, "body": map[string]any{"data": map[string]any{"repository": map[string]any{"name": "repo"}}},
						"body_encoding": "json", "relay": map[string]string{"route_kind": "graphql_read"},
					})
				})
				t.Setenv("GH_HOST", "github.com")
				t.Setenv("OCTOPOOL_GRAPHQL_RELAY", "")
				t.Setenv("OCTOPOOL_FRESH", "")
				capture := captureRewriteGH(t)
				var out, stderr bytes.Buffer
				if err := runGH(t.Context(), test.args, &out, &stderr); err != nil || calls != 1 || out.Len() == 0 || stderr.Len() != 0 {
					t.Fatalf("err=%v relay calls=%d stdout=%q stderr=%q", err, calls, out.String(), stderr.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("GraphQL read dispatched native gh")
				}
			})
		}
	}
}
