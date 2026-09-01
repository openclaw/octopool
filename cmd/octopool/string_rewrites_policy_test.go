package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStringRewritePolicyFailuresNeverRunChild(t *testing.T) {
	for _, test := range []struct {
		name string
		code int
		body string
	}{
		{"unauthorized", 401, `internal-model`}, {"forbidden", 403, `internal-model`}, {"missing", 404, `internal-model`}, {"outage", 503, `internal-model`},
		{"invalid JSON", 200, `internal-model`}, {"missing fields", 200, `{"rules":[]}`}, {"duplicate keys", 200, `{"schema_version":1,"schema_version":1,"rules":[]}`},
		{"oversized", 200, strings.Repeat(" ", rewriteMaxDocument) + rewriteEmptyTestPolicy},
		{"invalid UTF8", 200, strings.Replace(rewriteActiveTestPolicy, "public", string([]byte{255}), 1)},
		{"unpaired surrogate", 200, strings.Replace(rewriteActiveTestPolicy, "public", `\ud800`, 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/pools/selected/string-rewrites" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer configured-token" {
					t.Error("incorrect policy request")
				}
				w.WriteHeader(test.code)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			t.Setenv("OCTOPOOL_URL", server.URL)
			t.Setenv("OCTOPOOL_POOL", "selected")
			t.Setenv("OCTOPOOL_TOKEN", "configured-token")
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"issue", "edit", "1", "--body=internal-model", "-Racme/repo"}, &out, &stderr)
			if err != errRewritePolicy || out.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("failure output=%q %q error=%v", out.String(), stderr.String(), err)
			}
			if shouldRunRealGH(err) || calls.Load() != 1 {
				t.Fatal("policy failure was retryable/fallback eligible")
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("policy failure reached child")
			}
		})
	}
}

func TestStringRewritePolicyBeforeMalformedReadOptions(t *testing.T) {
	for _, code := range []int{401, 503} {
		for _, flags := range [][]string{{"--json", `"unterminated`, "--json=number"}, {"--json=number", "--limit=08", "--limit=2"}} {
			t.Run(fmt.Sprintf("%d/%s", code, flags[1]), func(t *testing.T) {
				isolateTestConfig(t)
				t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
				var paths []string
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { paths = append(paths, r.URL.Path); w.WriteHeader(code) }))
				t.Cleanup(server.Close)
				t.Setenv("OCTOPOOL_URL", server.URL)
				t.Setenv("OCTOPOOL_POOL", "maintainers")
				t.Setenv("OCTOPOOL_TOKEN", "test-token")
				capture := captureRewriteGH(t)
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), append([]string{"pr", "list", "-R", "acme/repo"}, flags...), &out, &stderr)
				if err != errRewritePolicy || out.Len() != 0 || stderr.Len() != 0 || !slices.Equal(paths, []string{"/v1/pools/maintainers/string-rewrites"}) {
					t.Fatalf("policy precedence err=%v paths=%v out=%q stderr=%q", err, paths, out.String(), stderr.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("policy denial executed child")
				}
			})
		}
	}
}
func TestStringRewritePolicyRedirectsAndTimeout(t *testing.T) {
	var destinationCalls atomic.Int64
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationCalls.Add(1)
		_, _ = io.WriteString(w, rewriteEmptyTestPolicy)
	}))
	defer destination.Close()
	for _, code := range []int{301, 302, 303, 307, 308} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, code) }))
		if _, err := rewritePolicyHTTP(t.Context(), server.URL, "/policy", "test-token", "GET", nil); err != errRewritePolicy {
			t.Fatalf("redirect error=%v", err)
		}
		server.Close()
	}
	if destinationCalls.Load() != 0 {
		t.Fatal("policy followed a redirect")
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer slow.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := rewritePolicyHTTP(ctx, slow.URL, "/policy", "test-token", "GET", nil); err != errRewritePolicy {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("policy ignored context deadline")
	}
	for _, base := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com?x=y", "https://example.com#fragment"} {
		if _, err := rewritePolicyHTTP(t.Context(), base, "/policy", "synthetic", "GET", nil); err != errRewritePolicy {
			t.Fatal("unsafe policy URL accepted")
		}
	}
}
func TestStringRewriteMissingLoginAndLocalFile(t *testing.T) {
	_, calls := rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	capture := captureRewriteGH(t)
	t.Setenv("OCTOPOOL_TOKEN", "")
	if err := runGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); err != errRewritePolicy {
		t.Fatalf("no-login error=%v", err)
	}
	if calls.Load() != 0 {
		t.Fatal("missing login made a policy request")
	}
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); err != nil {
		t.Fatal("absent optional default must preserve empty-policy behavior", err)
	}
	if err := os.Remove(capture); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", filepath.Join(t.TempDir(), "missing.json"))
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); err != errRewritePolicy {
		t.Fatalf("explicit missing local error=%v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("missing local policy reached child")
	}
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	auth, err := authPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(auth), 0700); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(filepath.Dir(auth), "string-rewrites.json")
	if err := os.WriteFile(local, []byte(`{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"public"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("default local best-effort policy failed: %v", err)
	}
	if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, []string{"alias", "list"}) {
		t.Fatalf("default local best-effort args=%v", got.Args)
	}
}
func TestStringRewriteSavedURLBinding(t *testing.T) {
	rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	t.Setenv("OCTOPOOL_TOKEN", "")
	if err := saveAuth(authFile{URL: "https://saved.example", Token: "saved-token", Pool: "maintainers"}); err != nil {
		t.Fatal(err)
	}
	if _, err := currentStringRewritePolicy(t.Context()); err != errRewritePolicy {
		t.Fatal("saved token was not bound to saved URL")
	}
}
func TestStringRewriteDirectRequestGuard(t *testing.T) {
	var relayCalls atomic.Int64
	rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		relayCalls.Add(1)
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["path"] != "/repos/acme/repo" {
			t.Error("unexpected direct request path")
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	local := filepath.Join(t.TempDir(), "local.json")
	if err := os.WriteFile(local, []byte(`{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"public"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", local)
	for _, args := range [][]string{
		{"--path", "/repos/acme/internal-model"},
		{"--path", "/repos/acme/repo", "--query", "q=%69nternal-model"},
		{"--path", "/repos/acme/repo", "--header", "accept=internal-model"},
		{"--path", "/repos/acme/repo", "--route-hint", "pr_state=internal-model"},
	} {
		if err := runRequest(t.Context(), args, io.Discard); err != errRewriteBlocked {
			t.Fatalf("direct guard error=%v", err)
		}
	}
	if relayCalls.Load() != 0 {
		t.Fatal("blocked direct request reached relay")
	}
	if err := runRequest(t.Context(), []string{"--path", "/repos/acme/repo"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	if relayCalls.Load() != 1 {
		t.Fatal("safe direct request not sent")
	}
}
func TestStringRewritePolicyChangeBeforeFallback(t *testing.T) {
	var body *atomic.Value
	body, _ = rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		body.Store(rewriteActiveTestPolicy)
		writeCLIFallback(t, w, "route_denied")
	})
	capture := captureRewriteGH(t)
	err := runGH(t.Context(), []string{"api", "repos/acme/internal-model"}, io.Discard, io.Discard)
	if err != errRewriteBlocked {
		t.Fatalf("changed policy fallback error=%v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("fallback reused an earlier approval")
	}
}
func TestStringRewriteBootstrapIsNarrow(t *testing.T) {
	if rewriteBootstrapInvocation([]string{"auth", "login", "--scopes=internal-model"}) {
		t.Fatal("arbitrary OAuth scope bypassed policy")
	}
	for _, args := range [][]string{{"--version"}, {"auth", "status", "--active", "--hostname", "github.com"}, {"auth", "login", "--with-token", "--hostname", "github.com"}} {
		if !rewriteBootstrapInvocation(args) {
			t.Fatalf("bootstrap denied: %v", args)
		}
	}
	for _, args := range [][]string{{"auth", "token"}, {"auth", "refresh"}, {"auth", "login", "--unknown"}, {"auth", "status", "--hostname", "other.example"}, {"auth", "login", "--with-token", "extra"}, {"--help", "alias", "list"}, {"api", "graphql", "-fquery=mutation {unsafe}"}} {
		if rewriteBootstrapInvocation(args) {
			t.Fatalf("broad bootstrap: %v", args)
		}
	}
}

func TestStringRewriteLocalConflictAndImmediateChange(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	local := filepath.Join(t.TempDir(), "local.json")
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", local)
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(local, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"other"}]}`)
	if _, err := currentStringRewritePolicy(t.Context()); err != errRewritePolicy {
		t.Fatal("conflict accepted")
	}
	write(`{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"public"}]}`)
	p, err := currentStringRewritePolicy(t.Context())
	if err != nil || len(p.Rules) != 1 {
		t.Fatal("identical local rule not deduplicated", err)
	}
	write(`{"schema_version":1,"rules":[{"pattern":"public","replacement":"current"}]}`)
	p, err = currentStringRewritePolicy(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if out, err := p.rewrite("internal-model"); err != nil || out != "current" {
		t.Fatalf("stale local policy: %q %v", out, err)
	}
	write(`{"schema_version":1,"rules":null}`)
	if _, err := currentStringRewritePolicy(t.Context()); err != errRewritePolicy {
		t.Fatal("corrupt local policy reused last good value")
	}
}

func TestStringRewriteChecksFinalFreshHeader(t *testing.T) {
	rewriteTestServer(t, strings.Replace(rewriteActiveTestPolicy, "internal-model", "max-age=0", 1), nil)
	t.Setenv("OCTOPOOL_FRESH", "1")
	client, err := newGHRelayClient()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/acme/repo"}); err != errRewriteBlocked {
		t.Fatalf("fresh header bypassed guard: %v", err)
	}
}

func TestStringRewriteWatchPolicyErrorsAreTerminal(t *testing.T) {
	sleeps := recordWatchSleeps(t)
	for _, failure := range []error{errRewritePolicy, errRewriteBlocked, errOctopoolNotLoggedIn} {
		calls := 0
		backoff := newWatchBackoff(time.Second)
		err := retryWatchTick(t.Context(), &backoff, func() error { calls++; return failure })
		if err != failure || calls != 1 || len(*sleeps) != 0 {
			t.Fatalf("policy failure retried: %v calls=%d sleeps=%v", err, calls, *sleeps)
		}
	}
}
