package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"testing/iotest"
	"time"
)

func TestGHRelayRecoversHTTPFailuresWithoutNativeFallback(t *testing.T) {
	for _, failure := range []string{"closed connection", "connection reset", "partial response", "520", "521", "522", "523", "524"} {
		t.Run(failure, func(t *testing.T) {
			var calls atomic.Int64
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					if code, err := strconv.Atoi(failure); err == nil {
						w.WriteHeader(code)
						_, _ = io.WriteString(w, "synthetic gateway failure")
						return
					}
					conn, buffer, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					if failure == "partial response" {
						_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n{\"status\":200,\"body\":")
						_ = buffer.Flush()
					}
					if failure == "connection reset" {
						if err := conn.(*net.TCPConn).SetLinger(0); err != nil {
							t.Error(err)
						}
					}
					_ = conn.Close()
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"ok": true})
			})
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			useTestRelayRetryDelays(t, time.Millisecond)
			var out, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
			if err != nil || out.String() != "{\"ok\":true}\n" || stderr.Len() != 0 || calls.Load() != 2 || policies.Load() != 3 {
				t.Fatalf("err=%v output=%q stderr=%q relay=%d policies=%d", err, out.String(), stderr.String(), calls.Load(), policies.Load())
			}
		})
	}
}

func TestGHRelayHTTPFailureDoesNotRetryRejections(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		body    string
		partial bool
	}{
		{"partial unauthorized", 401, `{"error":`, true},
		{"partial forbidden", 403, `{"error":`, true},
		{"partial fallback", 424, `{"error":`, true},
		{"edge status with auth rejection", 520, `{"error":{"code":"invalid_auth"}}`, false},
		{"edge status with policy rejection", 520, `{"error":{"code":"string_rewrite_denied"}}`, false},
		{"TLS handshake error", 525, "synthetic TLS failure", false},
		{"certificate error", 526, "synthetic certificate failure", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int64
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				if test.partial {
					w.Header().Set("Content-Length", "200")
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			})
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			useTestRelayRetryDelays(t, time.Millisecond)
			var out, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
			if err == nil || out.Len() != 0 || stderr.Len() != 0 || calls.Load() != 1 || policies.Load() != 2 {
				t.Fatalf("err=%v output=%q stderr=%q relay=%d policies=%d", err, out.String(), stderr.String(), calls.Load(), policies.Load())
			}
		})
	}
}

func TestGHRelayRetryRechecksPolicy(t *testing.T) {
	var calls atomic.Int64
	policies := rewriteTestServerPolicySequence(t, func(call int64) (string, int) {
		if call == 3 {
			return "synthetic policy outage", 503
		}
		return rewriteEmptyTestPolicy, 200
	}, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Length", "200")
		_, _ = io.WriteString(w, `{"status":200,"body":`)
	})
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
	useTestRelayRetryDelays(t, time.Millisecond)
	var out, stderr bytes.Buffer
	err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
	if !errors.Is(err, errRewritePolicy) || out.Len() != 0 || stderr.Len() != 0 || calls.Load() != 1 || policies.Load() != 3 {
		t.Fatalf("err=%v output=%q stderr=%q relay=%d policies=%d", err, out.String(), stderr.String(), calls.Load(), policies.Load())
	}
}

func TestGHRelayPolicyTransportFailureIsTerminal(t *testing.T) {
	for _, mode := range []string{"partial policy", "policy timeout"} {
		t.Run(mode, func(t *testing.T) {
			var resources atomic.Int64
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(http.ResponseWriter, *http.Request) { resources.Add(1) })
			original := http.DefaultTransport
			var policies int
			useRewritePolicyTestTransport(t, func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/string-rewrites") {
					policies++
					if policies == 2 {
						if mode == "policy timeout" {
							return nil, &net.DNSError{Err: "synthetic timeout", IsTimeout: true}
						}
						return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(io.MultiReader(strings.NewReader(`{"schema_version":`), iotest.ErrReader(io.ErrUnexpectedEOF))), Request: request}, nil
					}
				}
				return original.RoundTrip(request)
			})
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			useTestRelayRetryDelays(t, time.Millisecond)
			var out, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
			if !errors.Is(err, errRewritePolicy) || out.Len() != 0 || stderr.Len() != 0 || policies != 2 || resources.Load() != 0 {
				t.Fatalf("err=%v output=%q stderr=%q policies=%d resources=%d", err, out.String(), stderr.String(), policies, resources.Load())
			}
		})
	}
}

func TestGHRelayTransportTimeoutHonorsCallerContext(t *testing.T) {
	for _, mode := range []string{"HTTP timeout", "caller deadline", "caller cancellation"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			t.Setenv("OCTOPOOL_RELAY_TIMEOUT_SECONDS", "5")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			if mode == "caller deadline" {
				var cancelDeadline context.CancelFunc
				ctx, cancelDeadline = context.WithTimeout(ctx, 200*time.Millisecond)
				defer cancelDeadline()
			}
			var calls atomic.Int64
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					if _, err := io.Copy(io.Discard, r.Body); err != nil {
						t.Error(err)
						return
					}
					if mode == "caller cancellation" {
						cancel()
					}
					<-r.Context().Done()
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"ok": true})
			})
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			useTestRelayRetryDelays(t, time.Millisecond)
			var out, stderr bytes.Buffer
			err := run(ctx, []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
			if mode == "HTTP timeout" {
				if !isLocalFallback(err) || !strings.Contains(err.Error(), "relay_timeout") || out.Len() != 0 {
					t.Fatalf("err=%v output=%q", err, out.String())
				}
			} else if !errors.Is(err, ctx.Err()) || ctx.Err() == nil || out.Len() != 0 {
				t.Fatalf("err=%v context=%v output=%q", err, ctx.Err(), out.String())
			}
			if calls.Load() != 1 || policies.Load() != 2 || stderr.Len() != 0 {
				t.Fatalf("relay=%d policies=%d stderr=%q", calls.Load(), policies.Load(), stderr.String())
			}
		})
	}
}

func TestGHRelayDoesNotRetryPermanentTransportFailures(t *testing.T) {
	for _, cause := range []error{&x509.UnknownAuthorityError{}, &net.DNSError{Err: "no such host", IsNotFound: true}, errors.New("synthetic protocol error")} {
		t.Run(cause.Error(), func(t *testing.T) {
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
			var calls int
			useHTTPTestTransport(t, rewritePolicyTestTransport(func(*http.Request) (*http.Response, error) {
				calls++
				return nil, cause
			}))
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "2")
			useTestRelayRetryDelays(t, time.Millisecond)
			var out, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
			if !errors.Is(err, cause) || out.Len() != 0 || stderr.Len() != 0 || calls != 1 || policies.Load() != 2 {
				t.Fatalf("err=%v output=%q stderr=%q relay=%d policies=%d", err, out.String(), stderr.String(), calls, policies.Load())
			}
		})
	}
}

func TestGHRelayTransportExhaustionDoesNotDelegate(t *testing.T) {
	for _, retries := range []string{"0", "2"} {
		t.Run(retries, func(t *testing.T) {
			var calls atomic.Int64
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Length", "200")
				_, _ = io.WriteString(w, `{"status":200,"body":`)
			})
			t.Setenv("OCTOPOOL_RELAY_RETRIES", retries)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			useTestRelayRetryDelays(t, time.Millisecond)
			var out, stderr bytes.Buffer
			err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr)
			count, _ := strconv.Atoi(retries)
			if !errors.Is(err, io.ErrUnexpectedEOF) || out.Len() != 0 || strings.Contains(stderr.String(), "falling back") || calls.Load() != int64(count+1) || policies.Load() != int64(count+2) {
				t.Fatalf("err=%v output=%q stderr=%q relay=%d policies=%d", err, out.String(), stderr.String(), calls.Load(), policies.Load())
			}
		})
	}
}

func TestWriteGHBodyAllowsNullTextBody(t *testing.T) {
	envelope := relayEnvelope{Status: 304, Body: []byte("null"), BodyEncoding: "text"}
	if err := writeGHBody(t.Context(), discardWriter{}, envelope, ""); err != nil {
		t.Fatal(err)
	}
}

func TestParseLocalFallback(t *testing.T) {
	relay := parseRelayResponseError(http.StatusFailedDependency, []byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"route_denied"}}}`))
	err, ok := localFallbackFromRelayError(relay)
	if !ok {
		t.Fatal("expected fallback")
	}
	if err.Reason != "route_denied" {
		t.Fatalf("reason = %q", err.Reason)
	}
	if err.Relay != relay || err.Relay.Code != "fallback_local" {
		t.Fatal("decoded fallback_local must retain explicit relay provenance")
	}
}

func TestParseRelayResponseErrorRedactsMalformedBody(t *testing.T) {
	relay := parseRelayResponseError(http.StatusBadGateway, []byte("secret upstream response"))
	if relay.Status != http.StatusBadGateway || relay.Code != "" {
		t.Fatalf("relay error = %#v", relay)
	}
	if got := relay.Error(); got != "octopool request failed (HTTP 502): malformed relay error response" {
		t.Fatalf("error = %q", got)
	}
}

func TestRelayRetryAttempts(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		want int
	}{
		{name: "default", want: len(relayRetryDelays)},
		{name: "zero", raw: "0", want: 0},
		{name: "larger than schedule", raw: "5", want: 5},
		{name: "invalid", raw: "invalid", want: 1},
		{name: "negative", raw: "-1", want: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_RELAY_RETRIES", test.raw)
			if got := relayRetryAttempts(); got != test.want {
				t.Fatalf("relayRetryAttempts() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestRelayReadTimeout(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want time.Duration
	}{
		{"", 20 * time.Second},
		{"5", 5 * time.Second},
		{"0", 5 * time.Second},
		{"1", 5 * time.Second},
		{" 45 ", 45 * time.Second},
		{"invalid", 20 * time.Second},
		{"-1", 20 * time.Second},
		{"9223372036854775807", 20 * time.Second},
	} {
		t.Run(test.raw, func(t *testing.T) {
			t.Setenv("OCTOPOOL_RELAY_TIMEOUT_SECONDS", test.raw)
			if got := relayReadTimeout(); got != test.want {
				t.Fatalf("timeout=%s, want %s", got, test.want)
			}
		})
	}
}

func TestGHRelayDefaultRetryBudget(t *testing.T) {
	for _, failure := range []string{"identities_cooling_down", "500", "503", "524"} {
		for _, retries := range []string{"", "0", "3"} {
			t.Run(failure+"/retries="+retries, func(t *testing.T) {
				client, calls := newRelayTestClient(t, func(int64) (int, string) {
					if failure == "identities_cooling_down" {
						return 424, `{"error":{"code":"fallback_local","details":{"reason":"identities_cooling_down"}}}`
					}
					code, _ := strconv.Atoi(failure)
					return code, `{"error":{"code":"internal_error"}}`
				})
				t.Setenv("OCTOPOOL_RELAY_RETRIES", retries)
				sleeps := recordWatchSleeps(t)
				_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/acme/repo"})
				count := 1
				if retries != "" {
					count, _ = strconv.Atoi(retries)
				}
				wantSleeps := make([]time.Duration, count)
				for i := range wantSleeps {
					wantSleeps[i] = time.Second
				}
				if err == nil || isLocalFallback(err) != (failure == "identities_cooling_down") || calls.Load() != int64(count+1) || !reflect.DeepEqual(*sleeps, wantSleeps) {
					t.Fatalf("err=%v calls=%d sleeps=%v", err, calls.Load(), *sleeps)
				}
			})
		}
	}
}

func TestGHRelayTimeoutDoesNotHideHTTPRejection(t *testing.T) {
	for _, status := range []int{401, 403, 424, 503, 524} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
			calls := 0
			useHTTPTestTransport(t, rewritePolicyTestTransport(func(request *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(iotest.ErrReader(context.DeadlineExceeded)), Request: request}, nil
			}))
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "3")
			sleeps := recordWatchSleeps(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"api", "repos/acme/repo"}, &out, &stderr)
			var relay *relayResponseError
			if !errors.As(err, &relay) || relay.Status != status || isLocalFallback(err) || calls != 1 || policies.Load() != 2 || len(*sleeps) != 0 || out.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("err=%v calls=%d policies=%d sleeps=%v out=%q stderr=%q", err, calls, policies.Load(), *sleeps, out.String(), stderr.String())
			}
		})
	}
}

func TestGHRelayClientInvalidAuthFailsClosed(t *testing.T) {
	client, calls := newRelayTestClient(t, func(int64) (int, string) {
		return http.StatusUnauthorized, `{"error":{"code":"invalid_auth","message":"Invalid caller token"}}`
	})
	_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/openclaw"})
	if err == nil || shouldRunRealGH(err) {
		t.Fatalf("expected terminal auth error, got %v", err)
	}
	if _, explicit := explicitRelayFallback(err); explicit {
		t.Fatal("auth reinterpretation must not gain explicit relay fallback provenance")
	}
	var relay *relayResponseError
	if !errors.As(err, &relay) || relay.Code != "invalid_auth" {
		t.Fatalf("auth error = %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d", got)
	}
}

func TestGHRelayClientRetriesTransientFailuresThenSucceeds(t *testing.T) {
	for _, test := range []struct {
		name     string
		failures int64
		status   int
		body     string
	}{
		{
			name:     "transient fallback",
			failures: 1,
			status:   http.StatusFailedDependency,
			body:     `{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"identities_cooling_down"}}}`,
		},
		{
			name:     "typed internal_error",
			failures: 1,
			status:   http.StatusInternalServerError,
			body:     `{"error":{"code":"internal_error","message":"Internal error","request_id":"transient-request"}}`,
		},
		{
			name:     "malformed 502",
			failures: 1,
			status:   http.StatusBadGateway,
			body:     "malformed gateway response",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "")
			useTestRelayRetryDelays(t, time.Millisecond)
			client, calls := newRelayTestClient(t, func(call int64) (int, string) {
				if call <= test.failures {
					return test.status, test.body
				}
				return http.StatusOK, `{"status":200,"body":{"ok":true},"body_encoding":"json"}`
			})

			envelope, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/octopool"})
			if err != nil {
				t.Fatalf("expected retry success, got %v", err)
			}
			if envelope.Status != http.StatusOK {
				t.Fatalf("status = %d", envelope.Status)
			}
			if got, want := calls.Load(), test.failures+1; got != want {
				t.Fatalf("calls = %d, want %d", got, want)
			}
		})
	}
}

func TestGHRelayClientPersistentInternalErrorExhaustsRetries(t *testing.T) {
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "4")
	useTestRelayRetryDelays(t, time.Millisecond)
	client, calls := newRelayTestClient(t, func(call int64) (int, string) {
		requestID := "request-" + strconv.FormatInt(call, 10)
		return http.StatusInternalServerError, `{"error":{"code":"internal_error","message":"Internal error","request_id":"` + requestID + `"}}`
	})

	_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/octopool"})
	var relay *relayResponseError
	if !errors.As(err, &relay) {
		t.Fatalf("expected typed relay error, got %v", err)
	}
	if relay.Status != http.StatusInternalServerError || relay.Code != "internal_error" || relay.RequestID != "request-5" {
		t.Fatalf("relay error = %#v", relay)
	}
	if got := calls.Load(); got != 5 {
		t.Fatalf("calls = %d", got)
	}
	if got := err.Error(); got != "octopool request failed (HTTP 500, internal_error): Internal error (request_id: request-5)" {
		t.Fatalf("error = %q", got)
	}
	if shouldRunRealGH(err) {
		t.Fatal("exhausted relay service error must not fall back to real gh")
	}
}

func TestTransientRelayFailure(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "typed internal 500", err: &relayResponseError{Status: http.StatusInternalServerError, apiError: apiError{Code: "internal_error"}}, want: true},
		{name: "typed internal 400", err: &relayResponseError{Status: http.StatusBadRequest, apiError: apiError{Code: "internal_error"}}},
		{name: "typed config 503", err: &relayResponseError{Status: http.StatusServiceUnavailable, apiError: apiError{Code: "admin_unconfigured"}}},
		{name: "malformed 502", err: &relayResponseError{Status: http.StatusBadGateway}, want: true},
		{name: "malformed 503", err: &relayResponseError{Status: http.StatusServiceUnavailable}, want: true},
		{name: "malformed 504", err: &relayResponseError{Status: http.StatusGatewayTimeout}, want: true},
		{name: "malformed 500", err: &relayResponseError{Status: http.StatusInternalServerError}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := transientRelayFailure(test.err); got != test.want {
				t.Fatalf("transientRelayFailure() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestGHRelayClientCancellationInterruptsRetryBackoff(t *testing.T) {
	useTestRelayRetryDelays(t, time.Minute)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	client, calls := newRelayTestClient(t, func(int64) (int, string) {
		time.AfterFunc(20*time.Millisecond, cancel)
		return http.StatusInternalServerError, `{"error":{"code":"internal_error","message":"Internal error","request_id":"cancel-request"}}`
	})

	_, err := client.do(ctx, ghAPIRequest{method: "GET", path: "/repos/openclaw/octopool"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d", got)
	}
}

func TestGHRelayClientRejectsNonGETRequest(t *testing.T) {
	client := ghRelayClient{token: "token", baseURL: "http://127.0.0.1", pool: "maintainers"}
	_, err := client.do(t.Context(), ghAPIRequest{method: "POST", path: "/repos/openclaw/octopool"})
	if err == nil || err.Error() != `relay client requires GET, got "POST"` {
		t.Fatalf("error = %v", err)
	}
}

func TestGHRelayClientDoesNotRetryStructuralFallback(t *testing.T) {
	client, calls := newRelayTestClient(t, func(int64) (int, string) {
		return http.StatusFailedDependency, `{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"route_denied"}}}`
	})

	_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/openclaw"})
	if !isLocalFallback(err) {
		t.Fatalf("expected local fallback, got %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d", got)
	}
}

func TestGHRelayClientRetriesDisabledByEnv(t *testing.T) {
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	client, calls := newRelayTestClient(t, func(int64) (int, string) {
		return http.StatusFailedDependency, `{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"identities_cooling_down"}}}`
	})

	_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/openclaw"})
	if !isLocalFallback(err) {
		t.Fatalf("expected local fallback, got %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d", got)
	}
}

func TestShouldRunRealGH(t *testing.T) {
	if !shouldRunRealGH(localFallbackError{Reason: "route_denied"}) {
		t.Fatal("fallback_local should run real gh")
	}
	if shouldRunRealGH(errOctopoolNotLoggedIn) {
		t.Fatal("missing octopool login must fail closed")
	}
	if shouldRunRealGH(assertAnError{}) {
		t.Fatal("ordinary errors should not run real gh")
	}
}

func TestNewGHRelayClientMissingLoginUsesFallbackSentinel(t *testing.T) {
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_TOKEN", "")
	_, err := newGHRelayClient()
	if !errors.Is(err, errOctopoolNotLoggedIn) {
		t.Fatalf("err = %v", err)
	}
}

type assertAnError struct{}

func (assertAnError) Error() string {
	return "boom"
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) {
	return len(p), nil
}

func TestTransientFallbackReasons(t *testing.T) {
	for _, reason := range []string{
		"identities_cooling_down", "identity_pool_depleted",
		"github_identity_depleted", "github_rate_limited", "relay_overloaded",
	} {
		if !transientFallbackReason(reason) {
			t.Fatalf("%s should retry before local fallback", reason)
		}
	}
	if transientFallbackReason("route_denied") {
		t.Fatal("route_denied must not retry; it always resolves locally")
	}
}

func useTestRelayRetryDelays(t *testing.T, delays ...time.Duration) {
	t.Helper()
	restore := relayRetryDelays
	relayRetryDelays = delays
	t.Cleanup(func() { relayRetryDelays = restore })
}

func newRelayTestClient(
	t *testing.T,
	respond func(call int64) (status int, body string),
) (ghRelayClient, *atomic.Int64) {
	t.Helper()
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	calls := &atomic.Int64{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveEmptyRewritePolicy(t, w, r, "token", "maintainers") {
			return
		}
		if r.URL.Path != "/v1/github/request" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("unexpected relay request")
			w.WriteHeader(400)
			return
		}
		status, body := respond(calls.Add(1))
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return ghRelayClient{token: "token", baseURL: server.URL, pool: "maintainers"}, calls
}
