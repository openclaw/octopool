package main

import (
	"encoding/json"
	"errors"
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
		"/repos/openclaw/octopool",
		"/repos/openclaw/octopool/pulls?state=open",
		"/repos/openclaw/octopool/issues?state=open",
		"/repos/openclaw/octopool/actions/workflows/ci.yml",
		"/repos/openclaw/octopool/actions/workflows/ci.yml/runs",
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
	if safeRelayRequest(request) {
		t.Fatal("unknown query-bearing read should stay local")
	}

	request, fallback, err = parseGHAPIArgs([]string{"/search/issues"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if !safeRelayRequest(request) {
		t.Fatal("queryless unknown read can ask octopool for a fallback decision")
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

	request, fallback, err = parseGHAPIArgs([]string{"/repos/openclaw/openclaw/compare/main...feature"})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if safeRelayRequest(request) {
		t.Fatal("canonicalizing path should stay local")
	}
}

func TestTopLevelRepoNumber(t *testing.T) {
	opts := ghTopOptions{repo: "openclaw/openclaw", positionals: []string{"85341"}}
	repo, number, ok := repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{positionals: []string{"https://github.com/openclaw/openclaw/pull/85341"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber URL = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "cli/cli", positionals: []string{"1"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "cli/cli" || number != "1" {
		t.Fatalf("repoNumber outside default owner = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "openclaw", positionals: []string{"1"}}
	if _, _, ok = repoNumber(opts); ok {
		t.Fatal("malformed explicit repo should fall back")
	}
}

func TestParseGHTopOptions(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{
		"-R", "openclaw/openclaw",
		"--json", "number,title,url",
		"--jq", ".number",
		"--limit", "50",
		"--state=open",
		"--label", "bug",
		"85341",
	})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if opts.repo != "openclaw/openclaw" || opts.limit != "50" || opts.state != "open" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.json) != 3 || opts.json[2] != "url" || opts.jq != ".number" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.labels) != 1 || opts.labels[0] != "bug" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.positionals) != 1 || opts.positionals[0] != "85341" {
		t.Fatalf("opts = %#v", opts)
	}
}

func TestFilterJSONFieldsUsesGHNames(t *testing.T) {
	raw := []byte(`{"number":85341,"title":"fix","html_url":"https://example.test/pr","head":{"ref":"feature","sha":"abc1234"},"draft":true}`)
	out, err := filterJSONFields(raw, []string{"number", "url", "headRefName", "headRefOid", "isDraft"}, fieldMapPR)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["url"] != "https://example.test/pr" || got["headRefName"] != "feature" || got["headRefOid"] != "abc1234" || got["isDraft"] != true {
		t.Fatalf("filtered = %#v", got)
	}
}

func TestStatusItemsMapLegacyContexts(t *testing.T) {
	envelope := relayEnvelope{
		Status:       200,
		BodyEncoding: "json",
		Body:         []byte(`{"statuses":[{"context":"ci/external","state":"success","target_url":"https://example.test","created_at":"2026-05-27T00:00:00Z","updated_at":"2026-05-27T00:01:00Z"}]}`),
	}
	items, err := statusItems(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item := items[0].(map[string]any)
	if item["name"] != "ci/external" || item["conclusion"] != "success" || item["details_url"] != "https://example.test" {
		t.Fatalf("item = %#v", item)
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

func TestWriteGHBodyAllowsNullTextBody(t *testing.T) {
	envelope := relayEnvelope{Status: 304, Body: []byte("null"), BodyEncoding: "text"}
	if err := writeGHBody(t.Context(), discardWriter{}, envelope, ""); err != nil {
		t.Fatal(err)
	}
}

func TestParseLocalFallback(t *testing.T) {
	err, ok := parseLocalFallback([]byte(`{"error":{"code":"fallback_local","message":"Run locally","details":{"reason":"route_denied"}}}`))
	if !ok {
		t.Fatal("expected fallback")
	}
	if err.Reason != "route_denied" {
		t.Fatalf("reason = %q", err.Reason)
	}
}

func TestShouldRunRealGH(t *testing.T) {
	if !shouldRunRealGH(localFallbackError{Reason: "route_denied"}) {
		t.Fatal("fallback_local should run real gh")
	}
	if !shouldRunRealGH(errOctopoolNotLoggedIn) {
		t.Fatal("missing octopool login should run real gh")
	}
	if shouldRunRealGH(assertAnError{}) {
		t.Fatal("ordinary errors should not run real gh")
	}
}

func TestNewGHRelayClientMissingLoginUsesFallbackSentinel(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OCTOPOOL_TOKEN", "")
	_, err := newGHRelayClient()
	if !errors.Is(err, errOctopoolNotLoggedIn) {
		t.Fatalf("err = %v", err)
	}
}

type assertAnError struct{}

func (assertAnError) Error() string {
	return "boom"
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) {
	return len(p), nil
}
