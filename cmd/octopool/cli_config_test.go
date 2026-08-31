package main

import (
	"flag"
	"io"
	"testing"
)

func TestCallerRequestFlagsAuthSnapshot(t *testing.T) {
	saved := authFile{URL: "https://a.example.test", Pool: "pool-a", Token: "synthetic-token-a"}
	replacement := authFile{URL: "https://b.example.test", Pool: "pool-b", Token: "synthetic-token-b"}
	for _, tt := range []struct {
		name      string
		auth      authFile
		missing   bool
		args      []string
		env       map[string]string
		wantURL   string
		wantPool  string
		wantToken string
		wantError string
	}{
		{
			name: "saved token stays with loaded URL after another login",
			auth: saved, wantURL: saved.URL, wantPool: saved.Pool, wantToken: saved.Token,
		},
		{
			name:    "missing auth stays missing after another login",
			missing: true, wantURL: defaultURL, wantPool: "maintainers",
			wantError: "not logged in; run: octopool login",
		},
		{
			name: "empty saved token requires login",
			auth: authFile{URL: saved.URL, Pool: saved.Pool}, wantURL: saved.URL, wantPool: saved.Pool,
			wantError: "not logged in; run: octopool login",
		},
		{
			name: "environment token overrides saved token and permits URL override",
			auth: saved, args: []string{"--url", replacement.URL},
			env:     map[string]string{"OCTOPOOL_TOKEN": " \tsynthetic-env-token\n"},
			wantURL: replacement.URL, wantPool: saved.Pool, wantToken: "synthetic-env-token",
		},
		{
			name:    "environment token works without saved auth",
			missing: true, env: map[string]string{"OCTOPOOL_TOKEN": "synthetic-env-token"},
			wantURL: defaultURL, wantPool: "maintainers", wantToken: "synthetic-env-token",
		},
		{
			name: "custom token environment takes precedence",
			auth: saved, args: []string{"--token-env", "OCTOPOOL_TEST_CALLER_TOKEN", "--url", replacement.URL},
			env:     map[string]string{"OCTOPOOL_TOKEN": "synthetic-env-token", "OCTOPOOL_TEST_CALLER_TOKEN": " \tsynthetic-custom-token\n"},
			wantURL: replacement.URL, wantPool: saved.Pool, wantToken: "synthetic-custom-token",
		},
		{
			name: "blank custom environment falls back to loaded token",
			auth: saved, args: []string{"--token-env", "OCTOPOOL_TEST_CALLER_TOKEN"},
			env:     map[string]string{"OCTOPOOL_TOKEN": "synthetic-env-token", "OCTOPOOL_TEST_CALLER_TOKEN": " \t\n"},
			wantURL: saved.URL, wantPool: saved.Pool, wantToken: saved.Token,
		},
		{
			name: "URL flag mismatch still rejects saved token",
			auth: saved, args: []string{"--url", replacement.URL},
			wantURL: replacement.URL, wantPool: saved.Pool,
			wantError: "URL override requires OCTOPOOL_TOKEN or a fresh octopool login for that URL",
		},
		{
			name: "URL environment mismatch with blank token still rejects saved token",
			auth: saved, env: map[string]string{"OCTOPOOL_URL": replacement.URL, "OCTOPOOL_TOKEN": " \t\n"},
			wantURL: replacement.URL, wantPool: saved.Pool,
			wantError: "URL override requires OCTOPOOL_TOKEN or a fresh octopool login for that URL",
		},
		{
			name: "URL mismatch names custom token environment",
			auth: saved, args: []string{"--url", replacement.URL, "--token-env", "OCTOPOOL_TEST_CALLER_TOKEN"},
			env:     map[string]string{"OCTOPOOL_TOKEN": "synthetic-env-token"},
			wantURL: replacement.URL, wantPool: saved.Pool,
			wantError: "URL override requires OCTOPOOL_TEST_CALLER_TOKEN or a fresh octopool login for that URL",
		},
		{
			name:    "URL mismatch precedes missing token error",
			missing: true, args: []string{"--url", replacement.URL},
			wantURL: replacement.URL, wantPool: "maintainers",
			wantError: "URL override requires OCTOPOOL_TOKEN or a fresh octopool login for that URL",
		},
		{
			name: "flags override environment and saved defaults",
			auth: saved, args: []string{"--url", saved.URL + "/", "--pool", "flag-pool"},
			env:     map[string]string{"OCTOPOOL_URL": replacement.URL, "OCTOPOOL_POOL": "env-pool"},
			wantURL: saved.URL + "/", wantPool: "flag-pool", wantToken: saved.Token,
		},
		{
			name: "environment overrides saved defaults",
			auth: saved, env: map[string]string{"OCTOPOOL_URL": saved.URL + "/", "OCTOPOOL_POOL": "env-pool"},
			wantURL: saved.URL + "/", wantPool: "env-pool", wantToken: saved.Token,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			isolateTestConfig(t)
			for _, name := range []string{"OCTOPOOL_URL", "OCTOPOOL_POOL", "OCTOPOOL_TOKEN", "OCTOPOOL_TEST_CALLER_TOKEN"} {
				t.Setenv(name, tt.env[name])
			}
			if !tt.missing {
				if err := saveAuth(tt.auth); err != nil {
					t.Fatal(err)
				}
			}
			fs := flag.NewFlagSet("test", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			flags := newCallerRequestFlags(fs)
			if err := fs.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			auth, err := flags.applyAuth(fs)
			if err != nil {
				t.Fatal(err)
			}
			// A second login replaces the store after this request loads its defaults.
			if err := saveAuth(replacement); err != nil {
				t.Fatal(err)
			}
			token, err := flags.authorize(auth)
			if *flags.baseURL != tt.wantURL || *flags.pool != tt.wantPool {
				t.Errorf("request URL/pool = %q/%q, want %q/%q", *flags.baseURL, *flags.pool, tt.wantURL, tt.wantPool)
			}
			if tt.wantError != "" {
				if err == nil || err.Error() != tt.wantError {
					t.Errorf("authorize error = %v, want %q", err, tt.wantError)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if token != tt.wantToken {
				t.Errorf("authorize token for %q = %q, want %q", *flags.baseURL, token, tt.wantToken)
			}
		})
	}
}
