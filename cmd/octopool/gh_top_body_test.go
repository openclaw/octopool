package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestRunGHIssuePRBody(t *testing.T) {
	for _, kind := range []string{"issue", "pr"} {
		for _, command := range []string{"view", "list", "list search", "search"} {
			for _, tc := range []struct {
				name    string
				present bool
				body    any
				want    string
			}{
				{"missing", false, nil, ""},
				{"null", true, nil, ""},
				{"empty", true, "", ""},
				{"text", true, "\r\n# Notes\nKeep `code` and café.\n", "\r\n# Notes\nKeep `code` and café.\n"},
			} {
				for _, format := range []string{"json", "jq value", "jq type", "unselected"} {
					// List-search intentionally rejects an absent selected field.
					if command == "list search" && !tc.present && format != "unselected" {
						continue
					}
					t.Run(kind+"/"+command+"/"+tc.name+"/"+format, func(t *testing.T) {
						if strings.HasPrefix(format, "jq") && !jqAvailable() {
							t.Skip("jq unavailable")
						}
						requests := 0
						relayTestServer(t, func(request map[string]any) any {
							requests++
							path := "/repos/acme/repo/issues"
							if kind == "pr" {
								path = "/repos/acme/repo/pulls"
							}
							if command == "view" {
								path += "/7"
							} else if command == "search" || command == "list search" {
								path = "/search/issues"
							}
							if request["path"] != path {
								t.Errorf("path = %v, want %s", request["path"], path)
							}
							item := map[string]any{"number": 7}
							if tc.present {
								item["body"] = tc.body
							}
							if command == "view" {
								return item
							}
							if command == "search" || command == "list search" {
								return map[string]any{"items": []any{item}}
							}
							return []any{item}
						})
						args := []string{kind, "list"}
						switch command {
						case "view":
							args = []string{kind, "view", "7"}
						case "list search":
							args = append(args, "--search", "cache")
						case "search":
							plural := "issues"
							if kind == "pr" {
								plural = "prs"
							}
							args = []string{"search", plural, "cache"}
						}
						args = append(args, "-R", "acme/repo", "--json", "body")
						selector := ".body"
						if command != "view" {
							selector = ".[0].body"
						}
						var expected any = map[string]any{"body": tc.want}
						var want string
						switch format {
						case "jq value":
							args = append(args, "--jq", selector)
							want = tc.want + "\n"
						case "jq type":
							args = append(args, "--jq", selector+" | type")
							want = "string\n"
						case "unselected":
							args[len(args)-1] = "number"
							expected = map[string]any{"number": 7}
						}
						if !strings.HasPrefix(format, "jq") {
							if command != "view" {
								expected = []any{expected}
							}
							raw, err := json.Marshal(expected)
							if err != nil {
								t.Fatal(err)
							}
							want = string(raw) + "\n"
						}
						var out bytes.Buffer
						err := runGH(t.Context(), args, &out, io.Discard)
						if err != nil || requests != 1 || out.String() != want {
							t.Fatalf("err=%v requests=%d output=%q; want one request and %q", err, requests, out.String(), want)
						}
					})
				}
			}
		}
	}
}

func TestRunGHIssuePRBodyPreservesOtherValues(t *testing.T) {
	for _, kind := range []string{"issue", "pr"} {
		for _, tc := range []struct{ command, raw, want string }{
			{"view", `null`, "{}\n"},
			{"view", `{"body":42}`, "{\"body\":42}\n"},
			{"list", `[{"body":42}]`, "[{\"body\":42}]\n"},
			{"list", `null`, "[]\n"},
			{"list", `[null]`, "[{}]\n"},
		} {
			t.Run(kind+"/"+tc.command+"/"+tc.raw, func(t *testing.T) {
				relayTestServer(t, func(map[string]any) any { return json.RawMessage(tc.raw) })
				args := []string{kind, tc.command}
				if tc.command == "view" {
					args = append(args, "7")
				}
				args = append(args, "-R", "acme/repo", "--json", "body")
				want := tc.want
				if kind == "pr" && tc.command == "list" {
					if tc.raw == `null` {
						want = "null\n"
					} else if tc.raw == `[null]` {
						want = "[null]\n"
					}
				}
				var out bytes.Buffer
				err := runGH(t.Context(), args, &out, io.Discard)
				if err != nil || out.String() != want {
					t.Fatalf("err=%v output=%q, want %q", err, out.String(), want)
				}
			})
		}
	}
}

func TestRunGHListSearchBodyValidation(t *testing.T) {
	for _, kind := range []string{"issue", "pr"} {
		for _, raw := range []string{`{}`, `{"body":42}`} {
			t.Run(kind+"/"+raw, func(t *testing.T) {
				relayTestServer(t, func(map[string]any) any {
					return map[string]any{"items": []any{json.RawMessage(raw)}}
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				var out bytes.Buffer
				err := runGH(t.Context(), []string{kind, "list", "--search", "cache", "-R", "acme/repo", "--json", "body"}, &out, io.Discard)
				if !isLocalFallback(err) || out.Len() != 0 {
					t.Fatalf("err=%v output=%q, want fallback without output", err, out.String())
				}
			})
		}
	}
}
