package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestGHWithTokenLoginDiagnosesRESTQuotaWithoutClaimingSuccess(t *testing.T) {
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHLogin(t, true))
	reset := time.Date(2026, time.July, 4, 18, 40, 15, 0, time.UTC)
	var stdout strings.Builder
	var stderr strings.Builder
	err := runGHWithTokenLoginProbe(
		t.Context(),
		[]string{"auth", "login", "--hostname", "github.com", "--with-token"},
		strings.NewReader("test-token\n"),
		&stdout,
		&stderr,
		func(_ context.Context, hostname string, token string) (githubTokenIdentity, error) {
			if hostname != "github.com" || token != "test-token" {
				t.Fatalf("probe received hostname=%q token_match=%v", hostname, token == "test-token")
			}
			return githubTokenIdentity{login: "monalisa", coreReset: reset}, nil
		},
	)
	if err == nil || stdout.String() != "" {
		t.Fatalf("err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "token authenticates as monalisa via GitHub GraphQL") ||
		!strings.Contains(stderr.String(), "2026-07-04T18:40:15Z") ||
		strings.Contains(stderr.String(), "error validating token") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestGHWithTokenLoginPreservesGenuineValidationFailure(t *testing.T) {
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHLogin(t, true))
	var stderr strings.Builder
	err := runGHWithTokenLoginProbe(
		t.Context(),
		[]string{"auth", "login", "--hostname", "github.com", "--with-token"},
		strings.NewReader("invalid-token\n"),
		io.Discard,
		&stderr,
		func(context.Context, string, string) (githubTokenIdentity, error) {
			return githubTokenIdentity{}, errors.New("bad credentials")
		},
	)
	if err == nil || !strings.Contains(stderr.String(), "error validating token") {
		t.Fatalf("err=%v stderr=%q", err, stderr.String())
	}
}

func TestGHWithTokenLoginPreservesSuccessfulRealGH(t *testing.T) {
	t.Setenv("OCTOPOOL_GH_PATH", fakeGHLogin(t, false))
	t.Setenv("GITHUB_TOKEN", "ambient-token-must-not-reach-real-gh")
	var stdout strings.Builder
	probeCalled := false
	err := runGHWithTokenLoginProbe(
		t.Context(),
		[]string{"auth", "login", "--hostname", "github.com", "--with-token"},
		strings.NewReader("test-token\n"),
		&stdout,
		io.Discard,
		func(context.Context, string, string) (githubTokenIdentity, error) {
			probeCalled = true
			return githubTokenIdentity{}, nil
		},
	)
	if err != nil || stdout.String() != "stored\n" || probeCalled {
		t.Fatalf("err=%v stdout=%q probe_called=%v", err, stdout.String(), probeCalled)
	}
}

func fakeGHLogin(t *testing.T, rateLimited bool) string {
	t.Helper()
	body := "test -z \"${GITHUB_TOKEN:-}\" || exit 9\ncat >/dev/null\nprintf 'stored\\n'\n"
	if rateLimited {
		body = "test -z \"${GITHUB_TOKEN:-}\" || exit 9\ncat >/dev/null\nprintf 'error validating token: HTTP 403: API rate limit exceeded' >&2\nexit 1\n"
	}
	return writeFakeGH(t, "#!/bin/sh\n"+body)
}
