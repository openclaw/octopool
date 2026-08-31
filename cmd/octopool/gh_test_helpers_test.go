package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type relayTestResponse struct {
	Body    any
	Headers map[string]string
	Status  int
}

func relayTestServer(t *testing.T, responseBody func(map[string]any) any) {
	t.Helper()
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	t.Setenv("OCTOPOOL_POOL", "maintainers")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveEmptyRewritePolicy(t, w, r, "test-token", "maintainers") {
			return
		}
		if r.URL.Path != "/v1/github/request" || r.Method != "POST" {
			http.Error(w, "unexpected relay path", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "unexpected relay authorization", http.StatusUnauthorized)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		envelope := relayEnvelope{
			Status:       200,
			BodyEncoding: "json",
		}
		fixture := responseBody(body)
		if response, ok := fixture.(relayTestResponse); ok {
			if response.Status != 0 {
				for key, value := range response.Headers {
					w.Header().Set(key, value)
				}
				w.WriteHeader(response.Status)
				if err := json.NewEncoder(w).Encode(response.Body); err != nil {
					t.Errorf("write relay error fixture: %v", err)
				}
				return
			}
			fixture = response.Body
			envelope.Headers = response.Headers
		}
		raw, err := json.Marshal(fixture)
		if err != nil {
			t.Errorf("marshal relay fixture: %v", err)
			http.Error(w, "invalid fixture body", http.StatusInternalServerError)
			return
		}
		envelope.Body = raw
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(envelope); err != nil {
			t.Errorf("write relay fixture: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OCTOPOOL_URL", server.URL)
}

// Explicitly emulate the authoritative empty deployment policy for legacy
// dispatch fixtures. This is an HTTP route, never a production/test bypass.
func serveEmptyRewritePolicy(t *testing.T, w http.ResponseWriter, r *http.Request, token, pool string) bool {
	t.Helper()
	if r.URL.Path != "/v1/pools/"+pool+"/string-rewrites" {
		return false
	}
	if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cache-Control") != "no-cache, no-store" {
		t.Errorf("unexpected policy request method/auth/cache directive")
		w.WriteHeader(http.StatusBadRequest)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[]}`))
	return true
}

func emptyRewriteTestServer(t *testing.T) {
	t.Helper()
	relayTestServer(t, func(map[string]any) any { t.Error("unexpected relay request"); return nil })
}
