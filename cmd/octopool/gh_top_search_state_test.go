package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestRunGHSearchStateProjection(t *testing.T) {
	for _, test := range []struct {
		name, kind, want string
		item             map[string]any
	}{
		{"open PR", "prs", "open", map[string]any{"state": "open", "pull_request": map[string]any{}}},
		{"closed PR", "prs", "closed", map[string]any{"state": "closed", "pull_request": map[string]any{}}},
		{"merged PR", "prs", "merged", map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": prStateTestTime}}},
		{"null merge", "prs", "closed", map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": nil}}},
		{"empty merge", "prs", "closed", map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": ""}}},
		{"zero merge", "prs", "closed", map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": "0001-01-01T00:00:00Z"}}},
		{"closed draft", "prs", "closed", map[string]any{"state": "closed", "draft": true, "isDraft": true}},
		{"top-level merge only", "prs", "closed", map[string]any{"state": "closed", "merged_at": prStateTestTime}},
		{"passed-through state", "prs", "MERGED", map[string]any{"state": "MERGED"}},
		{"open issue", "issues", "open", map[string]any{"state": "open"}},
		{"closed issue", "issues", "closed", map[string]any{"state": "closed"}},
		{"shared search export", "issues", "merged", map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": prStateTestTime}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_FRESH", "")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			before, _ := json.Marshal(test.item)
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				kind := "pr"
				if test.kind == "issues" {
					kind = "issue"
				}
				want := map[string]any{
					"pool": "maintainers", "method": "GET", "path": "/search/issues",
					"query":   map[string]any{"q": "repo:openclaw/octopool type:" + kind + " cache", "per_page": "20"},
					"headers": map[string]any{"x-octopool-public-shape": "issue-search-v1"},
				}
				if !reflect.DeepEqual(request, want) {
					t.Errorf("request = %#v, want %#v", request, want)
				}
				return map[string]any{"items": []any{test.item}}
			})
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), []string{"search", test.kind, "cache", "-R", "openclaw/octopool", "--limit", "20", "--json", "state"}, &out, &stderr); err != nil {
				t.Fatalf("runGH: %v, stderr=%q", err, stderr.String())
			}
			if want := "[{\"state\":\"" + test.want + "\"}]\n"; out.String() != want {
				t.Errorf("projection = %q, want %q", out.String(), want)
			}
			after, _ := json.Marshal(test.item)
			if !bytes.Equal(before, after) || calls != 1 {
				t.Errorf("source changed or extra requests: before=%s after=%s calls=%d", before, after, calls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("unexpected native fallback")
			}
		})
	}
}

func TestRunGHListAndSearchStateBeforeJQ(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq is not installed")
	}
	for _, test := range []struct {
		name, fields, expression string
		args                     []string
		body                     any
	}{
		{"list REST", "state,headRefOid", `.[0] | .state == "MERGED" and keys == ["headRefOid", "state"]`, []string{"pr", "list", "--state", "all"}, []any{map[string]any{"state": "closed", "head": map[string]any{"sha": prStateTestHead}, "merged_at": prStateTestTime}}},
		{"list page", "state,isDraft", `.[0] | .state == "OPEN" and .isDraft == true and keys == ["isDraft", "state"]`, []string{"pr", "list", "--state", "all"}, []any{map[string]any{"state": "DRAFT", "draft": true}}},
		{"list state omitted", "number", `.[0] | keys == ["number"]`, []string{"pr", "list", "--state", "all"}, []any{map[string]any{"number": 1, "state": "closed", "merged_at": prStateTestTime}}},
		{"search merged", "state", `.[0] | .state == "merged" and keys == ["state"]`, []string{"search", "prs", "cache"}, map[string]any{"items": []any{map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": prStateTestTime}}}}},
		{"search state omitted", "number", `.[0] | keys == ["number"]`, []string{"search", "prs", "cache"}, map[string]any{"items": []any{map[string]any{"number": 1, "state": "closed", "pull_request": map[string]any{"merged_at": prStateTestTime}}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			calls := 0
			relayTestServer(t, func(request map[string]any) any { calls++; return test.body })
			capture := captureRewriteGH(t)
			args := append(test.args, "-R", "openclaw/octopool", "--json", test.fields, "--jq", test.expression)
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil || out.String() != "true\n" || calls != 1 {
				t.Errorf("err=%v output=%q stderr=%q calls=%d", err, out.String(), stderr.String(), calls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("unexpected native fallback")
			}
		})
	}
}

func TestRunGHListAndSearchStatePreservesRawAPI(t *testing.T) {
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	t.Setenv("OCTOPOOL_FRESH", "")
	pr := map[string]any{"number": float64(1), "state": "closed", "merged_at": prStateTestTime, "draft": false}
	search := map[string]any{"items": []any{map[string]any{"number": float64(1), "state": "closed", "pull_request": map[string]any{"merged_at": prStateTestTime}}}}
	pulls := []any{pr}
	fixtures := map[string]any{"/repos/openclaw/octopool/pulls": pulls, "/repos/openclaw/octopool/pulls/1": pr, "/search/issues": search}
	before, _ := json.Marshal(fixtures)
	calls := 0
	relayTestServer(t, func(request map[string]any) any {
		calls++
		fixture, ok := fixtures[request["path"].(string)]
		if !ok {
			t.Errorf("unexpected request: %#v", request)
		}
		return fixture
	})
	capture := captureRewriteGH(t)
	for _, args := range [][]string{
		{"pr", "list", "-R", "openclaw/octopool", "--state", "all", "--json", "state"},
		{"search", "prs", "cache", "-R", "openclaw/octopool", "--json", "state"},
		{"search", "prs", "cache", "-R", "openclaw/octopool", "--json", "number"},
	} {
		var out, stderr bytes.Buffer
		if err := runGH(t.Context(), args, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		want := "[{\"state\":\"MERGED\"}]\n"
		if args[0] == "search" {
			want = "[{\"state\":\"merged\"}]\n"
			if args[len(args)-1] == "number" {
				want = "[{\"number\":1}]\n"
			}
		}
		if out.String() != want {
			t.Errorf("args=%v output=%q, want %q", args, out.String(), want)
		}
	}
	for path, want := range fixtures {
		args := []string{"api", strings.TrimPrefix(path, "/")}
		if path == "/search/issues" {
			args[1] += "?q=repo:openclaw/octopool+type:pr+cache"
		}
		var out, stderr bytes.Buffer
		if err := runGH(t.Context(), args, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		var got any
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("raw %s = %#v, want %#v", path, got, want)
		}
	}
	after, _ := json.Marshal(fixtures)
	if !bytes.Equal(before, after) || calls != 6 {
		t.Errorf("source changed or extra requests: before=%s after=%s calls=%d", before, after, calls)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Error("unexpected native fallback")
	}
}

func TestRunGHListAndSearchStateProtection(t *testing.T) {
	for _, command := range []struct {
		name, output string
		args         []string
		body         any
	}{
		{"list", "[{\"state\":\"MERGED\"}]\n", []string{"pr", "list", "--state", "all"}, []any{map[string]any{"state": "closed", "merged_at": prStateTestTime}}},
		{"search", "[{\"state\":\"merged\"}]\n", []string{"search", "prs", "cache"}, map[string]any{"items": []any{map[string]any{"state": "closed", "pull_request": map[string]any{"merged_at": prStateTestTime}}}}},
	} {
		for _, mode := range []string{"allowed", "auth failure", "policy denial"} {
			t.Run(command.name+"/"+mode, func(t *testing.T) {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				policy := rewriteActiveTestPolicy
				if mode == "policy denial" {
					policy = strings.ReplaceAll(policy, "internal-model", "octopool")
				}
				calls := 0
				_, policyCalls := rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					if mode == "auth failure" {
						w.WriteHeader(http.StatusUnauthorized)
						_, _ = w.Write([]byte(`{"error":{"code":"invalid_auth","message":"expired"}}`))
						return
					}
					writeCLIEnvelope(t, w, command.body)
				})
				capture := captureRewriteGH(t)
				args := append(command.args, "-R", "openclaw/octopool", "--json", "state")
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), args, &out, &stderr)
				wantCalls := 1
				if mode == "policy denial" {
					wantCalls = 0
				}
				if (err == nil) != (mode == "allowed") || calls != wantCalls || policyCalls.Load() == 0 {
					t.Errorf("err=%v relays=%d policies=%d", err, calls, policyCalls.Load())
				}
				if mode == "allowed" && out.String() != command.output || mode != "allowed" && out.Len() != 0 {
					t.Errorf("output=%q", out.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Error("unexpected native fallback")
				}
			})
		}
	}
}
