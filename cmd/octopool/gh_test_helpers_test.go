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
}

func relayTestServer(t *testing.T, responseBody func(map[string]any) any) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	t.Setenv("OCTOPOOL_POOL", "maintainers")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/github/request" {
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
