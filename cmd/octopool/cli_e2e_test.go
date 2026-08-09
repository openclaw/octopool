package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCLIEndToEndRelayAndFallback(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)

	t.Run("relay response through octopool gh", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if body["path"] != "/repos/openclaw/octopool" {
				http.Error(w, "unexpected relay path", http.StatusBadRequest)
				return
			}
			writeCLIEnvelope(t, w, map[string]any{
				"name": "octopool", "full_name": "openclaw/octopool", "private": false,
			})
		})
		result := runCLI(t, bin, server.URL, nil, "gh", "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if result.err != nil || !strings.Contains(result.stdout, `"nameWithOwner":"openclaw/octopool"`) {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("gh argv wrapper mode", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			writeCLIEnvelope(t, w, map[string]any{"name": "octopool", "full_name": "openclaw/octopool"})
		})
		wrapper := filepath.Join(t.TempDir(), executableName("gh"))
		binary, err := os.ReadFile(bin)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(wrapper, binary, 0o755); err != nil {
			t.Fatal(err)
		}
		result := runCLI(t, wrapper, server.URL, nil, "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if result.err != nil || !strings.Contains(result.stdout, "openclaw/octopool") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("unsupported command delegates to real gh", func(t *testing.T) {
		fake := fakeGH(t)
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{"OCTOPOOL_GH_PATH": fake}, "gh", "alias", "list")
		if result.err != nil || strings.TrimSpace(result.stdout) != "real-gh:alias list" {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("auth status survives a depleted REST scope probe", func(t *testing.T) {
		fake := fakeGHAuthStatus(t, true)
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{
			"OCTOPOOL_GH_PATH": fake,
			"GITHUB_TOKEN":     "test-token",
		}, "gh", "auth", "status", "--active", "--hostname", "github.com")
		if result.err != nil ||
			!strings.Contains(result.stdout, "Logged in to github.com account monalisa (GITHUB_TOKEN)") ||
			!strings.Contains(result.stdout, "do not re-authenticate") ||
			strings.Contains(result.stderr, "token in GITHUB_TOKEN is invalid") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("auth status preserves a genuinely invalid token failure", func(t *testing.T) {
		fake := fakeGHAuthStatus(t, false)
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{
			"OCTOPOOL_GH_PATH": fake,
		}, "gh", "auth", "status", "--active", "--hostname", "github.com")
		if result.err == nil || !strings.Contains(result.stderr, "The token in keyring is invalid.") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("broad auth status preserves failure while diagnosing the active token", func(t *testing.T) {
		fake := fakeGHAuthStatus(t, true)
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{
			"OCTOPOOL_GH_PATH": fake,
		}, "gh", "auth", "status", "--hostname", "github.com")
		if result.err == nil ||
			!strings.Contains(result.stderr, "The token in keyring is invalid.") ||
			!strings.Contains(result.stderr, "do not re-authenticate") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("formatted auth status preserves the real CLI contract", func(t *testing.T) {
		fake := fakeGHAuthStatus(t, true)
		result := runCLI(t, bin, "http://127.0.0.1:1", map[string]string{
			"OCTOPOOL_GH_PATH": fake,
		}, "gh", "auth", "status", "--active", "--hostname", "github.com", "--template", "{{.}}")
		if result.err == nil ||
			strings.Contains(result.stdout, "Logged in to") ||
			!strings.Contains(result.stderr, "do not re-authenticate") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
	})

	t.Run("server fallback delegates unless disabled", func(t *testing.T) {
		server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusFailedDependency)
			_, _ = w.Write([]byte(`{"error":{"code":"fallback_local","message":"run locally","details":{"reason":"route_denied"}}}`))
		})
		fake := fakeGH(t)
		result := runCLI(t, bin, server.URL, map[string]string{"OCTOPOOL_GH_PATH": fake}, "gh", "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if result.err != nil || !strings.Contains(result.stdout, "real-gh:repo view") || !strings.Contains(result.stderr, "falling back") {
			t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
		}
		disabled := runCLI(t, bin, server.URL, map[string]string{
			"OCTOPOOL_GH_PATH": fake, "OCTOPOOL_NO_FALLBACK": "1",
		}, "gh", "repo", "view", "-R", "openclaw/octopool", "--json", "nameWithOwner")
		if disabled.err == nil || strings.Contains(disabled.stdout, "real-gh:") {
			t.Fatalf("err=%v stdout=%q stderr=%q", disabled.err, disabled.stdout, disabled.stderr)
		}
	})

	const boundary = "octopool: relay requested local fallback (relay_overloaded); continuing watch with real gh\n"
	for _, command := range []struct {
		name     string
		args     []string
		exitCode int
		serve    func(*testing.T, map[string]any, http.ResponseWriter)
	}{
		{
			name:     "run watch exit 0",
			args:     []string{"gh", "run", "watch", "42", "-R", "openclaw/octopool", "--exit-status", "-i", "5"},
			exitCode: 0,
			serve: func(t *testing.T, body map[string]any, w http.ResponseWriter) {
				headers, _ := body["headers"].(map[string]any)
				if headers["cache-control"] == "max-age=0" {
					writeCLIFallback(t, w, "relay_overloaded")
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 1})
			},
		},
		{
			name:     "pr checks watch exit 7",
			args:     []string{"gh", "pr", "checks", "7", "-R", "openclaw/octopool", "--watch", "--interval=5"},
			exitCode: 7,
			serve: func(t *testing.T, body map[string]any, w http.ResponseWriter) {
				path := body["path"].(string)
				switch {
				case strings.HasSuffix(path, "/pulls/7"):
					headers, _ := body["headers"].(map[string]any)
					if headers["cache-control"] == "max-age=0" {
						writeCLIFallback(t, w, "relay_overloaded")
						return
					}
					writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": "abc1234"}})
				case strings.HasSuffix(path, "/check-runs"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 1, "check_runs": []map[string]any{{"name": "CI", "status": "completed", "conclusion": "success"}}})
				case strings.HasSuffix(path, "/status"):
					writeCLIEnvelope(t, w, map[string]any{"total_count": 0, "statuses": []any{}})
				default:
					t.Fatalf("unexpected path %q", path)
				}
			},
		},
	} {
		t.Run(command.name, func(t *testing.T) {
			fake := fakeGHExit(t, command.exitCode)
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				command.serve(t, body, w)
			})
			result := runCLI(t, bin, server.URL, map[string]string{
				"OCTOPOOL_GH_PATH":       fake,
				"OCTOPOOL_RELAY_RETRIES": "0",
			}, command.args...)
			if command.exitCode == 0 {
				if result.err != nil {
					t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
				}
			} else {
				var exitErr *exec.ExitError
				if !errors.As(result.err, &exitErr) || exitErr.ExitCode() != command.exitCode {
					t.Fatalf("err=%v, want exit %d", result.err, command.exitCode)
				}
			}
			wantArgv := strings.Join(floorGHWatchDelegateArgs(command.args[1:]), " ")
			wantChild := fakeGHArgvPrefix + wantArgv
			if strings.Count(result.stdout, fakeGHArgvPrefix) != 1 || !strings.Contains(result.stdout, wantChild) {
				t.Fatalf("stdout=%q, want one %q", result.stdout, wantChild)
			}
			if result.stderr != boundary || strings.Contains(result.stderr, "error: exit status") {
				t.Fatalf("stderr=%q", result.stderr)
			}
			progress := strings.Index(result.stdout, "Watching run")
			if strings.HasPrefix(command.name, "pr") {
				progress = strings.Index(result.stdout, "checks:")
			}
			if child := strings.Index(result.stdout, fakeGHArgvPrefix); progress < 0 || child <= progress {
				t.Fatalf("stdout ordering=%q", result.stdout)
			}
		})
	}
}

func TestGHArgvNames(t *testing.T) {
	for _, name := range []string{"gh", "gh.exe", "octopool-gh", "OCTOPOOL-GH.EXE"} {
		if !isGHArgv(name) {
			t.Errorf("isGHArgv(%q) = false", name)
		}
	}
	if isGHArgv("octopool.exe") {
		t.Fatal("octopool executable must not enter gh wrapper mode")
	}
}

type cliResult struct {
	stdout string
	stderr string
	err    error
}

func buildCLIBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), executableName("octopool"))
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = "."
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func runCLI(t *testing.T, bin string, serverURL string, extra map[string]string, args ...string) cliResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	home := t.TempDir()
	env := append(os.Environ(),
		"HOME="+home,
		"OCTOPOOL_TOKEN=test-token",
		"OCTOPOOL_POOL=maintainers",
		"OCTOPOOL_URL="+serverURL,
	)
	for key, value := range extra {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return cliResult{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

func cliRelayServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/github/request" || r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "unexpected relay request", http.StatusBadRequest)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func writeCLIEnvelope(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Errorf("marshal CLI envelope: %v", err)
		http.Error(w, "invalid fixture body", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(relayEnvelope{
		Status: 200, Body: raw, BodyEncoding: "json",
	}); err != nil {
		t.Errorf("write CLI envelope: %v", err)
	}
}

func writeCLIFallback(t *testing.T, w http.ResponseWriter, reason string) {
	t.Helper()
	w.WriteHeader(http.StatusFailedDependency)
	response := apiErrorResponse{Error: apiError{
		Code: "fallback_local", Message: "Run locally", Details: apiErrorDetails{FallbackReason: reason},
	}}
	if err := json.NewEncoder(w).Encode(response); err != nil {
		t.Errorf("write CLI fallback: %v", err)
	}
}

func fakeGH(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), executableName("fake-gh"))
	content := "#!/bin/sh\nprintf 'real-gh:%s\\n' \"$*\"\n"
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

const fakeGHArgvPrefix = "octopool-fake-gh-argv:"

func fakeGHExit(t *testing.T, exitCode int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	path := filepath.Join(t.TempDir(), executableName("fake-gh"))
	content := `#!/bin/sh
printf '` + fakeGHArgvPrefix + `%s\n' "$*"
exit ` + strconv.Itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func fakeGHAuthStatus(t *testing.T, graphqlValid bool) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	path := filepath.Join(t.TempDir(), executableName("fake-gh"))
	graphqlExit := "exit 1"
	if graphqlValid {
		graphqlExit = "printf 'monalisa\\n'; exit 0"
	}
	content := `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf 'github.com\n  X Failed to log in to github.com account monalisa (keyring)\n  - The token in keyring is invalid.\n' >&2
  exit 1
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  ` + graphqlExit + `
fi
exit 2
`
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}
