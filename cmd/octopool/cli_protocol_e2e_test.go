package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCLIEndToEndRelayProtocol(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)

	t.Run("native_options", func(t *testing.T) {
		for _, test := range []struct {
			name       string
			args       []string
			mode, want string
			policyCode int
		}{
			{"regression_json_jq", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number", "--json=title", "--jq", "(", "--jq", ".number,.title"}, "relay", "7\nsynthetic\n", 200},
			{"regression_invalid_csv_earlier", []string{"pr", "view", "7", "-R", "acme/repo", "--json", `"unterminated`, "--json=number"}, "reject", "", 200},
			{"regression_invalid_limit_earlier", []string{"pr", "list", "-R", "acme/repo", "--json=number", "--limit=08", "--limit=2"}, "reject", "", 200},
			{"regression_empty_json", []string{"pr", "view", "7", "-R", "acme/repo", "--json="}, "delegate", "child stdout\n", 200},
			{"control_cap_delegation", []string{"pr", "list", "-R", "acme/repo", "--json=number", "--limit=101"}, "delegate", "child stdout\n", 200},
			{"control_last_jq", []string{"pr", "view", "7", "-R", "acme/repo", "--json=number,title", "--jq", "(", "--jq", ".number"}, "relay", "7\n", 200},
			{"control_policy_precedence", []string{"pr", "list", "-R", "acme/repo", "--json", `"unterminated`, "--limit=08"}, "reject", "", 401},
			{"regression_run_duration_delegation", []string{"run", "watch", "42", "-R", "acme/repo", "--interval=9223372037"}, "delegate", "child stdout\n", 200},
		} {
			t.Run(test.name, func(t *testing.T) {
				if strings.Contains(test.name, "jq") && !jqAvailable() {
					t.Skip("jq not installed")
				}
				var paths []string
				data := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					paths = append(paths, r.URL.Path)
					if r.URL.Path == "/v1/pools/maintainers/string-rewrites" && test.policyCode != 200 {
						w.WriteHeader(test.policyCode)
						return
					}
					if serveEmptyRewritePolicy(t, w, r, "test-token", "maintainers") {
						return
					}
					req := decodeCLIRequest(t, w, r)
					data++
					writeCLIEnvelope(t, w, nativeOptionsResponse(t, req))
				}))
				t.Cleanup(server.Close)
				capture := captureRewriteGH(t)
				result := runCLI(t, bin, server.URL, nil, append([]string{"gh"}, test.args...)...)
				_, childErr := os.Stat(capture)
				if test.mode == "reject" {
					if result.err == nil || result.stdout != "" || data != 0 || !os.IsNotExist(childErr) {
						t.Fatalf("invalid input err=%v data=%d child=%v output=%q stderr=%q", result.err, data, childErr, result.stdout, result.stderr)
					}
					if test.policyCode != 200 && (len(paths) != 1 || !strings.Contains(result.stderr, errRewritePolicy.Error())) {
						t.Fatalf("policy precedence paths=%v stderr=%q", paths, result.stderr)
					}
					return
				}
				wantData := 1
				if test.mode == "delegate" {
					wantData = 0
				}
				if result.err != nil || result.stdout != test.want || data != wantData {
					t.Fatalf("err=%v data=%d want=%d output=%q want=%q stderr=%q", result.err, data, wantData, result.stdout, test.want, result.stderr)
				}
				if test.mode == "delegate" {
					got := readRewriteCapture(t, capture)
					if !reflect.DeepEqual(got.Args, test.args) {
						t.Fatalf("handoff argv=%q want=%q", got.Args, test.args)
					}
				} else if !os.IsNotExist(childErr) {
					t.Fatal("relay output ran native child")
				}
			})
		}
	})

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
		{name: "mixed", status: "completed", conclusion: "failure", wantExit: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newPRChecksFixture()
			fixture.checks[0].(map[string]any)["status"] = test.status
			fixture.checks[0].(map[string]any)["conclusion"] = test.conclusion
			if test.name == "mixed" {
				pending := prChecksCheck(2, "pending", "queued", "")
				pending["started_at"] = "2026-09-01T00:00:00Z"
				fixture.checks = append(fixture.checks, pending)
			}
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				body := decodeCLIRequest(t, w, r)
				if body == nil {
					return
				}
				writeCLIEnvelope(t, w, fixture.response(t, body))
			})
			for _, mode := range []struct{ name, filter, want string }{
				{"json", "", ""}, {"jq-string", ".[0].name", "unit\n"},
				{"jq-false", "false", "false\n"}, {"jq-null", "null", "null\n"},
				{"jq-empty", "empty", ""}, {"jq-error", ".[", ""}, {"human", "", ""},
			} {
				t.Run(mode.name, func(t *testing.T) {
					args := []string{"gh", "pr", "checks", "7", "-R", "acme/repo"}
					if mode.name != "human" {
						args = append(args, "--json", "name,state,bucket")
					}
					if mode.filter != "" {
						if !jqAvailable() {
							t.Fatal("focused proof requires jq")
						}
						args = append(args, "--jq", mode.filter)
					}
					result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_NO_FALLBACK": "1", "OCTOPOOL_RELAY_RETRIES": "0"}, args...)
					if mode.name == "human" {
						var exitErr *exec.ExitError
						if !errors.As(result.err, &exitErr) || exitErr.ExitCode() != test.wantExit || result.stderr != "" || !strings.Contains(result.stdout, "unit\t") {
							t.Fatalf("human outcome exit: err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
						}
						return
					}
					if mode.name == "jq-error" {
						if result.err == nil || result.stdout != "" {
							t.Fatalf("jq error lost: %+v", result)
						}
						return
					}
					if result.err != nil || result.stderr != "" {
						t.Errorf("successful export must exit 0 regardless of outcome: err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
					}
					if mode.name == "json" {
						if !strings.Contains(result.stdout, `"name":"unit"`) {
							t.Errorf("stdout=%q", result.stdout)
						}
					} else if result.stdout != mode.want {
						t.Errorf("stdout=%q want=%q", result.stdout, mode.want)
					}
				})
			}
		})
	}
}

func TestCLIEndToEndChecksEmptyBeforeExport(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	for _, mode := range []string{"human", "json", "jq-sentinel", "watch"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newPRChecksFixture()
			fixture.checks = []any{}
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				writeCLIEnvelope(t, w, fixture.response(t, decodeCLIRequest(t, w, r)))
			})
			args := []string{"gh", "pr", "checks", "7", "-R", "acme/repo"}
			switch mode {
			case "json":
				args = append(args, "--json", "name")
			case "jq-sentinel":
				args = append(args, "--json", "name", "--jq", `"should-not-export"`)
			case "watch":
				args = append(args, "--watch")
			}
			result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_NO_FALLBACK": "1", "OCTOPOOL_RELAY_RETRIES": "0"}, args...)
			if mode != "watch" && len(fixture.requests) != 3 {
				t.Errorf("actual empty acquisition must use exactly 3 data operations: %d", len(fixture.requests))
			}
			var exitErr *exec.ExitError
			if !errors.As(result.err, &exitErr) || exitErr.ExitCode() != 1 || result.stdout != "" || result.stderr != "no checks reported on the 'feature' branch\n" {
				t.Fatalf("empty must fail before output with exact branch diagnostic once: err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
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

func TestGHShimProtocolRewritePolicyDiagnostics(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	wrapper := filepath.Join(t.TempDir(), executableName("gh"))
	binary, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wrapper, binary, 0755); err != nil {
		t.Fatal(err)
	}
	for _, local := range []bool{false, true} {
		name, class, code := "HTTP403", "http_status", 403
		if local {
			name, class, code = "local validation", "local_validation", 200
		}
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/pools/maintainers/string-rewrites" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer synthetic-token-secret" {
					t.Error("unexpected dispatch")
				}
				w.Header().Set("CF-Ray", "0123456789abcdef-SJC")
				w.Header().Set("X-Private", "synthetic-header-secret")
				w.WriteHeader(code)
				if local {
					_, _ = io.WriteString(w, rewriteEmptyTestPolicy)
				} else {
					_, _ = io.WriteString(w, "synthetic-response-secret")
				}
			}))
			t.Cleanup(server.Close)
			extra := map[string]string{"OCTOPOOL_TOKEN": "synthetic-token-secret", "OCTOPOOL_RELAY_RETRIES": "2"}
			path := filepath.Join(t.TempDir(), "synthetic-path-secret.json")
			if local {
				if err := os.WriteFile(path, []byte(`{"schema_version":1,"rules":[{"pattern":"[synthetic-pattern-secret","replacement":"synthetic-value-secret"}]}`), 0600); err != nil {
					t.Fatal(err)
				}
				extra["OCTOPOOL_STRING_REWRITE_FILE"] = path
			}
			capture := captureRewriteGH(t)
			started := time.Now()
			result := runCLI(t, wrapper, server.URL, extra, "pr", "view", "7", "-R", "acme/repo", "--json=number")
			var exit *exec.ExitError
			if !errors.As(result.err, &exit) || exit.ExitCode() != 1 || result.stdout != "" || calls.Load() != 1 {
				t.Fatalf("policy error protocol: %+v calls=%d", result, calls.Load())
			}
			pattern := `\Aerror: string rewrite policy unavailable or invalid \(class=` + class + ` attempt_utc=([^ ]+Z) elapsed_ms=([0-9]+) http_status=` + strconv.Itoa(code) + ` cf_ray=0123456789abcdef-SJC\)\n\z`
			matches := regexp.MustCompile(pattern).FindStringSubmatch(result.stderr)
			if matches == nil {
				t.Fatalf("unexpected stderr: %q", result.stderr)
			}
			attempt, err := time.Parse(time.RFC3339Nano, matches[1])
			if err != nil || attempt.Before(started) || attempt.After(time.Now()) {
				t.Fatal("invalid UTC attempt")
			}
			for _, secret := range []string{path, server.URL, "synthetic-token-secret", "synthetic-header-secret", "synthetic-response-secret", "synthetic-pattern-secret", "synthetic-value-secret"} {
				if strings.Contains(result.stderr, secret) {
					t.Fatal("shim exposed sensitive fixture")
				}
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("policy failure reached native gh")
			}
		})
	}
}
