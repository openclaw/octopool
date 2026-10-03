package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestListSearchQuery(t *testing.T) {
	for _, kind := range []string{"pr", "issue"} {
		for _, tc := range []struct{ state, search, suffix string }{
			{"", "Gateway", "state:open Gateway"},
			{"open", "updated:>=2026-10-01 Gateway", "state:open updated:>=2026-10-01 Gateway"},
			{"closed", "cache", "state:closed cache"},
			{"all", "cache", "cache"},
			{"merged", "relay in:title", "is:merged relay in:title"},
			{"open", "is:closed cache", "is:closed cache"},
			{"", "is:merged cache", "is:merged cache"},
			{"open", "closed:>=2026-10-01 cache", "closed:>=2026-10-01 cache"},
			{"", "merged:2026-10-01 cache", "merged:2026-10-01 cache"},
			{"", `cold in:title,body -label:bug "Case Sensitive"`, `state:open cold in:title,body -label:bug "Case Sensitive"`},
		} {
			if kind == "issue" && tc.state == "merged" {
				continue
			}
			t.Run(kind+"/"+tc.state+"/"+tc.search, func(t *testing.T) {
				calls := 0
				t.Setenv("OCTOPOOL_FRESH", "")
				relayTestServer(t, func(body map[string]any) any {
					calls++
					want := "repo:openclaw/octopool type:" + kind + " " + tc.suffix + ` author:Alice label:bug label:"good first issue"`
					if body["path"] != "/search/issues" || !reflect.DeepEqual(body["query"], map[string]any{"q": want, "per_page": "5"}) {
						t.Fatalf("request = %#v, want q %s", body, want)
					}
					if body["headers"].(map[string]any)["cache-control"] != nil {
						t.Fatal("search bypassed cache")
					}
					return map[string]any{"items": []any{}}
				})
				args := []string{kind, "list", "-R", "openclaw/octopool", "--search", tc.search, "--author", "Alice", "--label", "bug,good first issue", "--json", "state", "--limit", "5"}
				if tc.state != "" {
					args = append(args, "--state", tc.state)
				}
				var out bytes.Buffer
				result := runGHTopLevel(t.Context(), args, &out)
				if result.err != nil || result.action != ghComplete || out.String() != "[]\n" || calls != 1 {
					t.Fatalf("result=%+v out=%q calls=%d", result, out.String(), calls)
				}
			})
		}
	}
}

func TestListSearchRejectsBeforeRelay(t *testing.T) {
	for _, kind := range []string{"pr", "issue"} {
		for _, extra := range [][]string{
			{"--search", "cache OR worker"}, {"--search", "cache AND worker"}, {"--search", "NOT worker"},
			{"--search", "(cache)"}, {"--search", "org:openclaw cache"}, {"--search", "user:alice"},
			{"--search", "repo:openclaw/octopool cache"}, {"--search", "-repo:other/private"},
			{"--search", "author:@me"}, {"--search", "is:private"}, {"--search", "in:title,unknown"},
			{"--search", ""}, {"--search", `label:"unterminated`},
			{"--search", "cache", "--author", "@me"}, {"--search", "cache", "--assignee", "@me"},
			{"--search", "cache", "--author", "alice org:other"},
			{"--search", "cache", "--label", `"a,b"`}, {"--search", "cache", "--label", `""`},
			{"--search", "cache", "--json", "number,headRefName"}, {"--search", "cache", "--json", "headRefOid"},
			{"--search", "cache", "--json", "files"}, {"--search", "cache", "--json", "milestone"},
			{"--search", "cache", "--limit", "101"}, {"--search", strings.Repeat("x", 4096)},
			{"--search", strings.Repeat("x ", 126)},
		} {
			t.Run(kind+"/"+strings.Join(extra, " "), func(t *testing.T) {
				relayTestServer(t, func(body map[string]any) any { t.Fatalf("unexpected relay: %#v", body); return nil })
				var out bytes.Buffer
				args := append([]string{kind, "list", "-R", "openclaw/octopool", "--json", "number"}, extra...)
				result := runGHTopLevel(t.Context(), args, &out)
				if result.action != ghDelegate && !isLocalFallback(result.err) {
					t.Fatalf("result=%+v", result)
				}
				if out.Len() != 0 {
					t.Fatalf("partial output %q", out.String())
				}
			})
		}
	}
}

func TestListSearchNativeJSON(t *testing.T) {
	for _, kind := range []string{"pr", "issue"} {
		t.Run(kind, func(t *testing.T) {
			calls := map[string]int{}
			t.Setenv("OCTOPOOL_FRESH", "1")
			relayTestServer(t, func(body map[string]any) any {
				path := body["path"].(string)
				calls[path]++
				headers := body["headers"].(map[string]any)
				if path == "/users/alice" {
					if headers["cache-control"] != "max-age=3600" {
						t.Fatalf("profile headers=%v", headers)
					}
					return map[string]any{"id": 1, "node_id": "U_1", "login": "alice", "type": "User", "name": nil}
				}
				if path != "/search/issues" || headers["cache-control"] != "max-age=0" {
					t.Fatalf("request=%v", body)
				}
				var items []any
				for i, user := range []any{
					map[string]any{"node_id": "U_1", "login": "alice", "type": "User", "html_url": "https://github.com/alice"},
					map[string]any{"node_id": "B_1", "login": "dependabot[bot]", "type": "Bot"},
					nil,
					map[string]any{"node_id": "U_1", "login": "alice", "type": "User"},
				} {
					item := map[string]any{"number": i + 1, "title": "cache", "body": nil, "state": "open", "user": user, "updated_at": "2026-10-01T00:00:00Z", "closed_at": nil, "pull_request": map[string]any{"merged_at": nil}, "draft": true, "labels": []any{map[string]any{"node_id": "L_1", "name": "bug", "color": "ff0000", "description": nil, "url": "ignored"}}}
					if i == 1 {
						item["state"] = "closed"
						item["closed_at"] = "2026-10-02T00:00:00Z"
						item["pull_request"] = map[string]any{"merged_at": "2026-10-02T00:00:00Z"}
					}
					if i == 2 {
						item["state"] = "closed"
					}
					if kind == "issue" {
						delete(item, "pull_request")
					}
					items = append(items, item)
				}
				return map[string]any{"items": items}
			})
			fields := "number,title,updatedAt,author,state,body,closedAt,labels"
			if kind == "pr" {
				fields += ",isDraft,mergedAt"
			}
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{kind, "list", "-R", "openclaw/octopool", "-Scache", "--json", fields}, &out)
			if result.err != nil || result.action != ghComplete {
				t.Fatalf("result=%+v", result)
			}
			var want []map[string]any
			for i, author := range []any{
				map[string]any{"id": "U_1", "is_bot": false, "login": "alice", "name": ""},
				map[string]any{"is_bot": true, "login": "app/dependabot"},
				map[string]any{"is_bot": true, "login": "app/"},
				map[string]any{"id": "U_1", "is_bot": false, "login": "alice", "name": ""},
			} {
				item := map[string]any{"number": i + 1, "title": "cache", "updatedAt": "2026-10-01T00:00:00Z", "author": author, "state": "OPEN", "body": "", "closedAt": nil, "labels": []any{map[string]any{"id": "L_1", "name": "bug", "color": "ff0000", "description": ""}}}
				if kind == "pr" {
					item["isDraft"] = true
					item["mergedAt"] = nil
				}
				if i == 1 {
					item["state"] = "CLOSED"
					item["closedAt"] = "2026-10-02T00:00:00Z"
					if kind == "pr" {
						item["state"] = "MERGED"
						item["mergedAt"] = "2026-10-02T00:00:00Z"
					}
				}
				if i == 2 {
					item["state"] = "CLOSED"
				}
				want = append(want, item)
			}
			encoded, _ := json.Marshal(want)
			if out.String() != string(encoded)+"\n" || calls["/search/issues"] != 1 || calls["/users/alice"] != 1 {
				t.Fatalf("output=%s\nwant=%s\ncalls=%v", out.String(), encoded, calls)
			}
		})
	}
}

func TestSearchRateLimitNativeFallback(t *testing.T) {
	for _, command := range [][]string{{"pr", "list", "--search", "cache"}, {"issue", "list", "--search", "cache"}, {"search", "prs", "cache"}, {"search", "issues", "cache"}} {
		for _, tc := range []struct {
			name     string
			response relayTestResponse
			fallback bool
		}{
			{"secondary 403", relayTestResponse{GitHubStatus: 403, Body: map[string]any{"message": "You have exceeded a secondary rate limit."}}, true},
			{"upstream 429", relayTestResponse{GitHubStatus: 429, Body: map[string]any{"message": "Too many requests"}}, true},
			{"typed rate limit", relayTestResponse{Status: 429, Body: map[string]any{"error": map[string]any{"code": "github_rate_limited"}}}, true},
			{"search denied", relayTestResponse{Status: 403, Body: map[string]any{"error": map[string]any{"code": "search_denied"}}}, true},
			{"worker fallback", relayTestResponse{Status: 424, Body: map[string]any{"error": map[string]any{"code": "fallback_local", "details": map[string]any{"reason": "search_denied"}}}}, true},
			{"auth denial", relayTestResponse{Status: 403, Body: map[string]any{"error": map[string]any{"code": "invalid_auth"}}}, false},
			{"policy denial", relayTestResponse{Status: 403, Body: map[string]any{"error": map[string]any{"code": "string_rewrite_denied"}}}, false},
			{"other upstream 403", relayTestResponse{GitHubStatus: 403, Body: map[string]any{"message": "Forbidden"}}, false},
		} {
			t.Run(strings.Join(command, " ")+"/"+tc.name, func(t *testing.T) {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
				calls := 0
				relayTestServer(t, func(body map[string]any) any { calls++; return tc.response })
				capture := captureRewriteGH(t)
				args := append(append([]string{}, command...), "-R", "openclaw/octopool", "--json", "number,title")
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), args, &out, &stderr)
				_, captureErr := os.Stat(capture)
				wantOutput := ""
				if tc.fallback {
					wantOutput = "child stdout\n"
				}
				if (err == nil) != tc.fallback || (captureErr == nil) != tc.fallback || calls != 1 || out.String() != wantOutput {
					t.Fatalf("err=%v native=%v calls=%d out=%q stderr=%q", err, captureErr, calls, out.String(), stderr.String())
				}
			})
		}
	}
}

func TestListSearchWithActiveProtection(t *testing.T) {
	for _, kind := range []string{"pr", "issue"} {
		for _, query := range []string{"cache", "internal-model"} {
			t.Run(kind+"/"+query, func(t *testing.T) {
				calls := 0
				rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					writeCLIEnvelope(t, w, map[string]any{"items": []any{}})
				})
				capture := captureRewriteGH(t)
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), []string{kind, "list", "-R", "openclaw/octopool", "--search", query, "--json", "number,title"}, &out, &stderr)
				if query == "cache" {
					if err != nil || calls != 1 || out.String() != "[]\n" {
						t.Fatalf("err=%v calls=%d out=%q", err, calls, out.String())
					}
				} else if err == nil || calls != 0 || out.Len() != 0 {
					t.Fatalf("err=%v calls=%d out=%q", err, calls, out.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("unexpected native dispatch")
				}
			})
		}
	}
}
