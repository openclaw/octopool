package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func detailComment(id int, login string) map[string]any {
	return map[string]any{
		"id": fmt.Sprintf("IC_%d", id), "author": map[string]any{"login": login, "id": "U_" + strings.ToLower(login)},
		"authorAssociation": "CONTRIBUTOR", "body": "Hello <world>\n", "createdAt": "2026-09-24T01:02:03Z",
		"includesCreatedEdit": true, "isMinimized": false, "minimizedReason": nil,
		"reactionGroups": []any{map[string]any{"content": "HEART", "users": map[string]any{"totalCount": 0}}, map[string]any{"content": "EYES", "users": map[string]any{"totalCount": 2}}},
		"url":            "https://github.com/acme/repo/pull/7#issuecomment-1",
	}
}

func detailCommit() map[string]any {
	return map[string]any{"commit": map[string]any{
		"oid": "abc123", "messageHeadline": "Subject", "messageBody": "Body\n", "committedDate": "2026-09-24T01:02:03Z", "authoredDate": "2026-09-24T01:02:03Z",
		"authors": map[string]any{"nodes": []any{map[string]any{"name": "Unlinked", "email": "synthetic@example.test", "user": nil}}},
	}}
}

func detailResponse(field string, nodes []any, total int, next bool, cursor string) map[string]any {
	return map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{
		"id": "PR_7", "headRefOid": "head", field: map[string]any{"nodes": nodes, "totalCount": total, "pageInfo": map[string]any{"hasNextPage": next, "endCursor": cursor}},
	}}}}
}

func TestPRDetailNativeAssembly(t *testing.T) {
	for _, login := range []string{"alice", "ALICE", "bob", ""} {
		raw, _ := json.Marshal(detailComment(1, login))
		item, key, err := mapPRDetail(raw, "comments", "U_alice")
		encoded, _ := json.Marshal(item)
		var got map[string]any
		_ = json.Unmarshal(encoded, &got)
		if err != nil || key != "IC_1" || got["viewerDidAuthor"] != strings.EqualFold(login, "alice") || got["minimizedReason"] != "" || len(got["reactionGroups"].([]any)) != 1 || len(got["author"].(map[string]any)) != 1 {
			t.Fatalf("comment %q: %s / %v", login, encoded, err)
		}
		if _, _, err := mapPRDetail(raw, "comments", ""); !isLocalFallback(err) {
			t.Fatal("unknown viewer must delegate")
		}
	}
	// Names can change or be reused; only the authenticated immutable ID counts.
	for _, test := range []struct {
		login, id string
		own       bool
	}{
		{"renamed", "U_alice", true}, {"alice", "U_other", false},
	} {
		comment := detailComment(1, test.login)
		comment["author"].(map[string]any)["id"] = test.id
		raw, _ := json.Marshal(comment)
		item, _, err := mapPRDetail(raw, "comments", "U_alice")
		if err != nil || item.(prDetailComment).ViewerDidAuthor != test.own {
			t.Fatalf("renamed viewer: %v / %v", item, err)
		}
	}
	raw, _ := json.Marshal(detailCommit())
	item, _, err := mapPRDetail(raw, "commits", "")
	encoded, _ := json.Marshal(item)
	want := `{"authoredDate":"2026-09-24T01:02:03Z","authors":[{"email":"synthetic@example.test","id":"","login":"","name":"Unlinked"}],"committedDate":"2026-09-24T01:02:03Z","messageBody":"Body\n","messageHeadline":"Subject","oid":"abc123"}`
	if err != nil || string(encoded) != want {
		t.Fatalf("commit: %s / %v", encoded, err)
	}
}

func TestPRDetailPagination(t *testing.T) {
	for _, mode := range []string{"two-pages", "empty", "bound", "changed-total", "changed-id", "duplicate", "short-page", "missing-cursor", "old-worker", "graphql-error", "commits", "commits-over-100", "moved-head"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			field := "comments"
			if strings.HasPrefix(mode, "commits") || mode == "moved-head" {
				field = "commits"
			}
			relayTestServer(t, func(req map[string]any) any {
				calls++
				headers := req["headers"].(map[string]any)
				if headers["cache-control"] != "max-age=0" || headers["x-octopool-public-shape"] != "pr-"+field+"-v1" {
					t.Fatalf("headers %v", headers)
				}
				if calls == 2 && req["query"].(map[string]any)["cursor"] != "page-1" {
					t.Fatal("missing cursor")
				}
				if mode == "old-worker" {
					return map[string]any{"number": 7}
				}
				if mode == "graphql-error" {
					return map[string]any{"errors": []any{map[string]any{"message": "synthetic"}}}
				}
				nodes, total, next, cursor := []any{}, 101, calls == 1, "page-1"
				if calls == 1 {
					for i := 0; i < 100; i++ {
						nodes = append(nodes, detailComment(i, "alice"))
					}
				} else {
					nodes = append(nodes, detailComment(100, "bob"))
				}
				switch mode {
				case "empty":
					nodes, total, next = []any{}, 0, false
				case "bound":
					total = 1001
				case "changed-total":
					if calls == 2 {
						total = 102
					}
				case "duplicate":
					if calls == 2 {
						nodes[0] = detailComment(0, "alice")
					}
				case "short-page":
					nodes = nodes[:1]
				case "missing-cursor":
					cursor = ""
				case "commits", "moved-head":
					nodes, total, next = []any{detailCommit()}, 1, false
				case "commits-over-100":
					nodes = []any{detailCommit()}
				}
				response := detailResponse(field, nodes, total, next, cursor)
				pr := response["data"].(map[string]any)["repository"].(map[string]any)["pullRequest"].(map[string]any)
				if mode == "changed-id" && calls == 2 {
					pr["id"] = "PR_other"
				}
				if mode == "moved-head" {
					pr["headRefOid"] = "other"
				}
				return response
			})
			client, err := newGHRelayClient()
			if err != nil {
				t.Fatal(err)
			}
			items, err := relayPRDetail(t.Context(), client, "acme/repo", "7", field, "U_alice", "head")
			switch mode {
			case "two-pages":
				if err != nil || len(items) != 101 || calls != 2 {
					t.Fatalf("%d items, %d calls, %v", len(items), calls, err)
				}
			case "empty":
				if err != nil || items == nil || len(items) != 0 {
					t.Fatalf("%v / %v", items, err)
				}
			case "commits":
				if err != nil || len(items) != 1 {
					t.Fatalf("%v / %v", items, err)
				}
			case "graphql-error":
				if err == nil || isLocalFallback(err) {
					t.Fatalf("upstream error must not delegate: %v", err)
				}
			default:
				if !isLocalFallback(err) || items != nil {
					t.Fatalf("inconsistent response: %v / %v", items, err)
				}
			}
		})
	}
}

func setPRViewer(t *testing.T, login string) {
	t.Helper()
	// A standalone Go fixture avoids shell scripts and real user config reads.
	path := filepath.Join(t.TempDir(), "viewer.go")
	source := `package main
import("encoding/json";"os";"strings")
func main(){if strings.Join(os.Args[1:]," ")=="api user --hostname=github.com" {json.NewEncoder(os.Stdout).Encode(map[string]string{"node_id":os.Getenv("OCTOPOOL_TEST_VIEWER"),"type":"User"})}}`
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), executableName("gh"))
	if out, err := exec.Command("go", "build", "-o", bin, path).CombinedOutput(); err != nil {
		t.Fatalf("%s: %v", out, err)
	}
	t.Setenv("OCTOPOOL_GH_PATH", bin)
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("OCTOPOOL_TEST_VIEWER", login)
}

func TestPRCommentActiveViewer(t *testing.T) {
	setPRViewer(t, "U_alice")
	relayTestServer(t, func(req map[string]any) any { t.Fatal("identity must not use pool"); return nil })
	client, err := newGHRelayClient()
	if err != nil {
		t.Fatal(err)
	}
	if got, err := localPRCommentViewer(t.Context(), client); got != "U_alice" || err != nil {
		t.Fatalf("viewer %q", got)
	}
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		t.Setenv(key, "synthetic-override")
		if got, err := localPRCommentViewer(t.Context(), client); got != "" || err != nil {
			t.Fatal("token override trusted hosts user")
		}
		t.Setenv(key, "")
	}
	t.Setenv("OCTOPOOL_TEST_VIEWER", "")
	var output bytes.Buffer
	if err := relayPRView(t.Context(), &output, "acme/repo", "7", ghTopOptions{json: []string{"comments"}}); !isLocalFallback(err) || output.Len() != 0 {
		t.Fatalf("unknown viewer: %v", err)
	}
}

func TestPRCommentViewerProtection(t *testing.T) {
	for _, blocked := range []string{"/user", "api.github.com"} {
		t.Run(blocked, func(t *testing.T) {
			setPRViewer(t, "U_alice")
			rewriteTestServer(t, prReadPolicy(blocked), nil)
			client, err := newGHRelayClient()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := localPRCommentViewer(t.Context(), client); err != errRewriteBlocked {
				t.Fatalf("identity bypassed protection: %v", err)
			}
		})
	}
}

func TestPRDetailCombinedExport(t *testing.T) {
	setPRViewer(t, "U_alice")
	reads := 0
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		req := decodeCLIRequest(t, w, r)
		reads++
		headers, _ := req["headers"].(map[string]any)
		switch headers["x-octopool-public-shape"] {
		case publicShapePullRequestComments:
			writeCLIEnvelope(t, w, detailResponse("comments", []any{detailComment(1, "alice")}, 1, false, ""))
		case publicShapePullRequestCommits:
			writeCLIEnvelope(t, w, detailResponse("commits", []any{detailCommit()}, 1, false, ""))
		default:
			writeCLIEnvelope(t, w, map[string]any{"number": 7, "title": "Example", "head": map[string]any{"sha": "head"}})
		}
	})
	var output bytes.Buffer
	err := runGH(t.Context(), []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number,title,comments,commits,comments"}, &output, &bytes.Buffer{})
	var result map[string]any
	if err != nil || json.Unmarshal(output.Bytes(), &result) != nil || reads != 4 || len(result) != 4 {
		t.Fatalf("combined %s: reads=%d err=%v", output.String(), reads, err)
	}
}
