package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCLIEndToEndServiceCommands(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)

	t.Run("health", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/v1/pools/maintainers/health" {
				http.Error(w, "unexpected health request", http.StatusBadRequest)
				t.Errorf("request = %s %s", r.Method, r.URL.Path)
				return
			}
			if r.Header.Get("Authorization") != "Bearer test-token" {
				http.Error(w, "unexpected authorization", http.StatusUnauthorized)
				t.Errorf("authorization = %q", r.Header.Get("Authorization"))
				return
			}
			writeCommandJSON(t, w, map[string]any{"status": "ok"})
		}))
		t.Cleanup(server.Close)

		result := runCLI(t, bin, server.URL, nil, "health")
		if result.err != nil || !strings.Contains(result.stdout, `"status": "ok"`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("stats client filter", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/v1/pools/maintainers/stats" {
				http.Error(w, "unexpected stats request", http.StatusBadRequest)
				t.Errorf("request = %s %s", r.Method, r.URL.Path)
				return
			}
			if r.URL.Query().Get("since") != "24h" || r.URL.Query().Get("client") != "ci-runner" {
				http.Error(w, "unexpected stats query", http.StatusBadRequest)
				t.Errorf("query = %q", r.URL.RawQuery)
				return
			}
			writeCommandJSON(t, w, map[string]any{
				"pool":          "maintainers",
				"operator":      map[string]any{"client_name": "test-mac"},
				"client_filter": "ci-runner",
				"client_usage":  map[string]any{"requests": 3, "saved_github_requests": 2, "backend_requests": 1},
			})
		}))
		t.Cleanup(server.Close)

		result := runCLI(t, bin, server.URL, nil, "stats", "-client", "ci-runner")
		if result.err != nil ||
			!strings.Contains(result.stdout, "client: test-mac\nclient filter: ci-runner\n") ||
			!strings.Contains(result.stdout, "ci-runner: 3 requests, 2 saved, 1 backend") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("request forwards options", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/v1/github/request" {
				http.Error(w, "unexpected relay request", http.StatusBadRequest)
				t.Errorf("request = %s %s", r.Method, r.URL.Path)
				return
			}
			body := decodeCommandJSON(t, w, r)
			query, _ := body["query"].(map[string]any)
			headers, _ := body["headers"].(map[string]any)
			hints, _ := body["route_hint"].(map[string]any)
			if body["pool"] != "maintainers" || body["method"] != "GET" || body["path"] != "/repos/openclaw/octopool" || query["page"] != "2" || headers["accept"] != "application/json" || hints["pr_state"] != "open" {
				http.Error(w, "unexpected request body", http.StatusBadRequest)
				t.Errorf("body = %#v", body)
				return
			}
			writeCommandJSON(t, w, map[string]any{"relayed": true})
		}))
		t.Cleanup(server.Close)

		result := runCLI(t, bin, server.URL, nil,
			"request",
			"--path", "/repos/openclaw/octopool",
			"--query", "page=2",
			"--header", "accept=application/json",
			"--route-hint", "pr_state=open",
		)
		if result.err != nil || !strings.Contains(result.stdout, `"relayed": true`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("admin caller", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/v1/admin/callers" || r.Header.Get("Authorization") != "Bearer admin-token" {
				http.Error(w, "unexpected admin caller request", http.StatusBadRequest)
				t.Errorf("request = %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
				return
			}
			body := decodeCommandJSON(t, w, r)
			if body["pool"] != "maintainers" || body["github_login"] != "alice" || body["name"] != "Alice" {
				http.Error(w, "unexpected caller body", http.StatusBadRequest)
				t.Errorf("body = %#v", body)
				return
			}
			writeCommandJSON(t, w, map[string]any{"created": true})
		}))
		t.Cleanup(server.Close)

		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_ADMIN_TOKEN": "admin-token"},
			"admin", "caller", "--github-login", "alice", "--name", "Alice",
		)
		if result.err != nil || !strings.Contains(result.stdout, `"created": true`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("admin github app identity scopes", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/v1/admin/pools/maintainers/identities" || r.Header.Get("Authorization") != "Bearer admin-token" {
				http.Error(w, "unexpected admin identity request", http.StatusBadRequest)
				t.Errorf("request = %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
				return
			}
			body := decodeCommandJSON(t, w, r)
			if body["id"] != "app" || body["login"] != "octopool-app" || body["secret_ref"] != "APP_KEY" || body["kind"] != "github_app" || body["installation_id"] != float64(42) {
				http.Error(w, "unexpected identity body", http.StatusBadRequest)
				t.Errorf("body = %#v", body)
				return
			}
			scopes, ok := body["scopes"].([]any)
			if !ok || len(scopes) != 2 {
				http.Error(w, "unexpected scopes", http.StatusBadRequest)
				t.Errorf("scopes = %#v", body["scopes"])
				return
			}
			ownerScope, _ := scopes[0].(map[string]any)
			repoScope, _ := scopes[1].(map[string]any)
			if ownerScope["owner"] != "openclaw" || ownerScope["allow_private"] != true || repoScope["owner"] != "openclaw" || repoScope["repo"] != "octopool" || repoScope["allow_private"] != true {
				http.Error(w, "unexpected scope policy", http.StatusBadRequest)
				t.Errorf("scopes = %#v", scopes)
				return
			}
			writeCommandJSON(t, w, map[string]any{"created": true})
		}))
		t.Cleanup(server.Close)

		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_ADMIN_TOKEN": "admin-token"},
			"admin", "identity",
			"--id", "app",
			"--login", "octopool-app",
			"--secret-ref", "APP_KEY",
			"--kind", "github_app",
			"--installation-id", "42",
			"--private-scopes",
			"--scope", "openclaw",
			"--scope", "openclaw/octopool",
		)
		if result.err != nil || !strings.Contains(result.stdout, `"created": true`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("admin owner scope stays public by default", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body := decodeCommandJSON(t, w, r)
			scopes, _ := body["scopes"].([]any)
			if len(scopes) != 1 {
				http.Error(w, "unexpected scopes", http.StatusBadRequest)
				t.Errorf("scopes = %#v", body["scopes"])
				return
			}
			scope, _ := scopes[0].(map[string]any)
			if scope["owner"] != "openclaw" || scope["allow_private"] != false {
				http.Error(w, "unexpected public scope", http.StatusBadRequest)
				t.Errorf("scope = %#v", scope)
				return
			}
			writeCommandJSON(t, w, map[string]any{"created": true})
		}))
		t.Cleanup(server.Close)

		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_ADMIN_TOKEN": "admin-token"},
			"admin", "identity",
			"--id", "pat",
			"--login", "octopool-pat",
			"--secret-ref", "PAT",
			"--scope", "openclaw",
		)
		if result.err != nil {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("github app requires installation id", func(t *testing.T) {
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{"OCTOPOOL_ADMIN_TOKEN": "admin-token"},
			"admin", "identity",
			"--id", "app",
			"--login", "octopool-app",
			"--secret-ref", "APP_KEY",
			"--kind", "github_app",
		)
		if result.err == nil || !strings.Contains(result.stderr, "--installation-id is required") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})
}

func decodeCommandJSON(t *testing.T, w http.ResponseWriter, r *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		t.Errorf("decode request: %v", err)
		return nil
	}
	return body
}

func writeCommandJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Errorf("write response: %v", err)
	}
}
