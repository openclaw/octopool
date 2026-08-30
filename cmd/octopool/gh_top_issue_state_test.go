package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const issueStateTestTime = "2026-08-30T18:20:25Z"

func issueStateFixture(state string) map[string]any {
	var closedAt any
	if strings.EqualFold(state, "closed") {
		closedAt = issueStateTestTime
	}
	return map[string]any{
		"number": float64(5), "title": "Issue fixture", "state": state,
		"closed_at": closedAt, "html_url": "https://github.com/openclaw/octopool/issues/5",
		"user": map[string]any{"login": "octocat"},
	}
}

func TestRunGHIssueViewStateProjection(t *testing.T) {
	t.Setenv("OCTOPOOL_FRESH", "")
	for _, state := range []string{"open", "closed"} {
		for _, source := range []string{"rest", "public", "cached-lowercase-public"} {
			t.Run(state+"/"+source, func(t *testing.T) {
				for _, fields := range []string{
					"state", "state,closedAt", "number,title,state,url,author",
					"number,title,state,closedAt,url,author", "title,closedAt",
				} {
					t.Run(fields, func(t *testing.T) {
						wantShape := "issue-summary-v1"
						if strings.Contains(fields, "closedAt") {
							wantShape = ""
						}
						fixture := issueStateFixture(state)
						if source != "rest" && wantShape != "" {
							delete(fixture, "closed_at")
							if source == "public" {
								fixture["state"] = strings.ToUpper(state)
							}
						}
						before, _ := json.Marshal(fixture)
						calls := 0
						relayTestServer(t, func(request map[string]any) any {
							calls++
							if request["method"] != "GET" || request["path"] != "/repos/openclaw/octopool/issues/5" {
								t.Errorf("unexpected request: %#v", request)
							}
							headers, _ := request["headers"].(map[string]any)
							if shape, _ := headers["x-octopool-public-shape"].(string); shape != wantShape {
								t.Errorf("shape = %q, want %q", shape, wantShape)
							}
							if headers["cache-control"] != "max-age=0" {
								t.Errorf("freshness headers = %#v", headers)
							}
							return fixture
						})
						var out bytes.Buffer
						result := handleGHIssue(t.Context(), []string{"view", "5", "-R", "openclaw/octopool", "--json", fields}, &out)
						if result.action != ghComplete || result.err != nil {
							t.Fatalf("action=%v err=%v", result.action, result.err)
						}
						all := map[string]any{
							"number": float64(5), "title": "Issue fixture", "state": strings.ToUpper(state),
							"closedAt": fixture["closed_at"], "url": fixture["html_url"], "author": fixture["user"],
						}
						want := map[string]any{}
						for _, field := range strings.Split(fields, ",") {
							want[field] = all[field]
						}
						var got map[string]any
						if err := json.Unmarshal(out.Bytes(), &got); err != nil {
							t.Fatal(err)
						}
						if !reflect.DeepEqual(got, want) {
							t.Errorf("projection = %#v, want %#v", got, want)
						}
						after, _ := json.Marshal(fixture)
						if !bytes.Equal(before, after) || calls != 1 {
							t.Errorf("source changed or unexpected request count: before=%s after=%s calls=%d", before, after, calls)
						}
					})
				}
			})
		}
	}
}

func TestRunGHIssueStateProjectionBeforeJQ(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq not installed")
	}
	for _, state := range []string{"open", "closed"} {
		for _, command := range []string{"view", "list"} {
			t.Run(state+"/"+command, func(t *testing.T) {
				relayTestServer(t, func(request map[string]any) any {
					if command == "list" {
						return []any{issueStateFixture(state)}
					}
					return issueStateFixture(state)
				})
				for _, fields := range []string{"state", "state,closedAt", "title"} {
					args := []string{command}
					prefix := ""
					if command == "view" {
						args = append(args, "5")
					} else {
						prefix = ".[0] | "
					}
					expr := `.state == "` + strings.ToUpper(state) + `" and (has("closedAt") == ` + strconv.FormatBool(strings.Contains(fields, "closedAt")) + `) and (has("closed_at") | not)`
					if fields == "title" {
						expr = `keys == ["title"]`
					}
					args = append(args, "-R", "openclaw/octopool", "--json", fields, "--jq", prefix+expr)
					var out bytes.Buffer
					result := handleGHIssue(t.Context(), args, &out)
					if result.action != ghComplete || result.err != nil || out.String() != "true\n" {
						t.Errorf("fields=%s action=%v err=%v jq=%q", fields, result.action, result.err, out.String())
					}
				}
			})
		}
	}
}

func TestRunGHIssueListStateProjection(t *testing.T) {
	for _, fields := range []string{"state", "number,state,closedAt", "number,state,closedAt,milestone"} {
		t.Run(fields, func(t *testing.T) {
			pr := map[string]any{"number": float64(9), "state": "closed", "pull_request": map[string]any{}}
			items := []any{issueStateFixture("open"), pr, issueStateFixture("closed")}
			relayTestServer(t, func(request map[string]any) any {
				query, _ := request["query"].(map[string]any)
				if request["path"] != "/repos/openclaw/octopool/issues" || query["state"] != "all" || query["per_page"] != "100" || query["page"] != "1" {
					t.Errorf("unexpected list request: %#v", request)
				}
				return items
			})
			var out bytes.Buffer
			result := handleGHIssue(t.Context(), []string{"list", "-R", "openclaw/octopool", "--state", "all", "--limit", "2", "--json", fields}, &out)
			if result.action != ghComplete || result.err != nil {
				t.Fatalf("action=%v err=%v", result.action, result.err)
			}
			var got []map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if len(got) != 2 || got[0]["state"] != "OPEN" || got[1]["state"] != "CLOSED" {
				t.Errorf("list projection = %#v", got)
			}
			if strings.Contains(fields, "closedAt") && (got[0]["closedAt"] != nil || got[1]["closedAt"] != issueStateTestTime) {
				t.Errorf("list closedAt = %#v", got)
			}
			if items[0].(map[string]any)["state"] != "open" || items[2].(map[string]any)["state"] != "closed" || pr["state"] != "closed" {
				t.Errorf("source items changed: %#v", items)
			}
		})
	}
}

func TestRunGHIssueStateUnsupportedFieldsDelegate(t *testing.T) {
	emptyRewriteTestServer(t)
	for _, command := range []string{"view", "list"} {
		for _, fields := range []string{"number,title,state,closedAt,url,author,comments", "state,closed", "state,stateReason"} {
			args := []string{command}
			if command == "view" {
				args = append(args, "5")
			}
			args = append(args, "-R", "openclaw/octopool", "--json", fields, "--jq", "{number,state,closedAt}")
			var out bytes.Buffer
			result := handleGHIssue(t.Context(), args, &out)
			if result.action != ghDelegate || result.err != nil || out.Len() != 0 {
				t.Errorf("args=%v action=%v err=%v out=%q", args, result.action, result.err, out.String())
			}
		}
	}
}

func TestRunGHIssueStatePreservesRESTAndSearch(t *testing.T) {
	for _, state := range []string{"open", "closed"} {
		t.Run(state, func(t *testing.T) {
			fixture := issueStateFixture(state)
			relayTestServer(t, func(request map[string]any) any {
				if request["path"] == "/search/issues" {
					return map[string]any{"items": []any{fixture}}
				}
				return fixture
			})
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"api", "repos/openclaw/octopool/issues/5"}, &out, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, fixture) {
				t.Errorf("REST = %#v, want %#v", got, fixture)
			}
			out.Reset()
			result := handleGHSearch(t.Context(), []string{"issues", "cache", "-R", "openclaw/octopool", "--json", "state"}, &out)
			if result.action != ghComplete || result.err != nil || out.String() != "[{\"state\":\""+state+"\"}]\n" {
				t.Errorf("search action=%v err=%v output=%q", result.action, result.err, out.String())
			}
		})
	}
}
