package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitCloneURL(t *testing.T) {
	got, err := gitCloneURL("https://octopool.example.com", "openclaw/octopool")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://octopool.example.com/git/openclaw/octopool.git" {
		t.Fatalf("unexpected clone URL: %s", got)
	}
}

func TestGitCredentialHelperReturnsTokenForOctopoolGitURL(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configDir)
	t.Setenv("OCTOPOOL_URL", "")
	t.Setenv("OCTOPOOL_TOKEN", "")
	if err := saveAuth(authFile{
		URL:   "https://octopool.example.com",
		Pool:  "maintainers",
		Token: "op_secret",
	}); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	input := strings.NewReader("protocol=https\nhost=octopool.example.com\npath=git/openclaw/octopool.git\n\n")
	if err := runGitCredential([]string{"get"}, input, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "username=x-octopool\n") {
		t.Fatalf("missing username: %q", out.String())
	}
	if !strings.Contains(out.String(), "password=op_secret\n") {
		t.Fatalf("missing password: %q", out.String())
	}
}

func TestAdminGitPolicySendsExpectedJSON(t *testing.T) {
	t.Setenv("OCTOPOOL_ADMIN_TOKEN", "admin-token")
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/admin/pools/maintainers/git-policies" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.Header.Get("authorization") != "Bearer admin-token" {
			t.Fatalf("authorization = %s", r.Header.Get("authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var out bytes.Buffer
	err := runAdminGitPolicy(context.Background(), []string{
		"--url", server.URL,
		"--pool", "maintainers",
		"--github-login", "agent",
		"--repo", "openclaw/octopool",
		"--fetch",
		"--push",
		"--push-branch", "agent/*",
	}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if received["github_login"] != "agent" || received["repo"] != "openclaw/octopool" {
		t.Fatalf("unexpected body: %#v", received)
	}
	branches, ok := received["push_branches"].([]any)
	if !ok || len(branches) != 1 || branches[0] != "agent/*" {
		t.Fatalf("unexpected branches: %#v", received["push_branches"])
	}
}

func TestGitCloneDir(t *testing.T) {
	if got := gitCloneDir("openclaw/octopool", nil); got != "octopool" {
		t.Fatalf("clone dir = %s", got)
	}
	if got := gitCloneDir("openclaw/octopool", []string{filepath.Join("tmp", "repo")}); got != filepath.Join("tmp", "repo") {
		t.Fatalf("clone dir override = %s", got)
	}
}

func TestGitCredentialIgnoresOtherHosts(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configDir)
	if err := os.MkdirAll(filepath.Join(configDir, "octopool"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := saveAuth(authFile{URL: "https://octopool.example.com", Token: "op_secret"}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	input := strings.NewReader("protocol=https\nhost=github.com\npath=openclaw/octopool.git\n\n")
	if err := runGitCredential([]string{"get"}, input, &out); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("expected no credentials, got %q", out.String())
	}
}
