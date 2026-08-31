package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

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
