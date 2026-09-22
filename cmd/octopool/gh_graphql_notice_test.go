package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Existing stream tests allow the new notice once; dedicated tests below assert
// its presence, quota details, and absence on REST/relay-only commands.
func withoutGraphQLNotice(stderr string) string {
	stderr = strings.Replace(stderr, ghNativeJSONNotice+"\n", "", 1)
	stderr = strings.Replace(stderr, ghNativeIncludeNotice+"\n", "", 1)
	return strings.Replace(stderr, "octopool: graphql delegated to personal token\n", "", 1)
}

func TestDelegatedGHUsesGraphQL(t *testing.T) {
	for _, args := range [][]string{
		{"pr", "view", "7", "--json", "reviews"}, {"pr", "checks", "7"},
		{"api", "graphql", "-f", "query=query { viewer { login } }"},
		{"api", "-XPOST", "/graphql", "--include"}, {"issue", "view", "1"}, {"repo", "view", "acme/repo"},
	} {
		if !delegatedGHUsesGraphQL(args) {
			t.Fatalf("missed %q", args)
		}
	}
	for _, args := range [][]string{
		{"api", "repos/acme/repo/pulls/7"}, {"api", "rate_limit"},
		{"api", "-f", "query=graphql", "user"}, {"run", "rerun", "42"},
		{"pr", "view", "--help"}, {"--version"},
	} {
		if delegatedGHUsesGraphQL(args) {
			t.Fatalf("misclassified %q", args)
		}
	}
}

func TestGraphQLQuotaHostSelection(t *testing.T) {
	for _, test := range []struct {
		args, env []string
		want      bool
	}{
		{[]string{"pr", "view", "https://github.com/acme/repo/pull/7"}, nil, true},
		{[]string{"pr", "view", "https://github.enterprise.test/acme/repo/pull/7"}, nil, false},
		{[]string{"issue", "view", "https://github.enterprise.test/acme/repo/issues/7"}, nil, false},
		{[]string{"pr", "checks", "--repo=github.enterprise.test/acme/repo", "7"}, nil, false},
		{[]string{"api", "graphql", "--hostname=github.enterprise.test"}, nil, false},
		{[]string{"api", "graphql"}, []string{"GH_HOST=github.enterprise.test"}, false},
		{[]string{"pr", "view", "7"}, []string{"GH_REPO=github.enterprise.test/acme/repo"}, false},
		{[]string{"pr", "view", "7", "--repo=acme/repo"}, []string{"GH_HOST=github.com"}, true},
		{[]string{"pr", "view", "7", "--repo=github.com/acme/repo", "--jq=https://github.enterprise.test"}, nil, true},
		{[]string{"pr", "view", "7"}, nil, false},
		{[]string{"pr", "view", "7"}, []string{"GH_HOST=github.com"}, false},
		{[]string{"pr", "view", "7"}, []string{"GH_REPO=acme/repo"}, false},
		{[]string{"pr", "view", "7"}, []string{"GH_REPO=acme/repo", "GH_HOST=github.com"}, true},
		{[]string{"api", "graphql"}, nil, false},
		{[]string{"api", "graphql"}, []string{"GH_HOST=github.com"}, true},
		{[]string{"api", "graphql", "--hostname=github.com"}, nil, true},
		{[]string{"api", "graphql", "-H", "Authorization: Bearer synthetic"}, nil, false},
		{[]string{"api", "graphql", "--header=authorization: synthetic"}, nil, false},
		{[]string{"api", "graphql", "-HCookie: synthetic"}, nil, false},
		{[]string{"api", "graphql", "--header=Accept: application/vnd.github+json"}, []string{"GH_HOST=github.com"}, true},
	} {
		if got := graphQLQuotaUsesGitHub(test.args, test.env); got != test.want {
			t.Errorf("args=%q env=%q got=%v want=%v", test.args, test.env, got, test.want)
		}
	}
}

func TestGraphQLNoticeSkipsEnterpriseDefaultQuota(t *testing.T) {
	rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	captureRewriteGH(t)
	t.Setenv("GH_HOST", "")
	t.Setenv("GH_REPO", "")
	t.Setenv("GH_TOKEN", "synthetic-github-token")
	dir := os.Getenv("GH_CONFIG_DIR")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hosts.yml"), []byte("github.enterprise.test:\n  user: enterprise-user\n  oauth_token: synthetic-enterprise-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	probe := filepath.Join(t.TempDir(), "quota-probe")
	t.Setenv("OCTOPOOL_TEST_GRAPHQL_PROBE", probe)
	t.Setenv("OCTOPOOL_TEST_GRAPHQL_QUOTA", `{"resources":{"graphql":{"remaining":0,"limit":5000,"reset":2000000000}}}`)
	var stdout, stderr bytes.Buffer
	if err := execRealGH(t.Context(), []string{"api", "graphql", "-f", "query=query { viewer { login } }"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(probe); !os.IsNotExist(err) {
		t.Fatalf("queried unrelated GitHub.com quota: %v", err)
	}
	if stdout.String() != "child stdout\n" || stderr.String() != "octopool: graphql delegated to personal token\nchild stderr\n" {
		t.Fatalf("default-host notice changed: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestGraphQLNoticeAndErrors(t *testing.T) {
	reset := time.Date(2026, 9, 18, 18, 42, 0, 0, time.UTC).Unix()
	const delegated = "octopool: graphql delegated to personal token\n"
	const exhausted = "octopool: graphql delegated to personal token (REST /rate_limit estimate: remaining 0/5000, resets 18:42 UTC; cached up to 60s, not a retry deadline)\n"
	const rateLimited = "octopool: graphql rate limit; retry time unavailable; inspect the failed response's headers; do not re-authenticate\n"
	for _, test := range []struct {
		name      string
		remaining int64
		input     string
		want      string
		probes    int
	}{
		{"healthy", 500, "native warning\n", delegated + "native warning\n", 1},
		{"low", 499, "", "octopool: graphql delegated to personal token (REST /rate_limit estimate: remaining 499/5000, resets 18:42 UTC; cached up to 60s, not a retry deadline)\n", 1},
		{"exhausted", 0, "gh: API rate limit exceeded (HTTP 403)\nThe token is invalid.\nTry gh auth login\n", exhausted + "gh: API rate limit exceeded (HTTP 403)\n" + rateLimited, 1},
		{"permission", 0, "gh: Resource not accessible (HTTP 403)\n", exhausted + "gh: Resource not accessible (HTTP 403)\n", 1},
		{"secondary", 0, "gh: You have exceeded a secondary rate limit (HTTP 403)\nRetry-After: 60\n", exhausted + "gh: You have exceeded a secondary rate limit (HTTP 403)\nRetry-After: 60\n", 1},
		{"abuse", 0, "gh: Abuse detection rate limit (HTTP 403)\nRetry-After: 90\n", exhausted + "gh: Abuse detection rate limit (HTTP 403)\nRetry-After: 90\n", 1},
		{"conflicting_rest_quota", 5000, "gh: API rate limit exceeded (HTTP 403)\n", delegated + "gh: API rate limit exceeded (HTTP 403)\n" + rateLimited, 1},
		{"graphql200", 0, "GraphQL: API rate limit exceeded", exhausted + "GraphQL: API rate limit exceeded\n" + rateLimited, 1},
		{"raw_graphql200", 0, "gh: API rate limit exceeded", exhausted + "gh: API rate limit exceeded\n" + rateLimited, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stderr bytes.Buffer
			probes := 0
			output := newGHGraphQLStderr(&stderr, func() *ghGraphQLQuota {
				probes++
				return &ghGraphQLQuota{Remaining: test.remaining, Limit: 5000, Reset: reset}
			}, true)
			for _, b := range []byte(test.input) {
				if _, err := output.Write([]byte{b}); err != nil {
					t.Fatal(err)
				}
			}
			if err := output.flush(); err != nil || stderr.String() != test.want || probes != test.probes {
				t.Fatalf("stderr=%q probes=%d err=%v", stderr.String(), probes, err)
			}
		})
	}
}

func TestGraphQLNoticeProbeUnavailableAndBoundedOutput(t *testing.T) {
	var stderr bytes.Buffer
	output := newGHGraphQLStderr(&stderr, func() *ghGraphQLQuota { return nil }, true)
	long := strings.Repeat("x", 20000) + "\n"
	if _, err := output.Write([]byte(long)); err != nil {
		t.Fatal(err)
	}
	if _, err := output.Write([]byte("gh: rate limit exceeded (HTTP 403)\n")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), long) || !strings.Contains(stderr.String(), "gh: rate limit exceeded (HTTP 403)\n") || !strings.Contains(stderr.String(), "retry time unavailable") || len(output.pending) != 0 {
		t.Fatal("lost native output or guessed unavailable quota")
	}
}

func TestGraphQLNoticeDoesNotBufferPrompts(t *testing.T) {
	var stderr bytes.Buffer
	output := newGHGraphQLStderr(&stderr, func() *ghGraphQLQuota { return nil }, false)
	stderr.Reset()
	for _, part := range []string{"Title", ": "} {
		if _, err := output.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	if stderr.String() != "Title: " {
		t.Fatalf("prompt hidden until newline/exit: %q", stderr.String())
	}
}

func TestGraphQLQuotaProbeUsesNativeCache(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	captureRewriteGH(t)
	path, err := resolveGHPath(os.Getenv("OCTOPOOL_GH_PATH"))
	if err != nil {
		t.Fatal(err)
	}
	quota := readPersonalGraphQLQuota(t.Context(), path, os.Environ(), testRewritePolicy(t, stringRewriteRule{"private", "public"}))
	if quota == nil || quota.Remaining != 5000 || quota.Limit != 5000 {
		t.Fatalf("quota=%+v", quota)
	}
	for _, invalid := range []string{`{}`, `{"resources":{"graphql":{"limit":5000,"reset":2000000000}}}`, `{"resources":{"graphql":{"remaining":-1,"limit":5000,"reset":2000000000}}}`, `invalid JSON`} {
		t.Setenv("OCTOPOOL_TEST_GRAPHQL_QUOTA", invalid)
		if quota := readPersonalGraphQLQuota(t.Context(), path, os.Environ(), stringRewritePolicy{}); quota != nil {
			t.Fatalf("accepted invalid quota: %+v", quota)
		}
	}
}

func TestGraphQLNoticeNativeExitAndStdout(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct {
		name, quota, stdout, nativeError string
		args                             []string
	}{
		{"pr", `{"resources":{"graphql":{"remaining":0,"limit":5000,"reset":2000000000}}}`, "unchanged stdout", "GraphQL: API rate limit exceeded", []string{"pr", "view", "7", "-Racme/repo", "--json=reviews"}},
		{"api", `{"resources":{"graphql":{"remaining":0,"limit":5000,"reset":2000000000}}}`, "unchanged stdout", "gh: API rate limit exceeded (HTTP 403)", []string{"api", "graphql", "-f", "query=query { viewer { login } }"}},
		{"conflicting_rest_quota", `{"resources":{"graphql":{"remaining":5000,"limit":5000,"reset":2000000000}}}`, "HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1900000000\n\n{\"errors\":[{\"type\":\"RATE_LIMIT\"}]}\n", "gh: API rate limit already exceeded for user ID 42.", []string{"api", "graphql", "--include", "-f", "query=query { viewer { login } }"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			captureRewriteGH(t)
			t.Setenv("OCTOPOOL_TEST_GRAPHQL_QUOTA", test.quota)
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", test.stdout)
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDERR", test.nativeError+"\nThe token is invalid.\nTry gh auth login\n")
			t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "7")
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), test.args, &stdout, &stderr)
			var exit exitCodeError
			if !errors.As(err, &exit) || exit.Code != 7 || stdout.String() != test.stdout {
				t.Fatalf("stdout=%q err=%v", stdout.String(), err)
			}
			if strings.Count(stderr.String(), "graphql delegated to personal token") != 1 || !strings.Contains(stderr.String(), test.nativeError+"\n") || !strings.Contains(stderr.String(), "retry time unavailable") || strings.Contains(stderr.String(), "retry after reset") || strings.Contains(stderr.String(), "token is invalid") || strings.Contains(stderr.String(), "gh auth login") {
				t.Fatal(stderr.String())
			}
			if test.name == "conflicting_rest_quota" && strings.Contains(stderr.String(), "resets") {
				t.Fatal("REST reset replaced the failed response's quota: " + stderr.String())
			}
		})
	}
}

func TestGraphQLNoticePreservesMixedRESTFailure(t *testing.T) {
	var stderr bytes.Buffer
	probes := 0
	output := newGHGraphQLStderr(&stderr, func() *ghGraphQLQuota {
		probes++
		return &ghGraphQLQuota{Remaining: 5000, Limit: 5000, Reset: 2000000000}
	}, false)
	nativeError := "gh: API rate limit exceeded (HTTP 403)\n"
	if _, err := output.Write([]byte(nativeError)); err != nil {
		t.Fatal(err)
	}
	if probes != 1 || stderr.String() != "octopool: graphql delegated to personal token\n"+nativeError {
		t.Fatalf("REST error misattributed: probes=%d stderr=%q", probes, stderr.String())
	}
}
