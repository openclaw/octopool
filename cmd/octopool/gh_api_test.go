package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestParseGHAPIArgs(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{
		"repos/openclaw/openclaw/pulls/85341?per_page=100",
		"--jq",
		".number",
		"-H",
		"Accept: application/vnd.github+json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fallback {
		t.Fatal("unexpected fallback")
	}
	if request.path != "/repos/openclaw/openclaw/pulls/85341" {
		t.Fatalf("path = %q", request.path)
	}
	if request.query["per_page"] != "100" {
		t.Fatalf("query = %#v", request.query)
	}
	if request.headers["accept"] != "application/vnd.github+json" {
		t.Fatalf("headers = %#v", request.headers)
	}
	if request.jq != ".number" {
		t.Fatalf("jq = %q", request.jq)
	}
}

func TestParseGHAPIArgsDecodesQueryOnce(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{
		"/repos/openclaw/openclaw/actions/runs?branch=feature%2Ffoo&label=a&label=b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fallback {
		t.Fatal("unexpected fallback")
	}
	if request.query["branch"] != "feature/foo" {
		t.Fatalf("query = %#v", request.query)
	}
	labels, ok := request.query["label"].([]string)
	if !ok || len(labels) != 2 || labels[0] != "a" || labels[1] != "b" {
		t.Fatalf("query = %#v", request.query)
	}
}

func TestParseGHAPIArgsFallsBackForSensitiveHeaders(t *testing.T) {
	_, fallback, err := parseGHAPIArgs([]string{
		"/user",
		"-H",
		"Authorization: Bearer secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fallback {
		t.Fatal("expected fallback")
	}
}

func TestSafeRelayRequest(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{"/repos/openclaw/openclaw/pulls/1"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("expected supported PR path")
	}

	for _, path := range []string{
		"/users/openperf",
		"/users/dependabot%5Bbot%5D",
		"/users/dependabot[bot]",
		"/repos/openclaw/octopool",
		"/repos/openclaw/octopool/pulls?state=open",
		"/repos/openclaw/octopool/pulls/1/commits",
		"/repos/openclaw/octopool/commits/main",
		"/repos/openclaw/octopool/commits/v1.2.3",
		"/repos/openclaw/octopool/commits/main/check-runs",
		"/repos/openclaw/octopool/commits/main/check-suites",
		"/repos/openclaw/octopool/commits/main/status",
		"/repos/openclaw/octopool/commits/main/statuses",
		"/repos/openclaw/octopool/issues?state=open",
		"/repos/openclaw/octopool/issues/1/events",
		"/repos/openclaw/octopool/contents/README.md?ref=main",
		"/repos/openclaw/octopool/compare/main...feature",
		"/repos/openclaw/octopool/actions/workflows/ci.yml",
		"/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
		"/repos/openclaw/octopool/releases",
		"/repos/openclaw/octopool/releases/latest",
		"/repos/openclaw/octopool/releases/tags/v0.2.5",
		"/repos/openclaw/octopool/releases/123",
	} {
		request, fallback, err = parseGHAPIArgs([]string{path})
		if err != nil || fallback {
			t.Fatalf("parse %s fallback=%v err=%v", path, fallback, err)
		}
		if !safeRelayRequest(request) {
			t.Fatalf("expected supported path %s", path)
		}
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/issues?q=repo:openclaw/openclaw"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("search read can ask octopool for a policy decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/issues"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("queryless unknown read can ask octopool for a fallback decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/gitignore/templates/C%2B%2B"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("encoded gitignore template names can ask octopool for a policy decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/repositories?q=octopool+relay"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("plain repository search can ask octopool for a policy decision")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/repositories?q=language:go"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("qualified repository search should stay local")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/cli/cli/pulls/1"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("owner policy should be decided by octopool")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/pulls/1?access_token=x"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("token query should fall back")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/pulls/1?client_secret=x"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("secret query should fall back")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/contents/../secret?ref=main"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("canonicalizing path should stay local")
	}
}

func TestParseGHAPIArgsFallsBackForMutation(t *testing.T) {
	_, fallback, err := parseGHAPIArgs([]string{"--method", "POST", "/repos/openclaw/openclaw/issues"})
	if err != nil {
		t.Fatal(err)
	}
	if !fallback {
		t.Fatal("expected fallback")
	}
}

func TestRunGHAPIPlaceholderPathExecutesLocallyWithoutRelay(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return nil
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{"api", "repos/:owner/:repo"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 0 {
		t.Fatalf("relay requests = %d, want 0", requests)
	}
	if !strings.HasPrefix(out.String(), "real-gh:api repos/:owner/:repo") {
		t.Fatalf("output = %q, want real gh execution", out.String())
	}
}

func TestRunGHAPIColonOutsidePlaceholderSegmentRelays(t *testing.T) {
	requests := 0
	relayTestServer(t, func(body map[string]any) any {
		requests++
		query, _ := body["query"].(map[string]any)
		if body["path"] != "/repos/openclaw/octopool/contents/README.md" || query["ref"] != "heads/foo:bar" {
			t.Fatalf("relay body = %#v", body)
		}
		return map[string]any{"relayed": true}
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/contents/README.md?ref=heads/foo:bar",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("relay requests = %d, want 1", requests)
	}
	if strings.Contains(out.String(), "real-gh:") || !strings.Contains(out.String(), `"relayed":true`) {
		t.Fatalf("output = %q, want relay response", out.String())
	}
}
