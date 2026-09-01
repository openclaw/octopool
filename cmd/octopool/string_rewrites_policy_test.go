package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestStringRewritePolicyFailuresNeverRunChild(t *testing.T) {
	for _, test := range []struct {
		name string
		code int
		body string
	}{
		{"unauthorized", 401, `internal-model`}, {"forbidden", 403, `internal-model`}, {"missing", 404, `internal-model`},
		{"conflict", 409, `internal-model`}, {"limited", 429, `internal-model`}, {"internal", 500, `internal-model`}, {"gateway", 502, `internal-model`}, {"outage", 503, `internal-model`}, {"gateway timeout", 504, `internal-model`},
		{"no content", 204, ""}, {"partial", 206, rewriteEmptyTestPolicy},
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
				w.Header().Set("CF-Ray", "0123456789abcdef-SJC")
				w.Header().Set("X-Private", "synthetic-header-secret")
				w.WriteHeader(test.code)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			t.Setenv("OCTOPOOL_URL", server.URL)
			t.Setenv("OCTOPOOL_POOL", "selected")
			t.Setenv("OCTOPOOL_TOKEN", "configured-token")
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			started := time.Now()
			err := runGH(t.Context(), []string{"issue", "edit", "1", "--body=internal-model", "-Racme/repo"}, &out, &stderr)
			if !errors.Is(err, errRewritePolicy) || out.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("failure output=%q %q error=%v", out.String(), stderr.String(), err)
			}
			if shouldRunRealGH(err) || calls.Load() != 1 {
				t.Fatal("policy failure was retryable/fallback eligible")
			}
			class := rewritePolicyHTTPStatus
			if test.code == 200 {
				class = rewritePolicyServerValidation
				if test.name == "oversized" {
					class = rewritePolicyResponseSize
				}
			}
			requireRewritePolicyDiagnostic(t, err, class, test.code, "0123456789abcdef-SJC", started,
				"internal-model", "configured-token", "synthetic-header-secret", server.URL)
			client, err := newGHRelayClient()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/acme/repo"}); !errors.Is(err, errRewritePolicy) || calls.Load() != 2 {
				t.Fatal("relay boundary retried or dispatched on policy failure")
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
				if !errors.Is(err, errRewritePolicy) || out.Len() != 0 || stderr.Len() != 0 || !slices.Equal(paths, []string{"/v1/pools/maintainers/string-rewrites"}) {
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
		if _, err := rewritePolicyHTTP(t.Context(), server.URL, "/policy", "test-token", "GET", nil); !errors.Is(err, errRewritePolicy) {
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
	if _, err := rewritePolicyHTTP(ctx, slow.URL, "/policy", "test-token", "GET", nil); !errors.Is(err, errRewritePolicy) {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("policy ignored context deadline")
	}
	for _, base := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com?x=y", "https://example.com#fragment"} {
		if _, err := rewritePolicyHTTP(t.Context(), base, "/policy", "synthetic", "GET", nil); !errors.Is(err, errRewritePolicy) {
			t.Fatal("unsafe policy URL accepted")
		}
	}
}
func TestStringRewriteMissingLoginAndLocalFile(t *testing.T) {
	_, calls := rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	capture := captureRewriteGH(t)
	t.Setenv("OCTOPOOL_TOKEN", "")
	if err := runGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); !errors.Is(err, errRewritePolicy) {
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
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); !errors.Is(err, errRewritePolicy) {
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
	if _, err := currentStringRewritePolicy(t.Context()); !errors.Is(err, errRewritePolicy) {
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
	if _, err := currentStringRewritePolicy(t.Context()); !errors.Is(err, errRewritePolicy) {
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
	if _, err := currentStringRewritePolicy(t.Context()); !errors.Is(err, errRewritePolicy) {
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

func requireRewritePolicyDiagnostic(t *testing.T, err error, class rewritePolicyClass, code int, ray string, started time.Time, secrets ...string) *rewritePolicyError {
	t.Helper()
	var diagnostic *rewritePolicyError
	if !errors.Is(err, errRewritePolicy) || !errors.As(err, &diagnostic) {
		t.Fatalf("expected typed policy failure: %v", err)
	}
	if diagnostic.class != class || diagnostic.status != code || diagnostic.ray != ray {
		t.Fatalf("wrong diagnostic: %v", err)
	}
	if diagnostic.started.Before(started) || diagnostic.started.After(time.Now()) || diagnostic.elapsed < 0 || diagnostic.elapsed > time.Since(diagnostic.started) {
		t.Fatalf("invalid attempt timing: %v", err)
	}
	if !strings.HasPrefix(err.Error(), errRewritePolicy.Error()+" (class="+class.String()+" attempt_utc=") || !strings.Contains(err.Error(), "Z elapsed_ms=") || strings.ContainsAny(err.Error(), "\n\r\x1b") {
		t.Fatalf("invalid diagnostic format: %q", err)
	}
	if (code == 0 && strings.Contains(err.Error(), "http_status=")) || (code != 0 && !strings.Contains(err.Error(), fmt.Sprintf(" http_status=%d", code))) {
		t.Fatalf("incorrect HTTP status output: %v", err)
	}
	if (ray == "" && strings.Contains(err.Error(), "cf_ray=")) || (ray != "" && !strings.Contains(err.Error(), " cf_ray="+ray)) {
		t.Fatalf("incorrect correlation output: %v", err)
	}
	for _, secret := range secrets {
		if strings.Contains(fmt.Sprintf("%v\n%+v\n%#v", err, err, err), secret) {
			t.Fatal("diagnostic retained synthetic sensitive input")
		}
	}
	var relay *relayResponseError
	var network *url.Error
	if errors.Unwrap(err) != nil || errors.As(err, &relay) || errors.As(err, &network) || errors.Is(err, errRewriteConflict) || shouldRunRealGH(err) || transientRelayFailure(err) {
		t.Fatal("policy failure exposed a cause or allowed fallback/retry")
	}
	sleeps := recordWatchSleeps(t)
	calls := 0
	backoff := newWatchBackoff(time.Second)
	if got := retryWatchTick(t.Context(), &backoff, func() error { calls++; return err }); got != err || calls != 1 || len(*sleeps) != 0 {
		t.Fatal("typed policy failure did not stop watch immediately")
	}
	return diagnostic
}

type rewritePolicyTestTransport func(*http.Request) (*http.Response, error)

func (transport rewritePolicyTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func useRewritePolicyTestTransport(t *testing.T, transport rewritePolicyTestTransport) {
	t.Helper()
	// The policy client uses the standard default transport, not httpClient.
	// Replace it only in nonparallel synthetic tests; no production hook.
	original := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original })
}

func TestRewritePolicySetupDiagnostics(t *testing.T) {
	for _, scenario := range []string{"missing login", "saved binding", "auth parse", "auth read"} {
		t.Run(scenario, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_TOKEN", "")
			t.Setenv("OCTOPOOL_URL", "https://synthetic-target.invalid")
			t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
			path, err := authPath()
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "saved binding":
				if err := saveAuth(authFile{URL: "https://synthetic-saved.invalid", Token: "synthetic-secret-token"}); err != nil {
					t.Fatal(err)
				}
			case "auth parse", "auth read":
				t.Setenv("OCTOPOOL_TOKEN", "synthetic-secret-token")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if scenario == "auth read" {
					err = os.Mkdir(path, 0700)
				} else {
					err = os.WriteFile(path, []byte(`{"created_at":"synthetic-parser-secret"}`), 0600)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
				t.Error("setup failure reached transport")
				return nil, errors.New("synthetic-network-secret")
			})
			capture := captureRewriteGH(t)
			started := time.Now()
			var out, stderr bytes.Buffer
			err = runGH(t.Context(), []string{"alias", "list"}, &out, &stderr)
			requireRewritePolicyDiagnostic(t, err, rewritePolicySetup, 0, "", started, path,
				"synthetic-secret-token", "synthetic-parser-secret", "synthetic-saved", "synthetic-target")
			if _, err := os.Stat(capture); !os.IsNotExist(err) || out.Len() != 0 || stderr.Len() != 0 {
				t.Fatal("setup failure dispatched or emitted output")
			}
		})
	}
}

func TestRewritePolicyRequestDiagnostics(t *testing.T) {
	for _, test := range []struct{ name, base, token, method, path string }{
		{"malformed URL", "https://synthetic-url-secret.invalid/%zz", "synthetic-token-secret", "GET", "/policy"},
		{"insecure URL", "http://synthetic-url-secret.invalid", "synthetic-token-secret", "GET", "/policy"},
		{"userinfo", "https://synthetic-token-secret@synthetic-url-secret.invalid", "synthetic-token-secret", "GET", "/policy"},
		{"query", "https://synthetic-url-secret.invalid?query=synthetic-secret", "synthetic-token-secret", "GET", "/policy"},
		{"fragment", "https://synthetic-url-secret.invalid#synthetic-secret", "synthetic-token-secret", "GET", "/policy"},
		{"missing URL", "", "synthetic-token-secret", "GET", "/policy"},
		{"blank token", "https://synthetic-url-secret.invalid", " \t", "GET", "/policy"},
		{"invalid method", "https://synthetic-url-secret.invalid", "synthetic-token-secret", "synthetic\nmethod-secret", "/policy"},
		{"invalid path", "https://synthetic-url-secret.invalid", "synthetic-token-secret", "GET", "/%zz/synthetic-path-secret"},
	} {
		t.Run(test.name, func(t *testing.T) {
			useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
				t.Error("invalid request reached transport")
				return nil, errors.New("synthetic-network-secret")
			})
			started := time.Now()
			_, err := rewritePolicyHTTP(t.Context(), test.base, test.path, test.token, test.method, nil)
			requireRewritePolicyDiagnostic(t, err, rewritePolicyRequest, 0, "", started,
				"synthetic-url-secret", "synthetic-token-secret", "synthetic-path-secret", "method-secret")
		})
	}
}

func TestRewritePolicyTransportDiagnostics(t *testing.T) {
	for _, test := range []struct {
		name  string
		err   error
		class rewritePolicyClass
	}{
		{"dns", &net.DNSError{Err: "synthetic-dns-secret", Name: "synthetic-host-secret"}, rewritePolicyTransport},
		{"network", &net.OpError{Op: "synthetic-operation-secret", Net: "tcp", Err: errors.New("synthetic-network-secret")}, rewritePolicyTransport},
		{"timeout", &net.DNSError{Err: "synthetic-dns-secret", IsTimeout: true}, rewritePolicyTimeoutClass},
		{"deadline", fmt.Errorf("synthetic-wrapper-secret: %w", context.DeadlineExceeded), rewritePolicyTimeoutClass},
		{"canceled", fmt.Errorf("synthetic-wrapper-secret: %w", context.Canceled), rewritePolicyCanceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
			capture := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			calls := 0
			useRewritePolicyTestTransport(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/string-rewrites") {
					t.Error("policy failure reached relay")
				}
				return nil, test.err
			})
			client := ghRelayClient{baseURL: "https://synthetic-url-secret.invalid", token: "synthetic-token-secret", pool: "synthetic-pool-secret"}
			started := time.Now()
			_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/acme/repo"})
			requireRewritePolicyDiagnostic(t, err, test.class, 0, "", started, "synthetic-dns-secret", "synthetic-host-secret",
				"synthetic-operation-secret", "synthetic-network-secret", "synthetic-wrapper-secret", "synthetic-url-secret", "synthetic-token-secret", "synthetic-pool-secret")
			if errors.Is(err, test.err) || calls != 1 {
				t.Fatal("transport cause retained or policy retried")
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("transport failure ran child")
			}
		})
	}
}

func TestRewritePolicyControlledTiming(t *testing.T) {
	for _, test := range []struct {
		name     string
		duration time.Duration
		class    rewritePolicyClass
	}{
		{"five second deadline", 5 * time.Second, rewritePolicyTimeoutClass},
		{"parent deadline", 23 * time.Millisecond, rewritePolicyTimeoutClass},
		{"parent cancellation", 17 * time.Millisecond, rewritePolicyCanceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if test.name == "parent deadline" {
					var deadlineCancel context.CancelFunc
					ctx, deadlineCancel = context.WithTimeout(ctx, test.duration)
					defer deadlineCancel()
				} else if test.name == "parent cancellation" {
					go func() { time.Sleep(test.duration); cancel() }()
				}
				calls := 0
				useRewritePolicyTestTransport(t, func(r *http.Request) (*http.Response, error) {
					calls++
					deadline, ok := r.Context().Deadline()
					want := rewritePolicyTimeout
					if test.name == "parent deadline" {
						want = test.duration
					}
					if !ok || deadline.Sub(time.Now()) != want || rewritePolicyTimeout != 5*time.Second {
						t.Error("policy context deadline changed")
					}
					<-r.Context().Done()
					return nil, r.Context().Err()
				})
				started := time.Now()
				_, err := rewritePolicyHTTP(ctx, "https://synthetic.invalid", "/policy", "synthetic-token", "GET", nil)
				diagnostic := requireRewritePolicyDiagnostic(t, err, test.class, 0, "", started, "synthetic-token")
				if diagnostic.elapsed != test.duration || calls != 1 {
					t.Fatalf("elapsed=%s calls=%d", diagnostic.elapsed, calls)
				}
				line := err.Error()
				time.Sleep(time.Second) // Virtual time; formatting must not move the failure timestamp/duration.
				if err.Error() != line {
					t.Fatal("diagnostic timing changed after return")
				}
			})
		})
	}
}

type rewritePolicyFailingBody struct{ closed bool }

func (*rewritePolicyFailingBody) Read([]byte) (int, error) {
	return 0, errors.New("synthetic-body-read-secret")
}
func (body *rewritePolicyFailingBody) Close() error { body.closed = true; return nil }

func TestRewritePolicyResponseReadDiagnostic(t *testing.T) {
	body := &rewritePolicyFailingBody{}
	useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Cf-Ray": {"0123456789abcdef-SJC"}}, Body: body}, nil
	})
	started := time.Now()
	result, err := rewritePolicyHTTP(t.Context(), "https://synthetic.invalid", "/policy", "synthetic-token", "GET", nil)
	requireRewritePolicyDiagnostic(t, err, rewritePolicyResponseRead, 200, "0123456789abcdef-SJC", started, "synthetic-body-read-secret")
	if !body.closed || result.data != nil {
		t.Fatal("failed body retained or not closed")
	}
}

func TestRewritePolicyRayValidation(t *testing.T) {
	for _, test := range []struct {
		name   string
		values []string
		want   string
	}{
		{"absent", nil, ""}, {"id", []string{"0123456789abcdef"}, "0123456789abcdef"},
		{"pop", []string{"0123456789ABCDEF-SJC"}, "0123456789ABCDEF-SJC"},
		{"short", []string{"1234-SJC"}, ""}, {"long", []string{strings.Repeat("a", 10000)}, ""},
		{"nonhex", []string{"0123456789abcdeg-SJC"}, ""}, {"lowercase pop", []string{"0123456789abcdef-sjc"}, ""},
		{"long pop", []string{"0123456789abcdef-SJCA"}, ""}, {"empty pop", []string{"0123456789abcdef-"}, ""},
		{"space", []string{" 0123456789abcdef-SJC"}, ""}, {"newline", []string{"0123456789abcdef-SJC\n"}, ""},
		{"multiple", []string{"0123456789abcdef-SJC", "0123456789abcdef-SJC"}, ""},
		{"joined", []string{"0123456789abcdef-SJC,0123456789abcdef-SJC"}, ""},
		{"arbitrary", []string{"synthetic-header-secret\x1b[31m"}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 403, Header: http.Header{"Cf-Ray": test.values, "X-Private": {"synthetic-other-header-secret"}}, Body: io.NopCloser(strings.NewReader("synthetic-body-secret"))}, nil
			})
			started := time.Now()
			_, err := rewritePolicyHTTP(t.Context(), "https://synthetic.invalid", "/policy", "synthetic-token", "GET", nil)
			requireRewritePolicyDiagnostic(t, err, rewritePolicyHTTPStatus, 403, test.want, started,
				"synthetic-header-secret", "synthetic-other-header-secret", "synthetic-body-secret")
		})
	}
}

func TestRewritePolicyLocalAndMergeDiagnostics(t *testing.T) {
	for _, scenario := range []string{"missing", "directory", "unreadable", "oversized", "malformed", "invalid", "conflict", "rule limit", "document limit"} {
		t.Run(scenario, func(t *testing.T) {
			isolateTestConfig(t)
			serverPolicy := rewriteActiveTestPolicy
			localBody := `{"schema_version":1,"rules":[{"pattern":"synthetic-local-pattern","replacement":"synthetic-local-value"}]}`
			class := rewritePolicyLocalRead
			switch scenario {
			case "malformed":
				class, localBody = rewritePolicyLocalValidation, "synthetic-file-secret"
			case "invalid":
				class, localBody = rewritePolicyLocalValidation, `{"schema_version":1,"rules":[{"pattern":"[synthetic-local-pattern","replacement":"synthetic-local-value"}]}`
			case "conflict":
				class, localBody = rewritePolicyMerge, `{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"synthetic-local-value"}]}`
			case "oversized":
				localBody = strings.Repeat("x", rewriteMaxDocument+1)
			case "rule limit", "document limit":
				class = rewritePolicyMerge
				count, replacement := 65, "synthetic-local-value"
				if scenario == "document limit" {
					count, replacement = 40, strings.Repeat("x", rewriteMaxReplacement)
				}
				makePolicy := func(prefix string, server bool) string {
					rules := make([]stringRewriteRule, count)
					for i := range rules {
						rules[i] = stringRewriteRule{fmt.Sprintf("%s-%d", prefix, i), replacement}
					}
					value := map[string]any{"schema_version": 1, "rules": rules}
					if server {
						value["revision"], value["updated_at"] = 1, "2026-09-01T00:00:00Z"
					}
					data, err := json.Marshal(value)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := parseStringRewritePolicy(data, server); err != nil {
						t.Fatal("invalid individual limit fixture", err)
					}
					return string(data)
				}
				serverPolicy, localBody = makePolicy("synthetic-server-pattern", true), makePolicy("synthetic-local-pattern", false)
			}
			path := filepath.Join(t.TempDir(), "synthetic-path-secret.json")
			if scenario == "directory" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else if scenario != "missing" {
				if err := os.WriteFile(path, []byte(localBody), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "unreadable" {
				if runtime.GOOS == "windows" || os.Geteuid() == 0 {
					t.Skip("permission fixture requires a non-root Unix user")
				}
				if err := os.Chmod(path, 0000); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(path, 0600) })
			}
			t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", path)
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != "/v1/pools/maintainers/string-rewrites" || r.ContentLength > 0 {
					t.Error("local policy uploaded or failure dispatched")
				}
				w.Header().Set("CF-Ray", "0123456789abcdef-SJC")
				_, _ = io.WriteString(w, serverPolicy)
			}))
			t.Cleanup(server.Close)
			t.Setenv("OCTOPOOL_URL", server.URL)
			t.Setenv("OCTOPOOL_TOKEN", "synthetic-token-secret")
			t.Setenv("OCTOPOOL_POOL", "maintainers")
			capture := captureRewriteGH(t)
			started := time.Now()
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"alias", "list"}, &out, &stderr)
			requireRewritePolicyDiagnostic(t, err, class, 200, "0123456789abcdef-SJC", started, path,
				"synthetic-token-secret", "synthetic-file-secret", "synthetic-local-pattern", "synthetic-local-value", "internal-model", server.URL)
			if _, err := os.Stat(capture); !os.IsNotExist(err) || out.Len() != 0 || stderr.Len() != 0 || calls.Load() != 1 {
				t.Fatal("local/merge failure emitted output, dispatched or retried")
			}
			if scenario != "missing" && scenario != "directory" && scenario != "unreadable" {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != localBody {
					t.Fatal("local policy changed")
				}
			}
		})
	}
}

func TestRewritePolicyHTTPMetadataThroughLocalTiming(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		isolateTestConfig(t)
		path := filepath.Join(t.TempDir(), "missing.json")
		t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", path)
		useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
			time.Sleep(31 * time.Millisecond) // Virtual transport time, not a wall-clock sleep.
			return &http.Response{StatusCode: 200, Header: http.Header{"Cf-Ray": {"0123456789abcdef-SJC"}}, Body: io.NopCloser(strings.NewReader(rewriteEmptyTestPolicy))}, nil
		})
		started := time.Now()
		client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token", pool: "maintainers"}
		_, err := client.stringRewritePolicy(t.Context())
		diagnostic := requireRewritePolicyDiagnostic(t, err, rewritePolicyLocalRead, 200, "0123456789abcdef-SJC", started, path)
		if !diagnostic.started.Equal(started) || diagnostic.elapsed != 31*time.Millisecond {
			t.Fatal("local failure lost HTTP timing")
		}
	})
}

func TestRewritePolicyFailureIsNotCached(t *testing.T) {
	calls := rewriteTestServerPolicySequence(t, func(call int64) (string, int) {
		if call == 1 {
			return "synthetic-failure-secret", 403
		}
		return rewriteEmptyTestPolicy, 200
	}, nil)
	capture := captureRewriteGH(t)
	args := []string{"alias", "list"}
	var out, stderr bytes.Buffer
	started := time.Now()
	err := runGH(t.Context(), args, &out, &stderr)
	requireRewritePolicyDiagnostic(t, err, rewritePolicyHTTPStatus, 403, "", started, "synthetic-failure-secret")
	if calls.Load() != 1 || out.Len() != 0 || stderr.Len() != 0 {
		t.Fatal("failure retried or emitted output")
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("failed attempt ran child")
	}
	// No config, arguments, binary or local policy changes between attempts.
	if err := runGH(t.Context(), args, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 || !slices.Equal(readRewriteCapture(t, capture).Args, args) || stderr.String() != "child stderr\n" {
		t.Fatalf("fresh preflight/final policy or silent success changed: calls=%d stderr=%q", calls.Load(), stderr.String())
	}
}

func TestRewritePolicySameOriginRedirects(t *testing.T) {
	for _, code := range []int{301, 302, 303, 307, 308} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/policy" {
					t.Error("redirect forwarded credentials to destination")
				}
				w.Header().Set("CF-Ray", "0123456789abcdef-SJC")
				http.Redirect(w, r, "/synthetic-redirect-secret", code)
			}))
			t.Cleanup(server.Close)
			started := time.Now()
			_, err := rewritePolicyHTTP(t.Context(), server.URL, "/policy", "synthetic-token-secret", "GET", nil)
			requireRewritePolicyDiagnostic(t, err, rewritePolicyHTTPStatus, code, "0123456789abcdef-SJC", started,
				"synthetic-redirect-secret", "synthetic-token-secret", server.URL)
			if calls.Load() != 1 {
				t.Fatal("same-origin redirect followed")
			}
		})
	}
}

func TestRewritePolicyAdminHTTPConflict(t *testing.T) {
	for _, method := range []string{"GET", "PUT"} {
		t.Run(method, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(409)
				_, _ = io.WriteString(w, "synthetic-conflict-secret")
			}))
			t.Cleanup(server.Close)
			result, err := rewritePolicyHTTP(t.Context(), server.URL, "/v1/admin/string-rewrites", "synthetic-token", method, nil)
			if err != errRewriteConflict || errors.Is(err, errRewritePolicy) || result.attempt.status != 409 || result.data != nil {
				t.Fatalf("admin conflict contract changed: %v", err)
			}
		})
	}
}

func TestRewritePolicyExactResponseBound(t *testing.T) {
	for _, size := range []int{rewriteMaxDocument, rewriteMaxDocument + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			data := rewriteEmptyTestPolicy + strings.Repeat(" ", size-len(rewriteEmptyTestPolicy))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, data) }))
			t.Cleanup(server.Close)
			started := time.Now()
			result, err := rewritePolicyHTTP(t.Context(), server.URL, "/policy", "synthetic-token", "GET", nil)
			if size == rewriteMaxDocument {
				if err != nil || len(result.data) != size {
					t.Fatalf("exact bound rejected: %v", err)
				}
				if _, err := parseStringRewritePolicy(result.data, true); err != nil {
					t.Fatal("valid padded policy rejected", err)
				}
			} else {
				requireRewritePolicyDiagnostic(t, err, rewritePolicyResponseSize, 200, "", started)
				if result.data != nil {
					t.Fatal("oversized body retained")
				}
			}
		})
	}
}
