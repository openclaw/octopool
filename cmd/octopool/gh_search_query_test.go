package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestScopedSearchGrammar(t *testing.T) {
	allowed := []string{
		"Cache-Hit v1.2 under_score", `"Case Sensitive" "C++ crash?!" "(batch" "OR AND NOT"`,
		"-needle is:public -is:open type:pr -type:issue state:closed -state:open",
		"is:merged is:unmerged is:issue is:pr is:draft is:locked is:unlocked",
		"label:area/ui -label:bug", `label:"good first issue" milestone:"Release 1.0!" -milestone:v1.2`,
		"no:label no:milestone no:assignee -no:assignee", "in:title,body in:comments,title -in:body",
		"draft:true -draft:false review:none review:required review:approved review:changes_requested",
		"status:pending status:success -status:failure base:release/v1.2 head:fix/search_qualifiers-1",
	}
	for _, qualifier := range []string{"author", "assignee", "mentions", "commenter", "involves", "reviewed-by", "review-requested"} {
		allowed = append(allowed, qualifier+":Alice-123 -"+qualifier+":app/dependabot")
	}
	for _, qualifier := range []string{"created", "updated", "closed", "merged"} {
		for _, value := range []string{"2026-10-01", ">2026-10-01", ">=2026-10-01", "<2026-10-01", "<=2026-10-01", "2026-09-01..2026-10-01"} {
			allowed = append(allowed, qualifier+":"+value)
		}
	}
	for _, qualifier := range []string{"created", "updated", "comments", "reactions"} {
		for _, suffix := range []string{"", "-asc", "-desc"} {
			allowed = append(allowed, "sort:"+qualifier+suffix)
		}
	}
	for _, raw := range allowed {
		t.Run("allow/"+raw, func(t *testing.T) {
			q, ok := scopedSearchQuery("OpenClaw/OctoPool", "pr", raw, ghTopOptions{})
			if !ok || q != "repo:OpenClaw/OctoPool type:pr "+raw {
				t.Fatalf("q=%q ok=%v", q, ok)
			}
		})
	}
	denied := []string{
		"repo:other/private", "-repo:other/private", "org:other", "user:alice", "owner:alice",
		"OR", "and", "Not", "-OR", "(cache)", "cache)", "is:private", "-is:public",
		"author:@me", "assignee:team/name", "author:alice_bob", "author:" + strings.Repeat("a", 40),
		"in:title,", "in:title,,body", "in:title,unknown", "draft:yes", "review:commented", "status:error",
		"base:owner:main", "head:owner:feature", "sort:stars", "sort:updated-descending",
		"updated:2026-9-26", "created:2026-13-01", "closed:2026-01-32", "merged:>=2026-09-01..2026-09-26",
		"updated:2026-09-26T12:00:00Z", "closed:*..2026-09-26", "created:", `author:"alice"`,
		`label:""`, `milestone:"   "`, `label:"bug"repo:other/private`, `label:"bug""fix"`,
		`"phrase"OR`, `"repo:other/private"`, `label:"repo:other/private"`, `"unterminated`, `""`,
		`"escaped\" repo:other/private"`, `"back\slash"`, "\"line\nbreak\"", `-"quoted phrase"`,
		"needle\x00", "needle\u00a0other", "--needle", "-", "unknown:qualifier", "STATE:open", "state:OPEN",
	}
	for _, raw := range denied {
		t.Run("deny/"+raw, func(t *testing.T) {
			if q, ok := scopedSearchQuery("openclaw/octopool", "pr", raw, ghTopOptions{}); ok {
				t.Fatalf("accepted %q", q)
			}
		})
	}
	for _, raw := range []string{strings.Repeat("x ", 127), strings.Repeat("x", 4096)} {
		if _, ok := scopedSearchQuery("openclaw/octopool", "pr", raw, ghTopOptions{}); ok {
			t.Fatal("ignored final query bound")
		}
	}
}

func TestTopSearchQualifiedQueryAndNativeExport(t *testing.T) {
	for _, kind := range []string{"prs", "issues"} {
		t.Run(kind, func(t *testing.T) {
			relayTestServer(t, func(body map[string]any) any {
				entity := "pr"
				if kind == "issues" {
					entity = "issue"
				}
				q := `repo:openclaw/octopool type:` + entity + ` updated:>=2026-10-01 worker "Cache Hit" -label:bug in:title,body`
				if body["query"].(map[string]any)["q"] != q {
					t.Fatalf("request=%v", body)
				}
				return map[string]any{"items": []any{map[string]any{"number": 1, "title": "Worker", "user": map[string]any{"node_id": "U_1", "login": "alice", "type": "User", "html_url": "https://github.com/alice", "id": 123}, "closed_at": nil}}}
			})
			var out bytes.Buffer
			result := handleGHSearch(t.Context(), []string{kind, "--repo", "openclaw/octopool", "--json", "number,title,author,closedAt", "--", "updated:>=2026-10-01", "worker", "Cache Hit", "-label:bug", "in:title,body"}, &out)
			want := `[{"author":{"id":"U_1","is_bot":false,"login":"alice","type":"User","url":"https://github.com/alice"},"closedAt":"0001-01-01T00:00:00Z","number":1,"title":"Worker"}]` + "\n"
			if result.err != nil || result.action != ghComplete || out.String() != want {
				t.Fatalf("result=%+v out=%s", result, out.String())
			}
		})
	}
}

func TestListSearchHumanAndIncompleteFallback(t *testing.T) {
	for _, kind := range []string{"pr", "issue"} {
		t.Run(kind+" human", func(t *testing.T) {
			relayTestServer(t, func(body map[string]any) any { t.Fatalf("unexpected relay %v", body); return nil })
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{kind, "list", "-R", "openclaw/octopool", "--search", "cache"}, &out)
			if result.action != ghDelegate || out.Len() != 0 {
				t.Fatalf("result=%+v out=%s", result, out.String())
			}
		})
	}
	for _, body := range []any{
		map[string]any{"incomplete_results": true, "items": []any{}},
		map[string]any{"items": nil},
		map[string]any{"items": []any{map[string]any{"number": 1, "state": "closed"}}},
	} {
		relayTestServer(t, func(map[string]any) any { return body })
		var out bytes.Buffer
		result := handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool", "--search", "cache", "--json", "number,state"}, &out)
		if !isLocalFallback(result.err) || out.Len() != 0 {
			t.Fatalf("result=%+v out=%s", result, out.String())
		}
	}
}

func TestSearchJSONPreservesNativeEscapingAndJQ(t *testing.T) {
	for _, command := range [][]string{{"pr", "list", "--search", "cache"}, {"search", "prs", "cache"}} {
		for _, jq := range []string{"", ".[0].title"} {
			t.Run(strings.Join(command, " ")+"/"+jq, func(t *testing.T) {
				if jq != "" && !jqAvailable() {
					t.Skip("jq is not installed")
				}
				relayTestServer(t, func(map[string]any) any {
					return map[string]any{"items": []any{map[string]any{"number": 1, "title": "<cache> & relay"}}}
				})
				args := append(append([]string{}, command...), "-R", "openclaw/octopool", "--json", "title,number")
				want := `[{"number":1,"title":"<cache> & relay"}]` + "\n"
				if jq != "" {
					args = append(args, "--jq", jq)
					want = "<cache> & relay\n"
				}
				var out bytes.Buffer
				result := runGHTopLevel(t.Context(), args, &out)
				if result.err != nil || out.String() != want {
					t.Fatalf("result=%+v output=%q", result, out.String())
				}
			})
		}
	}
}

func TestTopSearchArgumentQuoting(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		want    string
		allowed bool
	}{
		{[]string{"cache", "regression"}, "cache regression", true},
		{[]string{"cache regression"}, `"cache regression"`, true},
		{[]string{"label:good first issue"}, `label:"good first issue"`, true},
		{[]string{`"cache regression"`}, `"\"cache regression\""`, false},
		{[]string{"updated:>=2026-10-01 worker"}, `updated:">=2026-10-01 worker"`, false},
		{[]string{"label:bug repo:other/private"}, `label:"bug repo:other/private"`, false},
	} {
		t.Run(tc.want, func(t *testing.T) {
			query := topSearchQuery(tc.args)
			_, ok := scopedSearchQuery("openclaw/octopool", "pr", query, ghTopOptions{})
			if query != tc.want || ok != tc.allowed {
				t.Fatalf("query=%q allowed=%v", query, ok)
			}
		})
	}
}

func TestPRListSearchCreatedAtStaysNative(t *testing.T) {
	// Live openclaw/octopool#208: GraphQL PR createdAt is 22:28:12Z,
	// while the search issue's created_at is 22:28:13Z on 2026-09-28.
	relayTestServer(t, func(body map[string]any) any { t.Fatalf("unexpected relay: %v", body); return nil })
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool", "--search", "cache", "--json", "number,createdAt"}, &out)
	if result.action != ghDelegate || out.Len() != 0 {
		t.Fatalf("result=%+v output=%q", result, out.String())
	}
}
