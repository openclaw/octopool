package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestCLIEndToEndRelayProtocol(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)

	t.Run("direct api forwards query and headers and decodes text", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
			body := decodeCLIRequest(t, w, r)
			if body == nil {
				return
			}
			if body["path"] != "/repos/openclaw/octopool/contents/README.md" {
				http.Error(w, "unexpected relay path", http.StatusBadRequest)
				return
			}
			query, _ := body["query"].(map[string]any)
			headers, _ := body["headers"].(map[string]any)
			if query["ref"] != "main" || headers["accept"] != "application/vnd.github.raw+json" {
				http.Error(w, "query/header forwarding mismatch", http.StatusBadRequest)
				return
			}
			writeRawCLIEnvelope(t, w, 200, "text", "hello from relay")
		})
		result := runCLI(t, bin, server.URL, nil,
			"gh", "api", "repos/openclaw/octopool/contents/README.md?ref=main",
			"-H", "Accept: application/vnd.github.raw+json",
		)
		if result.err != nil || result.stdout != "hello from relay\n" {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("decodes base64 response", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			writeRawCLIEnvelope(t, w, 200, "base64", "AAEC")
		})
		result := runCLI(t, bin, server.URL, nil, "gh", "api", "repos/openclaw/octopool")
		if result.err != nil || result.stdout != string([]byte{0, 1, 2})+"\n" {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	for _, encoding := range []string{"", "yaml"} {
		name := "rejects unknown encoding"
		if encoding == "" {
			name = "rejects missing encoding"
		}
		t.Run(name, func(t *testing.T) {
			server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
				writeRawCLIEnvelope(t, w, 200, encoding, map[string]any{"unsafe": true})
			})
			result := runCLI(t, bin, server.URL, nil, "gh", "api", "repos/openclaw/octopool")
			if result.err == nil || result.stdout != "" {
				t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
			}
		})
	}

	t.Run("preserves upstream GitHub error body and failure", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			writeRawCLIEnvelope(t, w, 404, "json", map[string]any{"message": "Not Found"})
		})
		result := runCLI(t, bin, server.URL, nil, "gh", "api", "repos/openclaw/missing")
		if result.err == nil || !strings.Contains(result.stdout, `"message":"Not Found"`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("auth failure does not delegate to real gh", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_auth","message":"expired"}}`))
		})
		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_GH_PATH": fakeGH(t)},
			"gh", "api", "repos/openclaw/octopool",
		)
		if result.err == nil || result.stdout != "" || !strings.Contains(result.stderr, "invalid_auth") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("real gh exit code passes through", func(t *testing.T) {
		fake := fakeGHWithExit(t, 7)
		server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected relay dispatch") })
		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_GH_PATH": fake},
			"gh", "alias", "list",
		)
		var exitErr *exec.ExitError
		if !errors.As(result.err, &exitErr) || exitErr.ExitCode() != 7 {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})
}

func TestCLIEndToEndCheckExitCodes(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	tests := []struct {
		name       string
		status     string
		conclusion any
		wantExit   int
	}{
		{name: "failed", status: "completed", conclusion: "failure", wantExit: 1},
		{name: "pending", status: "in_progress", conclusion: nil, wantExit: 8},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				body := decodeCLIRequest(t, w, r)
				if body == nil {
					return
				}
				switch body["path"] {
				case "/repos/openclaw/octopool/pulls/7":
					writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": "abc123"}})
				case "/repos/openclaw/octopool/commits/abc123/check-runs":
					writeCLIEnvelope(t, w, map[string]any{"total_count": 1, "check_runs": []map[string]any{{
						"id": 1, "name": "CI", "status": test.status, "conclusion": test.conclusion,
					}}})
				case "/repos/openclaw/octopool/commits/abc123/status":
					writeCLIEnvelope(t, w, map[string]any{"total_count": 0, "statuses": []any{}})
				default:
					http.Error(w, "unexpected checks path", http.StatusBadRequest)
				}
			})
			result := runCLI(t, bin, server.URL, nil,
				"gh", "pr", "checks", "7", "-R", "openclaw/octopool", "--json", "name,state,bucket",
			)
			var exitErr *exec.ExitError
			if !errors.As(result.err, &exitErr) || exitErr.ExitCode() != test.wantExit {
				t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
			}
			if !strings.Contains(result.stdout, `"name":"CI"`) {
				t.Fatalf("stdout=%q", result.stdout)
			}
		})
	}
}

func decodeCLIRequest(t *testing.T, w http.ResponseWriter, r *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		t.Errorf("decode relay request: %v", err)
		return nil
	}
	return body
}

func writeRawCLIEnvelope(
	t *testing.T,
	w http.ResponseWriter,
	status int,
	encoding string,
	body any,
) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Errorf("marshal CLI envelope: %v", err)
		http.Error(w, "invalid fixture body", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(relayEnvelope{
		Status: status, Body: raw, BodyEncoding: encoding,
	}); err != nil {
		t.Errorf("write CLI envelope: %v", err)
	}
}

func fakeGHWithExit(t *testing.T, code int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	path := filepath.Join(t.TempDir(), executableName("fake-gh-exit"))
	content := "#!/bin/sh\nexit " + strconv.Itoa(code) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
