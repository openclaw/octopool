package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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
			result := handleGHRepo(t.Context(), []string{"view", "acme/repo", "--json", test.fields}, &out)
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

func TestRunGHRepoViewUnsupportedFieldsDelegate(t *testing.T) {
	emptyRewriteTestServer(t)
	var out bytes.Buffer
	result := handleGHRepo(t.Context(), []string{"view", "acme/repo", "--json", "id,diskUsage"}, &out)
	if result.action != ghDelegate || result.err != nil || out.Len() != 0 {
		t.Fatalf("action=%v err=%v out=%q", result.action, result.err, out.String())
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
			"html_url": "https://github.com/openclaw/octopool/releases/tag/v0.2.5",
		}}
	})
	var out bytes.Buffer
	result := handleGHRelease(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--limit", "10",
		"--json", "tagName,name,url",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"v0.2.5"`) || !strings.Contains(got, `"url":"https://github.com/openclaw/octopool/releases/tag/v0.2.5"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseListKeepsIDSupport(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		return []map[string]any{{"id": 123}}
	})
	var out bytes.Buffer
	result := handleGHRelease(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"id":123`) {
		t.Fatalf("out = %s", got)
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
	result := handleGHRelease(t.Context(), []string{
		"view",
		"v0.2.5",
		"-R", "openclaw/octopool",
		"--json", "tagName,name",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
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
					result := handleGHRelease(t.Context(), args, &out)
					if result.err != nil || result.action != ghComplete {
						t.Fatalf("action=%v err=%v", result.action, result.err)
					}
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
	result := handleGHRelease(t.Context(), []string{
		"view",
		"v0.2.5",
		"-R", "openclaw/octopool",
		"--json", "id",
	}, &out)
	if result.err != nil || result.action != ghDelegate {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHReleaseViewKeepsNumericTags(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases/tags/20240530" {
			t.Fatalf("path = %v", body["path"])
		}
		return map[string]any{"tag_name": "20240530"}
	})
	var out bytes.Buffer
	result := handleGHRelease(t.Context(), []string{
		"view",
		"20240530",
		"-R", "openclaw/octopool",
		"--json", "tagName",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"20240530"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestRunGHReleaseViewEscapesSlashTagsOnce(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/releases/tags/release%2F1.0" {
			t.Fatalf("path = %v", body["path"])
		}
		return map[string]any{"tag_name": "release/1.0"}
	})
	var out bytes.Buffer
	result := handleGHRelease(t.Context(), []string{
		"view",
		"release/1.0",
		"-R", "openclaw/octopool",
		"--json", "tagName",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"tagName":"release/1.0"`) {
		t.Fatalf("out = %s", got)
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
	result := handleGHWorkflow(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "id,name,path,state",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
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
	result := handleGHWorkflow(t.Context(), []string{
		"view",
		"ci.yml",
		"-R", "openclaw/octopool",
		"--json", "id,name,path,state",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHLabelListRelays(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/labels" {
			t.Fatalf("path = %v", body["path"])
		}
		headers, ok := body["headers"].(map[string]any)
		if !ok || headers["x-octopool-public-shape"] != "label-list-v1" {
			t.Fatalf("headers = %#v", body["headers"])
		}
		return []map[string]any{{"name": "bug", "color": "d73a4a", "description": "Bug"}}
	})
	var out bytes.Buffer
	result := handleGHLabel(t.Context(), []string{
		"list",
		"-R", "openclaw/octopool",
		"--json", "name,color,description",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"name":"bug"`) {
		t.Fatalf("out = %s", got)
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
	result := handleGHGist(t.Context(), []string{
		"view",
		"abc123",
		"--json", "id,url,isPublic",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"isPublic":true`) || !strings.Contains(got, `"url":"https://gist.github.com/abc123"`) {
		t.Fatalf("out = %s", got)
	}
}
