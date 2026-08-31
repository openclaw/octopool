package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestValidateLoginURLRequiresHTTPS(t *testing.T) {
	if err := validateLoginURL("https://octopool.dev"); err != nil {
		t.Fatal(err)
	}
	if err := validateLoginURL("http://127.0.0.1:8787"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_ALLOW_INSECURE_LOGIN", "")
	if err := validateLoginURL("http://octopool.dev"); err == nil {
		t.Fatal("expected insecure login URL to fail")
	}
}

func TestFormatLoginFailureExplainsGitHub403(t *testing.T) {
	t.Setenv("TZ", "UTC")
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 403","request_id":"req-123","details":{"github_rate_limit_reset":"1779928316","github_rate_limit_remaining":"0","github_rate_limit_resource":"core"}}}`), "/bin/gh", "https://octopool.dev", "core")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"GitHub rejected the local gh token",
		"rate limit",
		"GitHub reset: Thu, 28 May 2026 00:31:56 UTC",
		"remaining: 0",
		"resource: core",
		"/bin/gh api rate_limit",
		"req-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureExplainsGitHub429(t *testing.T) {
	t.Setenv("TZ", "UTC")
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 429","details":{"github_rate_limit_reset":"1779928316","github_retry_after":"60"}}}`), "/bin/gh", "https://octopool.dev", "core")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"rate limit",
		"GitHub reset: Thu, 28 May 2026 00:31:56 UTC",
		"retry-after: 60s",
		"Retry after reset",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureDoesNotTreatResetHeaderAsRateLimit(t *testing.T) {
	t.Setenv("TZ", "UTC")
	err := formatLoginFailure(401, []byte(`{"error":{"code":"github_auth_failed","message":"GitHub token check failed with 401","details":{"github_rate_limit_reset":"1779928316","github_rate_limit_remaining":"4999"}}}`), "/bin/gh", "https://octopool.dev", "core")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	if !strings.Contains(got, "Refresh GitHub CLI auth") {
		t.Fatalf("expected re-auth guidance:\n%s", got)
	}
	if strings.Contains(got, "Retry after reset") {
		t.Fatalf("did not expect rate-limit guidance:\n%s", got)
	}
}

func TestLocalGitHubAuthErrorGivesReauthenticationCommands(t *testing.T) {
	err := localGitHubAuthError("/opt/homebrew/opt/gh/bin/gh", errors.New("exit status 1"))
	got := err.Error()
	for _, want := range []string{
		"gh auth token failed: exit status 1",
		"/opt/homebrew/opt/gh/bin/gh auth login --hostname github.com --web",
		"octopool login --gh-path /opt/homebrew/opt/gh/bin/gh",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureExplainsCallerProvisioning(t *testing.T) {
	err := formatLoginFailure(403, []byte(`{"error":{"code":"caller_not_provisioned","message":"Caller is not provisioned for this pool","request_id":"req-123"}}`), "/bin/gh", "https://octopool.dev", "maintainers")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		`not provisioned for Octopool pool "maintainers"`,
		"octopool admin caller --url 'https://octopool.dev' --pool 'maintainers' --github-login your-github-login",
		"Then retry: octopool login 'https://octopool.dev'",
		"req-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestFormatLoginFailureQuotesProvisioningCommandArguments(t *testing.T) {
	err := formatLoginFailure(403, []byte(`{"error":{"code":"caller_not_provisioned","message":"Caller is not provisioned for this pool"}}`), "/bin/gh", "https://octopool.dev/path;echo pwned", "maintainers'$(touch /tmp/pwned)")
	if err == nil {
		t.Fatal("expected error")
	}
	got := err.Error()
	for _, want := range []string{
		"--url 'https://octopool.dev/path;echo pwned'",
		"--pool 'maintainers'\"'\"'$(touch /tmp/pwned)'",
		"Then retry: octopool login 'https://octopool.dev/path;echo pwned'",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in error:\n%s", want, got)
		}
	}
}

func TestLoginAcceptsPositionalServerAndStoresDiscoveredAuth(t *testing.T) {
	t.Setenv("GH_TOKEN", "gh_test")
	isolateTestConfig(t)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/octopool":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"service":"octopool","version":1,"api_base":"` + server.URL + `","app_base":"` + server.URL + `","default_pool":"core","allowed_org":"acme","auth":{"cli_github_token":true,"web_login":true}}`))
		case "/v1/login/github-cli":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["github_token"] != "gh_test" || body["pool"] != "core" || body["client_name"] != "test-mac" {
				t.Fatalf("login body = %#v", body)
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"caller":{"github_login":"alice","pool":"core","client_name":"test-mac"},"token":"op_test"}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var stdout bytes.Buffer
	if err := runLogin(t.Context(), []string{server.URL, "--client", "test-mac"}, &stdout); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "logged in to "+server.URL+" as alice for pool core from test-mac") {
		t.Fatalf("stdout = %q", stdout.String())
	}
	authFilePath, err := authPath()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(authFilePath)
	if err != nil {
		t.Fatal(err)
	}
	var auth authFile
	if err := json.Unmarshal(data, &auth); err != nil {
		t.Fatal(err)
	}
	if auth.URL != server.URL || auth.Pool != "core" || auth.Token != "op_test" || auth.Login != "alice" || auth.Client != "test-mac" {
		t.Fatalf("auth = %#v", auth)
	}
}

func TestLoginServerArgumentRejectsDisagreement(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	server := fs.String("server", "", "server")
	if err := fs.Parse([]string{"--server", "https://flag.example", "https://pos.example"}); err != nil {
		t.Fatal(err)
	}
	if _, err := loginServerArgument(fs, "", *server); err == nil {
		t.Fatal("expected disagreement error")
	}
}

func TestNormalizeLoginArgsAllowsFlagsAfterServer(t *testing.T) {
	got := normalizeLoginArgs([]string{
		"https://octopool.example.com",
		"--pool",
		"core",
		"--trust-discovery-redirect",
	})
	want := []string{
		"--pool",
		"core",
		"--trust-discovery-redirect",
		"https://octopool.example.com",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("normalizeLoginArgs() = %#v", got)
	}
}

// The server is a synthetic wire fixture; storage/rotation is proven in Workerd/D1.
func TestLoginCompoundClientWhoamiAndStats(t *testing.T) {
	for _, input := range []string{"Host.local.local", "Host.LoCaL.local.LOCAL"} {
		t.Run(input, func(t *testing.T) {
			isolateTestConfig(t)
			for _, name := range []string{"OCTOPOOL_TOKEN", "OCTOPOOL_URL", "OCTOPOOL_POOL"} {
				t.Setenv(name, "")
			}
			t.Setenv("GH_TOKEN", "synthetic-github")
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("content-type", "application/json")
				switch r.URL.Path {
				case "/.well-known/octopool":
					_ = json.NewEncoder(w).Encode(map[string]any{"service": "octopool", "version": 1, "api_base": server.URL, "default_pool": "maintainers", "auth": map[string]bool{"cli_github_token": true}})
				case "/v1/login/github-cli":
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["client_name"] != "Host" {
						t.Errorf("wire client = %q, want Host", body["client_name"])
					}
					_, _ = io.WriteString(w, `{"caller":{"github_login":"alice","pool":"maintainers","client_name":"Host"},"token":"synthetic-caller"}`)
				case "/v1/pools/maintainers/stats":
					if r.URL.Query().Get("client") != input || r.Header.Get("Authorization") != "Bearer synthetic-caller" {
						t.Error("stats lost original filter or saved credential")
					}
					_, _ = io.WriteString(w, `{"operator":{"client_name":"Host"},"client_usage":{"requests":1}}`)
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
				}
			}))
			defer server.Close()
			var out bytes.Buffer
			if err := runLogin(t.Context(), []string{server.URL, "--client", input}, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "from Host\n") {
				t.Fatal(out.String())
			}
			out.Reset()
			if err := runWhoami([]string{"--json"}, &out); err != nil {
				t.Fatal(err)
			}
			var who map[string]string
			if err := json.Unmarshal(out.Bytes(), &who); err != nil {
				t.Fatal(err)
			}
			if who["client"] != "Host" {
				t.Fatal(who)
			}
			out.Reset()
			if err := runStats(t.Context(), []string{"--client", input, "--json"}, &out); err != nil {
				t.Fatal(err)
			}
			var stats statsResponse
			if err := json.Unmarshal(out.Bytes(), &stats); err != nil {
				t.Fatal(err)
			}
			if stats.ClientUsage.Requests != 1 || stats.Operator.ClientName != "Host" {
				t.Fatal(out.String())
			}
		})
	}
}

func TestDefaultHostnameClientName(t *testing.T) {
	for _, tc := range []struct{ input, defaultName, wireName string }{
		{"", "unknown", "unknown"},
		{" \t", "unknown", "unknown"},
		{"Host.local.local.local", "Host", "Host"},
		{strings.Repeat("a", 80) + ".local.local", strings.Repeat("a", 80), strings.Repeat("a", 80)},
		{strings.Repeat("a", 81) + ".local", strings.Repeat("a", 80), strings.Repeat("a", 80)},
		// Preserve normalization before default-only truncation, then login normalization.
		{strings.Repeat("a", 74) + ".local-extra", strings.Repeat("a", 74) + ".local", strings.Repeat("a", 74)},
	} {
		got := defaultHostnameClientName(tc.input)
		if got != tc.defaultName || normalizeClientName(got) != tc.wireName {
			t.Fatalf("default=%q wire=%q", got, normalizeClientName(got))
		}
	}
	if got := normalizeClientName(strings.Repeat("a", 81) + ".local.local"); len(got) != 81 {
		t.Fatalf("explicit input was truncated: %q", got)
	}
}
