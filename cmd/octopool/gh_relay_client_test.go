package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

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
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_RELAY_RETRIES", test.raw)
			if got := relayRetryAttempts(); got != test.want {
				t.Fatalf("relayRetryAttempts() = %d, want %d", got, test.want)
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
			failures: 2,
			status:   http.StatusFailedDependency,
			body:     `{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"identities_cooling_down"}}}`,
		},
		{
			name:     "typed internal_error",
			failures: 2,
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
			useTestRelayRetryDelays(t, time.Millisecond, time.Millisecond)
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
