package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestURLPathEscapesPoolSegment(t *testing.T) {
	for _, tt := range []struct{ pool, want string }{
		{"maintainers", "maintainers"},
		{"team/ci", "team%2Fci"},
		{"team?debug=1", "team%3Fdebug=1"},
		{"team#night", "team%23night"},
		{"team%2Fops", "team%252Fops"},
		{"team space", "team%20space"},
		{"team+ops", "team+ops"},
		{"雪", "%E9%9B%AA"},
	} {
		t.Run(tt.pool, func(t *testing.T) {
			if got := urlPath(tt.pool); got != tt.want {
				t.Fatalf("urlPath(%q) = %q, want %q", tt.pool, got, tt.want)
			}
		})
	}
}

func TestPoolCommandsPreservePathAndQuery(t *testing.T) {
	for _, tt := range []struct {
		name, method, path, query string
		run                       func(context.Context, []string, io.Writer) error
		args                      []string
	}{
		{"health", "GET", "/v1/pools/team%2Fa%3Fb%23c/health", "capacity=1", runHealth,
			[]string{"--capacity", "--token-env", "OCTOPOOL_TEST_POOL_TOKEN"}},
		{"stats", "GET", "/v1/pools/team%2Fa%3Fb%23c/stats", "since=30m", runStats,
			[]string{"--json", "--since", "30m", "--token-env", "OCTOPOOL_TEST_POOL_TOKEN"}},
		{"identity", "POST", "/v1/admin/pools/team%2Fa%3Fb%23c/identities", "", runAdminIdentity,
			[]string{"--id", "primary", "--login", "octo", "--secret-ref", "TEST_PAT", "--admin-token-env", "OCTOPOOL_TEST_POOL_TOKEN"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_TEST_POOL_TOKEN", "synthetic-token")
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != tt.method || r.URL.EscapedPath() != tt.path || r.URL.RawQuery != tt.query {
					t.Errorf("request = %s %s?%s, want %s %s?%s", r.Method, r.URL.EscapedPath(), r.URL.RawQuery, tt.method, tt.path, tt.query)
				}
				if r.Header.Get("Authorization") != "Bearer synthetic-token" {
					t.Error("missing expected authorization")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, "{}")
			}))
			defer server.Close()
			args := append([]string{"--url", server.URL, "--pool", "team/a?b#c"}, tt.args...)
			if err := tt.run(t.Context(), args, io.Discard); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatalf("requests = %d, want 1", calls.Load())
			}
		})
	}
}
