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

func TestRunGHPRViewMergeCommit(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	for _, test := range []struct {
		name   string
		pr     map[string]any
		fields string
		jq     string
		want   string
	}{
		{"merged", map[string]any{"merged": true, "merge_commit_sha": sha}, "mergeCommit", "", `{"mergeCommit":{"oid":"` + sha + `"}}` + "\n"},
		{"open test merge", map[string]any{"state": "open", "merged": false, "merge_commit_sha": sha}, "mergeCommit", "", "{\"mergeCommit\":null}\n"},
		{"closed unmerged", map[string]any{"state": "closed", "merged": false, "merge_commit_sha": sha}, "mergeCommit,state", "", "{\"mergeCommit\":null,\"state\":\"CLOSED\"}\n"},
		{"conflicting", map[string]any{"merged": false, "merge_commit_sha": nil}, "mergeCommit", "", "{\"mergeCommit\":null}\n"},
		{"jq", map[string]any{"merged": true, "merge_commit_sha": sha, "mergeable": true}, "mergeCommit,mergeable", `.mergeCommit.oid + " " + .mergeable`, sha + " MERGEABLE\n"},
		{"missing merged", map[string]any{"merge_commit_sha": sha}, "mergeCommit", "", ""},
		{"invalid merged", map[string]any{"merged": "true", "merge_commit_sha": sha}, "mergeCommit", "", ""},
		{"missing sha", map[string]any{"merged": true}, "mergeCommit", "", ""},
		{"null sha", map[string]any{"merged": true, "merge_commit_sha": nil}, "mergeCommit", "", ""},
		{"invalid sha", map[string]any{"merged": true, "merge_commit_sha": "not-a-commit"}, "mergeCommit", "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.jq != "" && !jqAvailable() {
				t.Skip("jq is not installed")
			}
			t.Setenv("OCTOPOOL_FRESH", "")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
			calls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				request := decodeCLIRequest(t, w, r)
				headers, _ := request["headers"].(map[string]any)
				wantShape := ""
				if calls == 1 && !strings.Contains(test.fields, "mergeable") {
					wantShape = "pr-summary-v2"
				}
				if got, _ := headers["x-octopool-public-shape"].(string); got != wantShape || headers["cache-control"] != "max-age=0" {
					t.Errorf("headers=%#v want shape=%q and live read", headers, wantShape)
				}
				writeCLIEnvelope(t, w, test.pr)
			})
			args := []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", test.fields}
			if test.jq != "" {
				args = append(args, "--jq", test.jq)
			}
			var out bytes.Buffer
			err := runGH(t.Context(), args, &out, io.Discard)
			if test.want == "" {
				if !isLocalFallback(err) {
					t.Fatalf("incomplete metadata must request typed fallback: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			wantCalls := 1
			if test.want == "" {
				wantCalls = 2
			}
			if calls != wantCalls || out.String() != test.want {
				t.Fatalf("calls=%d output=%q, want %d fresh reads and %q", calls, out.String(), wantCalls, test.want)
			}
		})
	}
}

func TestRunGHAPIPRPreservesTestMergeCommit(t *testing.T) {
	pr := map[string]any{"merged": false, "merge_commit_sha": "0123456789abcdef0123456789abcdef01234567"}
	relayTestServer(t, func(request map[string]any) any { return pr })
	var out bytes.Buffer
	if err := runGH(t.Context(), []string{"api", "repos/openclaw/octopool/pulls/7"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, pr) {
		t.Fatalf("raw REST=%#v, want %#v", got, pr)
	}
}
