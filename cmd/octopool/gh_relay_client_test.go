package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
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
	err, ok := parseLocalFallback([]byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"route_denied"}}}`))
	if !ok {
		t.Fatal("expected fallback")
	}
	if err.Reason != "route_denied" {
		t.Fatalf("reason = %q", err.Reason)
	}
}

func TestGHRelayClientInvalidAuthUsesLocalFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"invalid_auth","message":"Invalid caller token"}}`))
	}))
	t.Cleanup(server.Close)

	client := ghRelayClient{token: "stale", baseURL: server.URL, pool: "maintainers"}
	_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/openclaw"})
	if !isLocalFallback(err) {
		t.Fatalf("expected local fallback, got %v", err)
	}
}

func TestGHRelayClientRetriesTransientFallback(t *testing.T) {
	restoreDelays := relayRetryDelays
	relayRetryDelays = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() { relayRetryDelays = restoreDelays })

	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusFailedDependency)
			_, _ = w.Write([]byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"identities_cooling_down"}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":200,"body":{"ok":true},"body_encoding":"json"}`))
	}))
	t.Cleanup(server.Close)

	client := ghRelayClient{token: "token", baseURL: server.URL, pool: "maintainers"}
	envelope, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/openclaw"})
	if err != nil {
		t.Fatalf("expected retry success, got %v", err)
	}
	if envelope.Status != 200 {
		t.Fatalf("status = %d", envelope.Status)
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("calls = %d", got)
	}
}

func TestGHRelayClientDoesNotRetryStructuralFallback(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusFailedDependency)
		_, _ = w.Write([]byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"route_denied"}}}`))
	}))
	t.Cleanup(server.Close)

	client := ghRelayClient{token: "token", baseURL: server.URL, pool: "maintainers"}
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
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusFailedDependency)
		_, _ = w.Write([]byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"identities_cooling_down"}}}`))
	}))
	t.Cleanup(server.Close)

	client := ghRelayClient{token: "token", baseURL: server.URL, pool: "maintainers"}
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
	if !shouldRunRealGH(errOctopoolNotLoggedIn) {
		t.Fatal("missing octopool login should run real gh")
	}
	if shouldRunRealGH(assertAnError{}) {
		t.Fatal("ordinary errors should not run real gh")
	}
}

func TestNewGHRelayClientMissingLoginUsesFallbackSentinel(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
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
