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

func TestDiscoverLoginServerPoolPrecedence(t *testing.T) {
	for _, test := range []struct {
		name        string
		override    string
		environment string
		advertised  string
		want        string
	}{
		{"explicit", "flag-pool", "env-pool", "server-pool", "flag-pool"},
		{"environment", "", "env-pool", "server-pool", "env-pool"},
		{"discovery", "", "", "server-pool", "server-pool"},
		{"fallback", "", "", "", "maintainers"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_POOL", test.environment)
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/.well-known/octopool" {
					t.Errorf("unexpected path %s", r.URL.Path)
					http.NotFound(w, r)
					return
				}
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(`{"service":"octopool","version":1,"api_base":"` + server.URL + `","default_pool":"` + test.advertised + `","auth":{"cli_github_token":true}}`))
			}))
			t.Cleanup(server.Close)

			resolved, err := discoverLoginServer(t.Context(), server.URL, test.override, false)
			if err != nil {
				t.Fatal(err)
			}
			if resolved.APIBase != server.URL || resolved.Pool != test.want {
				t.Fatalf("resolved = %#v, want pool %q", resolved, test.want)
			}
		})
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
