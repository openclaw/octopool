package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLoginGitHubTokenSelection(t *testing.T) {
	const ghToken = "synthetic-gh-env-token"
	const githubToken = "synthetic-github-env-token"
	const storedToken = "synthetic-github-com-stored-token"
	const enterpriseToken = "synthetic-enterprise-token"
	const callerToken = "synthetic-caller-token"
	for _, tt := range []struct {
		name        string
		ghToken     string
		githubToken string
		storedToken string
		wantToken   string
		wantError   string
	}{
		{name: "GH_TOKEN precedes GITHUB_TOKEN", ghToken: " \t" + ghToken + "\n", githubToken: githubToken, wantToken: ghToken},
		{name: "GITHUB_TOKEN precedes native lookup", githubToken: " \t" + githubToken + "\n", wantToken: githubToken},
		{name: "blank GH_TOKEN uses GITHUB_TOKEN", ghToken: " \t\n", githubToken: githubToken, wantToken: githubToken},
		{name: "native github.com overrides Enterprise host", storedToken: storedToken + "\n", wantToken: storedToken},
		{name: "missing github.com token rejects Enterprise fallback", wantError: "gh auth token failed"},
		{name: "empty github.com token rejects Enterprise fallback", storedToken: " \t\n", wantError: "gh auth token returned empty output"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			isolateHTTPTestConfig(t)
			t.Setenv("GH_TOKEN", tt.ghToken)
			t.Setenv("GITHUB_TOKEN", tt.githubToken)
			t.Setenv("GH_HOST", "ghe.example.test")
			t.Setenv("GH_ENTERPRISE_TOKEN", enterpriseToken)
			t.Setenv("GITHUB_ENTERPRISE_TOKEN", "synthetic-secondary-enterprise-token")
			t.Setenv("OCTOPOOL_POOL", "")
			capture := filepath.Join(t.TempDir(), "argv")
			t.Setenv("OCTOPOOL_TEST_AUTH_ARGV", capture)
			t.Setenv("OCTOPOOL_TEST_GITHUB_COM_TOKEN", tt.storedToken)
			// Model native gh host selection independently of the login implementation.
			ghPath := writeFakeGH(t, `#!/bin/sh
printf '%s\n' "$@" >> "$OCTOPOOL_TEST_AUTH_ARGV"
[ "$1" = auth ] && [ "$2" = token ] || exit 2
shift 2
host="${GH_HOST:-github.com}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hostname|-h) host="$2"; shift 2 ;;
    --hostname=*) host="${1#--hostname=}"; shift ;;
    *) exit 2 ;;
  esac
done
case "$host" in
  github.com)
    [ -n "$OCTOPOOL_TEST_GITHUB_COM_TOKEN" ] || exit 1
    printf '%s\n' "$OCTOPOOL_TEST_GITHUB_COM_TOKEN"
    ;;
  ghe.example.test)
    printf '%s\n' "${GH_ENTERPRISE_TOKEN:-$GITHUB_ENTERPRISE_TOKEN}"
    ;;
  *) exit 1 ;;
esac
`)
			var exchanges atomic.Int32
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/.well-known/octopool":
					writeRedirectTestDiscovery(w, server.URL)
				case "/v1/login/github-cli":
					exchanges.Add(1)
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error("invalid login request JSON")
						http.Error(w, "invalid JSON", http.StatusBadRequest)
						return
					}
					if body["github_token"] == enterpriseToken {
						t.Error("login exchange received the synthetic Enterprise credential")
					} else if body["github_token"] != tt.wantToken {
						t.Error("login exchange did not receive the expected GitHub.com credential")
					}
					_, _ = io.WriteString(w, `{"caller":{"github_login":"alice","pool":"core","client_name":"test-mac"},"token":"`+callerToken+`"}`)
				default:
					t.Errorf("unexpected request path: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			var stdout bytes.Buffer
			err := runLogin(t.Context(), []string{server.URL, "--client", "test-mac", "--gh-path", ghPath}, &stdout)
			if tt.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantError) {
					t.Errorf("expected credential lookup failure containing %q", tt.wantError)
				}
				if exchanges.Load() != 0 || stdout.Len() != 0 {
					t.Error("failed credential lookup must not exchange credentials or report login success")
				}
				authFilePath, pathErr := authPath()
				if pathErr != nil {
					t.Fatal(pathErr)
				}
				if _, statErr := os.Stat(authFilePath); !os.IsNotExist(statErr) {
					t.Error("failed credential lookup must not save caller auth")
				}
			} else if err != nil || exchanges.Load() != 1 {
				t.Error("expected one successful login exchange")
			} else {
				auth, loadErr := loadAuth()
				if loadErr != nil || auth.Token != callerToken || auth.Login != "alice" {
					t.Error("login did not save the returned caller auth")
				}
			}
			output := stdout.String()
			if err != nil {
				output += err.Error()
			}
			for _, token := range []string{ghToken, githubToken, storedToken, enterpriseToken, callerToken} {
				if strings.Contains(output, token) {
					t.Error("login exposed a credential in its output")
				}
			}
			argv, readErr := os.ReadFile(capture)
			if strings.TrimSpace(tt.ghToken) != "" || strings.TrimSpace(tt.githubToken) != "" {
				if !os.IsNotExist(readErr) {
					t.Error("environment token must bypass native gh")
				}
			} else if readErr != nil {
				t.Fatal(readErr)
			} else if string(argv) != "auth\ntoken\n--hostname\ngithub.com\n" {
				t.Errorf("native argv = %q; want exactly one auth token --hostname github.com call", argv)
			}
		})
	}
}
