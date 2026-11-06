package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizeBaseURLDefaultsSchemeAndDropsQuery(t *testing.T) {
	got, err := normalizeBaseURL("octopool.example.com/path/?x=1#frag")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://octopool.example.com/path" {
		t.Fatalf("normalizeBaseURL() = %q", got)
	}
}

func TestDiscoverLoginServerUsesDefaultPool(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/octopool" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"service":"octopool","version":1,"api_base":"` + server.URL + `","app_base":"` + server.URL + `","default_pool":"core","allowed_org":"acme","auth":{"cli_github_token":true,"web_login":true}}`))
	}))
	defer server.Close()

	resolved, err := discoverLoginServer(t.Context(), server.URL, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.APIBase != server.URL || resolved.Pool != "core" {
		t.Fatalf("resolved = %#v", resolved)
	}
}

func TestDiscoverLoginServerRejectsCrossHostAPIBaseByDefault(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"service":"octopool","version":1,"api_base":"https://api.example.com","default_pool":"core","auth":{"cli_github_token":true}}`))
	}))
	defer server.Close()

	_, err := discoverLoginServer(t.Context(), server.URL, "", false)
	if err == nil || !strings.Contains(err.Error(), "--trust-discovery-redirect") {
		t.Fatalf("expected trust redirect error, got %v", err)
	}
	if _, err := discoverLoginServer(t.Context(), server.URL, "", true); err != nil {
		t.Fatal(err)
	}
}
