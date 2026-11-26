package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestRunGHRepoViewNodeID(t *testing.T) {
	for _, test := range []struct {
		name   string
		node   any
		fields string
		want   string
	}{
		{"node ID", "R_repository", "id", `{"id":"R_repository"}`},
		{"mixed fields", "R_repository", "id,nameWithOwner", `{"id":"R_repository","nameWithOwner":"acme/repo"}`},
		{"missing", nil, "id,nameWithOwner", ""},
		{"null", json.RawMessage(`null`), "id,nameWithOwner", ""},
		{"numeric", 42, "id,nameWithOwner", ""},
		{"empty", "", "id,nameWithOwner", ""},
		{"whitespace", " \t", "id,nameWithOwner", ""},
		{"ID not selected", nil, "nameWithOwner", `{"nameWithOwner":"acme/repo"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			relayTestServer(t, func(request map[string]any) any {
				if request["path"] != "/repos/acme/repo" {
					t.Errorf("path = %v", request["path"])
				}
				repository := map[string]any{"id": 42, "full_name": "acme/repo"}
				if test.node != nil {
					repository["node_id"] = test.node
				}
				return repository
			})
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{"repo", "view", "acme/repo", "--json", test.fields}, &out)
			if test.want == "" {
				if result.action != ghFail || !isLocalFallback(result.err) || out.Len() != 0 {
					t.Fatalf("expected typed fallback without output: action=%v err=%v out=%q", result.action, result.err, out.String())
				}
				return
			}
			if result.action != ghComplete || result.err != nil || out.String() != test.want+"\n" {
				t.Fatalf("action=%v err=%v out=%q want=%q", result.action, result.err, out.String(), test.want)
			}
		})
	}
}

func TestRunGHRepoDescription(t *testing.T) {
	for _, command := range []string{"view", "search"} {
		for _, tc := range []struct {
			name        string
			present     bool
			description any
			want        string
		}{
			{"missing", false, nil, ""},
			{"null", true, nil, ""},
			{"empty", true, "", ""},
			{"text", true, "A repository", "A repository"},
		} {
			for _, format := range []string{"json", "jq value", "jq type", "unselected"} {
				t.Run(command+"/"+tc.name+"/"+format, func(t *testing.T) {
					if strings.HasPrefix(format, "jq") && !jqAvailable() {
						t.Skip("jq unavailable")
					}
					requests := 0
					relayTestServer(t, func(request map[string]any) any {
						requests++
						path := "/repos/acme/repo"
						if command == "search" {
							path = "/search/repositories"
						}
						if request["path"] != path {
							t.Errorf("path = %v", request["path"])
						}
						repository := map[string]any{"name": "repo"}
						if tc.present {
							repository["description"] = tc.description
						}
						if command == "search" {
							return map[string]any{"items": []any{repository}}
						}
						return repository
					})
					args := []string{"repo", "view", "acme/repo", "--json", "description"}
					selector := ".description"
					if command == "search" {
						args = []string{"search", "repos", "synthetic", "--json", "description"}
						selector = ".[0].description"
					}
					want := fmt.Sprintf("{\"description\":%q}\n", tc.want)
					switch format {
					case "jq value":
						args = append(args, "--jq", selector)
						want = tc.want + "\n"
					case "jq type":
						args = append(args, "--jq", selector+" | type")
						want = "string\n"
					case "unselected":
						args[len(args)-1] = "name"
						want = "{\"name\":\"repo\"}\n"
					}
					if command == "search" && !strings.HasPrefix(format, "jq") {
						want = "[" + strings.TrimSuffix(want, "\n") + "]\n"
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

func TestRunGHRepoViewNullResponse(t *testing.T) {
	relayTestServer(t, func(map[string]any) any { return nil })
	var out bytes.Buffer
	err := runGH(t.Context(), []string{"repo", "view", "acme/repo", "--json", "description"}, &out, io.Discard)
	if err != nil || out.String() != "{}\n" {
		t.Fatalf("err=%v output=%q", err, out.String())
	}
}

func TestRunGHSearchReposPreservesUnrelatedValues(t *testing.T) {
	relayTestServer(t, func(map[string]any) any {
		return map[string]any{"items": []any{nil, 42, "synthetic", map[string]any{"description": true}}}
	})
	var out bytes.Buffer
	err := runGH(t.Context(), []string{"search", "repos", "synthetic", "--json", "description"}, &out, io.Discard)
	if err != nil || out.String() != "[null,42,\"synthetic\",{\"description\":true}]\n" {
		t.Fatalf("err=%v output=%q", err, out.String())
	}
}

func TestRunGHRepoViewUnsupportedFieldsDelegate(t *testing.T) {
	for _, field := range []string{"full_name", "stargazers_count", "forks_count", "open_issues_count", "diskUsage"} {
		t.Run(field, func(t *testing.T) {
			calls := 0
			relayTestServer(t, func(map[string]any) any {
				calls++
				return map[string]any{"name": "repo", field: 42}
			})
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{"repo", "view", "acme/repo", "--json", "name," + field}, &out)
			if result.action != ghDelegate || result.err != nil || calls != 0 || out.Len() != 0 {
				t.Fatalf("action=%v err=%v calls=%d out=%q", result.action, result.err, calls, out.String())
			}
		})
	}
}

func TestRunGHRepoViewNodeIDFallback(t *testing.T) {
	for _, active := range []bool{false, true} {
		for _, noFallback := range []bool{false, true} {
			t.Run(fmt.Sprintf("active=%v/no-fallback=%v", active, noFallback), func(t *testing.T) {
				policy := rewriteEmptyTestPolicy
				if active {
					policy = rewriteActiveTestPolicy
				}
				_, policies := rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					request := decodeCLIRequest(t, w, r)
					if request["path"] != "/repos/acme/repo" {
						t.Errorf("path = %v", request["path"])
					}
					writeCLIEnvelope(t, w, map[string]any{"id": 42, "full_name": "acme/repo"})
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				if noFallback {
					t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				}
				capture := captureRewriteGH(t)
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), []string{"repo", "view", "acme/repo", "--json", "id,nameWithOwner"}, &out, &stderr)
				if noFallback {
					if !isLocalFallback(err) || out.Len() != 0 || stderr.Len() != 0 {
						t.Fatalf("err=%v stdout=%q stderr=%q", err, out.String(), stderr.String())
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("disabled fallback ran native child")
					}
					return
				}
				if err != nil || out.String() != "child stdout\n" || policies.Load() != 3 {
					t.Fatalf("err=%v stdout=%q policies=%d", err, out.String(), policies.Load())
				}
				got := readRewriteCapture(t, capture)
				if active && got.Env["GH_HOST"] != "github.com" {
					t.Fatalf("guarded fallback host = %q", got.Env["GH_HOST"])
				}
			})
		}
	}
}

func TestRunGHReleaseListRelays(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases" {
			t.Fatalf("path = %v", body["path"])
		}
		query, ok := body["query"].(map[string]any)
		if !ok || query["per_page"] != "10" {
			t.Fatalf("query = %#v", body["query"])
		}
		return []map[string]any{{
			"tag_name": "v0.2.5",
			"name":     "0.2.5",
			"draft":    false,
		}}
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{
		"release", "list",
		"-R", "openclaw/octopool",
		"--limit", "10",
		"--json", "tagName,name,isDraft",
	}, &out)
	assertGHComplete(t, result)
	if got := out.String(); !strings.Contains(got, `"tagName":"v0.2.5"`) || !strings.Contains(got, `"isDraft":false`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseListUnsupportedFieldsDelegate(t *testing.T) {
	for _, field := range []string{"id", "url", "body", "isLatest", "isImmutable"} {
		t.Run(field, func(t *testing.T) {
			calls := 0
			relayTestServer(t, func(map[string]any) any {
				calls++
				return []map[string]any{{"name": "release", field: "value"}}
			})
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{"release", "list", "-R", "acme/repo", "--json", "name," + field}, &out)
			if result.action != ghDelegate || result.err != nil || calls != 0 || out.Len() != 0 {
				t.Fatalf("action=%v err=%v calls=%d out=%q", result.action, result.err, calls, out.String())
			}
		})
	}
}

func TestRunGHReleaseViewRelaysTag(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases/tags/v0.2.5" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "release-summary-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		return map[string]any{
			"tag_name": "v0.2.5",
			"name":     "0.2.5",
		}
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{
		"release", "view",
		"v0.2.5",
		"-R", "openclaw/octopool",
		"--json", "tagName,name",
	}, &out)
	assertGHComplete(t, result)
	if got := out.String(); !strings.Contains(got, `"tagName":"v0.2.5"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseViewPreservesRawBody(t *testing.T) {
	const source = "\r\n## Notes\r\n\r\n### Fixes\r\n\r\n- Keep `code`.\r\n- See [docs][ref].  \r\n\r\n```go\r\n\tfmt.Println(\"café 🦞\")  \r\n```\r\n\r\n[ref]: https://example.test \"Docs\"\r\n\r\n"
	for _, tag := range []string{"v0.8.0", ""} {
		for _, body := range []string{source, ""} {
			for _, projection := range []string{"body", "tagName,body", "jq"} {
				t.Run(tag+"/"+projection+"/empty="+fmt.Sprint(body == ""), func(t *testing.T) {
					path := "/repos/openclaw/octopool/releases/latest"
					args := []string{"view"}
					if tag != "" {
						path = "/repos/openclaw/octopool/releases/tags/" + tag
						args = append(args, tag)
					}
					relayTestServer(t, func(request map[string]any) any {
						if request["path"] != path {
							t.Fatalf("path = %v, want %s", request["path"], path)
						}
						return map[string]any{"tag_name": "v0.8.0", "body": body, "draft": false}
					})
					args = append(args, "-R", "openclaw/octopool", "--json")
					if projection == "jq" {
						args = append(args, "tagName,body", "--jq", ".body | @json")
					} else {
						args = append(args, projection)
					}
					var out bytes.Buffer
					result := runGHTopLevel(t.Context(), append([]string{"release"}, args...), &out)
					assertGHComplete(t, result)
					var got string
					if projection == "jq" {
						if err := json.Unmarshal(out.Bytes(), &got); err != nil {
							t.Fatal(err)
						}
					} else {
						var fields map[string]json.RawMessage
						if err := json.Unmarshal(out.Bytes(), &fields); err != nil {
							t.Fatal(err)
						}
						if err := json.Unmarshal(fields["body"], &got); err != nil {
							t.Fatal(err)
						}
						if len(fields) != len(strings.Split(projection, ",")) {
							t.Fatalf("unexpected fields: %s", out.Bytes())
						}
					}
					if got != body {
						t.Fatalf("body = %q, want %q", got, body)
					}
				})
			}
		}
	}
}

func TestRunGHReleaseViewIDStaysLocal(t *testing.T) {
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{
		"release", "view",
		"v0.2.5",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHReleaseViewTagRouting(t *testing.T) {
	for _, test := range []struct {
		name, tag, path, output string
	}{
		{"numeric", "20240530", "/repos/openclaw/octopool/releases/tags/20240530", `"tagName":"20240530"`},
		{"slash escaped once", "release/1.0", "/repos/openclaw/octopool/releases/tags/release%2F1.0", `"tagName":"release/1.0"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			relayTestServer(t, func(body map[string]any) any {
				if body["path"] != test.path {
					t.Fatalf("path = %v", body["path"])
				}
				return map[string]any{"tag_name": test.tag}
			})
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{
				"release", "view", test.tag,
				"-R", "openclaw/octopool", "--json", "tagName",
			}, &out)
			assertGHComplete(t, result)
			if got := out.String(); !strings.Contains(got, test.output) {
				t.Fatalf("out = %s", got)
			}
		})
	}
}

func TestRunGHWorkflowListRelays(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/actions/workflows" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "workflow-list-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		query, _ := body["query"].(map[string]any)
		if query["per_page"] != "50" || query["page"] != "1" {
			t.Fatalf("query = %#v", query)
		}
		return map[string]any{"workflows": []map[string]any{
			{
				"id":    1,
				"name":  "CI",
				"path":  ".github/workflows/ci.yml",
				"state": "active",
			},
			{
				"id":    2,
				"name":  "Disabled",
				"path":  ".github/workflows/disabled.yml",
				"state": "disabled_manually",
			},
		}}
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{
		"workflow", "list",
		"-R", "openclaw/octopool",
		"--json", "id,name,path,state",
	}, &out)
	assertGHComplete(t, result)
	if got := out.String(); !strings.Contains(got, `"name":"CI"`) {
		t.Fatalf("out = %s", got)
	}
	if got := out.String(); strings.Contains(got, "Disabled") {
		t.Fatalf("disabled workflow leaked into output: %s", got)
	}
}

func TestRunGHWorkflowViewUsesPublicShape(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/actions/workflows/ci.yml" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "workflow-view-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		return map[string]any{
			"id":    1,
			"name":  "CI",
			"path":  ".github/workflows/ci.yml",
			"state": "active",
		}
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{
		"workflow", "view",
		"ci.yml",
		"-R", "openclaw/octopool",
		"--json", "id,name,path,state",
	}, &out)
	assertGHComplete(t, result)
}

func TestRunGHLabelListDelegates(t *testing.T) {
	for _, fields := range []string{"name", "id", "url", "id,name,url,color,description"} {
		t.Run(fields, func(t *testing.T) {
			calls := 0
			relayTestServer(t, func(map[string]any) any {
				calls++
				// REST orders labels by name, and its IDs and URLs differ from gh's.
				return []map[string]any{
					{"id": 2, "node_id": "LA_later", "name": "a-later", "url": "https://api.github.com/repos/acme/repo/labels/a-later"},
					{"id": 1, "node_id": "LA_first", "name": "z-first", "url": "https://api.github.com/repos/acme/repo/labels/z-first"},
				}
			})
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), []string{"label", "list", "-R", "acme/repo", "--limit", "2", "--json", fields}, &out)
			if result.action != ghDelegate || result.err != nil || calls != 0 || out.Len() != 0 {
				t.Fatalf("action=%v err=%v calls=%d output=%q", result.action, result.err, calls, out.String())
			}
		})
	}
}

func TestRunGHLabelListNativeHandoff(t *testing.T) {
	for _, test := range []struct {
		name, policy, repo string
		blocked            bool
	}{
		{"empty policy", rewriteEmptyTestPolicy, "acme/repo", false},
		{"active policy", rewriteActiveTestPolicy, "acme/repo", false},
		{"blocked repository", rewriteActiveTestPolicy, "acme/internal-model", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := 0
			rewriteTestServer(t, test.policy, func(w http.ResponseWriter, r *http.Request) {
				data++
				t.Error("native label list reached relay data")
				w.WriteHeader(400)
			})
			capture := captureRewriteGH(t)
			t.Setenv("GH_HOST", "")
			t.Setenv("GH_REPO", "")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			args := []string{"label", "list", "--repo=" + test.repo, "--limit=2", "--json=id,name,url"}
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			if test.blocked {
				if err != errRewriteBlocked || out.Len() != 0 || data != 0 {
					t.Fatalf("err=%v out=%q data=%d", err, out.String(), data)
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("blocked repository reached native child")
				}
				return
			}
			if err != nil || data != 0 || out.String() != "child stdout\n" {
				t.Fatalf("err=%v data=%d out=%q", err, data, out.String())
			}
			got := readRewriteCapture(t, capture)
			if !slices.Equal(got.Args, args) {
				t.Fatalf("native arguments = %q, want %q", got.Args, args)
			}
			if test.policy == rewriteActiveTestPolicy && got.Env["GH_HOST"] != "github.com" {
				t.Fatalf("guarded native host = %q", got.Env["GH_HOST"])
			}
		})
	}
}

func TestRunGHGistViewRelaysPublicGist(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/gists/abc123" {
			t.Fatalf("path = %v", body["path"])
		}
		return map[string]any{"id": "abc123", "html_url": "https://gist.github.com/abc123", "public": true}
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{
		"gist", "view",
		"abc123",
		"--json", "id,url,isPublic",
	}, &out)
	assertGHComplete(t, result)
	if got := out.String(); !strings.Contains(got, `"isPublic":true`) || !strings.Contains(got, `"url":"https://gist.github.com/abc123"`) {
		t.Fatalf("out = %s", got)
	}
}
