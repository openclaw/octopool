package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunGHSearchIssuesUsesScopedSearchRoute(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/search/issues" {
			t.Fatalf("path = %v", body["path"])
		}
		query := body["query"].(map[string]any)
		if query["per_page"] != "10" || query["q"] != "repo:openclaw/octopool type:issue cache regression" {
			t.Fatalf("query = %#v", query)
		}
		headers := body["headers"].(map[string]any)
		if headers["x-octopool-public-shape"] != "issue-search-v1" {
			t.Fatalf("headers = %#v", headers)
		}
		return map[string]any{
			"items": []map[string]any{{
				"number":   1,
				"title":    "cache hit regression",
				"body":     "octopool should pool this",
				"html_url": "https://github.com/openclaw/octopool/issues/1",
			}},
		}
	})
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"-R", "openclaw/octopool",
		"cache",
		"regression",
		"--json", "number,title,url",
		"--limit", "10",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	got := out.String()
	if !strings.Contains(got, `"number":1`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHSearchUsesTokenFreeShapeForExactRESTFields(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		headers := body["headers"].(map[string]any)
		if headers["x-octopool-public-shape"] != "issue-search-v1" {
			t.Fatalf("headers = %#v", headers)
		}
		return map[string]any{"items": []map[string]any{}}
	})
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--json", "number,title,body",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchReposUsesRepositorySearchRoute(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/search/repositories" {
			t.Fatalf("path = %v", body["path"])
		}
		query := body["query"].(map[string]any)
		if query["q"] != "octopool relay" || query["per_page"] != "10" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{
			"items": []map[string]any{{
				"name":      "octopool",
				"full_name": "openclaw/octopool",
				"html_url":  "https://github.com/openclaw/octopool",
			}},
		}
	})
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"repos",
		"octopool",
		"relay",
		"--json", "name,nameWithOwner,url",
		"--limit", "10",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"nameWithOwner":"openclaw/octopool"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHSearchReposRejectsOperators(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"repos",
		"octopool",
		"NOT",
		"relay",
		"--json", "name,nameWithOwner,url",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchUsesExplicitStateOnly(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		query := body["query"].(map[string]any)
		if query["q"] != "repo:openclaw/octopool type:issue state:open cache" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{"items": []map[string]any{}}
	})
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--state", "open",
		"--json", "number,title,url",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForInvalidStateAll(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--state", "all",
		"--json", "number,title,url",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForUnimplementedSort(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"--sort", "created",
		"--json", "number,title,url",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForQualifiedQuery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"author:alice",
		"cache",
		"-R", "openclaw/octopool",
		"--json", "number,title,url",
	}, &out)
	if result.action != ghFail || !isLocalFallback(result.err) {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForUnsupportedTerm(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"C++",
		"-R", "openclaw/octopool",
		"--json", "number,title,url",
	}, &out)
	if result.action != ghFail || !isLocalFallback(result.err) {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForQuotedPhrase(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"cache regression",
		"-R", "openclaw/octopool",
		"--json", "number,title,url",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchPRsFallsBackForUnavailableFields(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"prs",
		"cache",
		"-R", "openclaw/octopool",
		"--json", "number,headRefName,isDraft",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForMultipleRepos(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"issues",
		"cache",
		"-R", "openclaw/octopool",
		"-R", "openclaw/openclaw",
		"--json", "number,title,url",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHSearchFallsBackForNonSearchModifiers(t *testing.T) {
	var out bytes.Buffer
	result := handleGHSearch(t.Context(), []string{
		"prs",
		"cache",
		"-R", "openclaw/octopool",
		"--branch", "feature",
		"--json", "number,title,url",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}
