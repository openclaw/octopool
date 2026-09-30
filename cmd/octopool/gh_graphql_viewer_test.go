package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func configureGraphQLViewer(t *testing.T) {
	t.Helper()
	for _, name := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("OCTOPOOL_TOKEN", "")
	t.Setenv("GH_HOST", "github.com")
	t.Setenv("OCTOPOOL_GRAPHQL_RELAY", "")
	t.Setenv("OCTOPOOL_FRESH", "")
	if err := saveAuth(authFile{URL: envDefault("OCTOPOOL_URL", defaultURL), Pool: "maintainers", Token: "test-token", Login: "alice"}); err != nil {
		t.Fatal(err)
	}
	writeGraphQLHosts(t, "github.com:\n  user: alice\n  users:\n    bob: {}\n    alice: {}\n")
}

func writeGraphQLHosts(t *testing.T, config string) {
	t.Helper()
	dir := os.Getenv("GH_CONFIG_DIR")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hosts.yml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
}

func codexGraphQLBatch(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("testdata/graphql-read/codex-batch.txt")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(raw))
}

func TestGraphQLViewerCodexBatch(t *testing.T) {
	for _, jq := range []string{"", ".data.viewer.login"} {
		t.Run(jq, func(t *testing.T) {
			if jq != "" && !jqAvailable() {
				t.Skip("jq unavailable")
			}
			calls := 0
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				request := decodeCLIRequest(t, w, r)
				graphql := request["graphql"].(map[string]any)
				query := graphql["query"].(string)
				if strings.Contains(query, "viewer") || !strings.Contains(query, "p1 : repository") || !strings.Contains(query, "p2 : repository") || strings.Contains(query, "alice") || len(graphql) != 2 {
					t.Errorf("viewer not kept local: %#v", graphql)
				}
				if request["headers"].(map[string]any)["cache-control"] != "max-age=20" {
					t.Error("missing default cache bound")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "body": `{"data":{"p1":{"pullRequest":{"number":157854}},"p2":{"pullRequest":{"number":146339}}}}`, "body_encoding": "text", "relay": map[string]string{"route_kind": "graphql_read"}})
			})
			configureGraphQLViewer(t)
			capture := captureRewriteGH(t)
			args := []string{"api", "graphql", "--hostname", "github.com", "-f", "query=" + codexGraphQLBatch(t)}
			if jq != "" {
				args = append(args, "--jq", jq)
			}
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			want := `{"data":{"viewer":{"login":"alice"},"p1":{"pullRequest":{"number":157854}},"p2":{"pullRequest":{"number":146339}}}}`
			if jq != "" {
				want = "alice\n"
			}
			if out.String() != want || calls != 1 || stderr.Len() != 0 {
				t.Fatalf("out=%q calls=%d stderr=%q", out.String(), calls, stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("native gh ran")
			}
		})
	}
}

func TestGraphQLViewerSplice(t *testing.T) {
	for _, test := range []struct {
		name, query, body, want string
	}{
		{"first", `{viewer{login} a:repository(owner:"o",name:"r"){id} b:repository(owner:"o",name:"r"){id}}`, `{"data":{"b":{"id":9007199254740993},"a":{"id":"\u003c"}}}`, `{"data":{"viewer":{"login":"alice"},"a":{"id":"\u003c"},"b":{"id":9007199254740993}}}`},
		{"middle-alias-errors", `{a:repository(owner:"o",name:"r"){id} me:viewer{login} t:__typename b:repository(owner:"o",name:"r"){id}}`, `{"errors": [ {"message":"error", "path":["b"]} ],"data":{"a":{},"t":"Query","b":null},"extensions":{"x":1}}`, `{"errors": [ {"message":"error", "path":["b"]} ],"data":{"a":{},"me":{"login":"alice"},"t":"Query","b":null},"extensions":{"x":1}}`},
		{"last-with-skipped-root", `{a:repository(owner:"o",name:"r")@skip(if:true){id} b:repository(owner:"o",name:"r"){id} viewer{login}}`, `{"data":{"b":{}}}`, `{"data":{"b":{},"viewer":{"login":"alice"}}}`},
		{"null", `{viewer{login} repository(owner:"o",name:"r"){id}}`, `{"data": null,"errors":[{"message":"error"}]}`, `{"data": null,"errors":[{"message":"error"}]}`},
		{"no-data", `{viewer{login} repository(owner:"o",name:"r"){id}}`, `{"errors":[{"message":"error"}]}`, `{"errors":[{"message":"error"}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			read := &graphQLReadRequest{Query: test.query}
			if !repositoryGraphQLRead(read) || read.viewer == nil {
				t.Fatal("query not recognized")
			}
			read.viewer.login = "alice"
			out, err := spliceGraphQLViewer([]byte(test.body), read.viewer)
			if err != nil || string(out) != test.want {
				t.Fatalf("splice=%s err=%v", out, err)
			}
		})
	}
	for _, body := range []string{`{"data":[]}`, `{"data":"x"}`, `{"data":{}} {}`, `{"data":{},"data":{}}`, `{"data":{"viewer":{}}}`, `{"data":{"unexpected":{}}}`} {
		if _, err := spliceGraphQLViewer([]byte(body), &graphQLLocalViewer{key: "viewer", keys: []string{"viewer", "repository"}, login: "alice"}); err == nil {
			t.Errorf("invalid response accepted: %s", body)
		}
	}
}

func TestGraphQLViewerIdentity(t *testing.T) {
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_URL", "")
	configureGraphQLViewer(t)
	for _, config := range []string{
		"github.com:\n  user: alice\n  oauth_token: synthetic\n",
		"github.com:\n  users:\n    bob: {}\n    alice: {}\n  user: alice\n",
		"github.com: {user: 'alice', users: {alice: {}}}\n",
	} {
		writeGraphQLHosts(t, config)
		if login, ok := nativeGraphQLViewerLogin(); !ok || login != "alice" {
			t.Fatalf("identity rejected: %q %v", login, ok)
		}
	}
	for _, config := range []string{
		"", "github.com: [", "github.com: {}", "other: {user: alice}",
		"github.com: {user: bob}", "github.com: {user: Alice}",
		"github.com: {users: {alice: {}}}", "github.com: {user: alice, users: {bob: {}}}",
		"github.com: {user: alice, user: bob}", "github.com: {user: alice}\ngithub.com: {user: bob}",
		"github.com: {user: alice, users: {alice: {}, alice: {}}}",
		"github.com: {user: [alice]}", "github.com: {user: ' alice'}",
		"github.com: {user: alice}\n---\ngithub.com: {user: bob}",
		"other: &account {user: alice}\ngithub.com: *account", "github.com: {<<: {user: alice}}",
	} {
		t.Run(config, func(t *testing.T) {
			writeGraphQLHosts(t, config)
			if _, ok := nativeGraphQLViewerLogin(); ok {
				t.Fatal("ambiguous or mismatched identity accepted")
			}
		})
	}
}

func TestGraphQLViewerConfigPaths(t *testing.T) {
	for _, location := range []string{"override", "xdg", "home"} {
		t.Run(location, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_URL", "")
			configureGraphQLViewer(t)
			config := os.Getenv("GH_CONFIG_DIR")
			if location == "xdg" {
				config = filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "gh")
			} else if location == "home" {
				t.Setenv("XDG_CONFIG_HOME", "")
				if runtime.GOOS == "windows" {
					config = filepath.Join(os.Getenv("AppData"), "GitHub CLI")
				} else {
					home, err := os.UserHomeDir()
					if err != nil {
						t.Fatal(err)
					}
					config = filepath.Join(home, ".config", "gh")
					t.Setenv("AppData", "")
				}
			}
			t.Setenv("GH_CONFIG_DIR", config)
			writeGraphQLHosts(t, "github.com: {user: alice}")
			if location != "override" {
				t.Setenv("GH_CONFIG_DIR", "")
			}
			if err := saveAuth(authFile{URL: defaultURL, Pool: "maintainers", Token: "test-token", Login: "alice"}); err != nil {
				t.Fatal(err)
			}
			if login, ok := nativeGraphQLViewerLogin(); !ok || login != "alice" {
				t.Fatalf("config path %s rejected", location)
			}
		})
	}
}

func TestGraphQLViewerRelayErrors(t *testing.T) {
	for _, body := range []string{`{"errors":[{"message":"failed","path":["p2"]}],"data":{"p1":{},"p2":null}}`, `{"data":null,"errors":[{"message":"failed"}]}`} {
		t.Run(body, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "body": body, "body_encoding": "text", "relay": map[string]string{"route_kind": "graphql_read"}})
			})
			configureGraphQLViewer(t)
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), []string{"api", "graphql", "-f", "query=" + codexGraphQLBatch(t)}, &out, &bytes.Buffer{})
			want := strings.Replace(body, `"data":{"p1"`, `"data":{"viewer":{"login":"alice"},"p1"`, 1)
			if err == nil || isLocalFallback(err) || out.String() != want {
				t.Fatalf("err=%v body=%s", err, out.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("GraphQL errors triggered native fallback")
			}
		})
	}
}

func TestGraphQLViewerNativeFallbacks(t *testing.T) {
	for _, reason := range []string{"different-repo", "different-owner", "gh-token", "github-token", "empty-token", "missing-config", "mismatch", "missing-auth", "auth-override", "kill-switch"} {
		t.Run(reason, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
			configureGraphQLViewer(t)
			query := codexGraphQLBatch(t)
			switch reason {
			case "different-repo":
				query = strings.Replace(query, `p2: repository(owner:"openclaw",name:"openclaw")`, `p2: repository(owner:"openclaw",name:"other")`, 1)
			case "different-owner":
				query = strings.Replace(query, `p2: repository(owner:"openclaw"`, `p2: repository(owner:"other"`, 1)
			case "gh-token":
				t.Setenv("GH_TOKEN", "synthetic")
			case "github-token":
				t.Setenv("GITHUB_TOKEN", "synthetic")
			case "empty-token":
				t.Setenv("GH_TOKEN", "")
			case "missing-config":
				t.Setenv("GH_CONFIG_DIR", t.TempDir())
			case "mismatch":
				writeGraphQLHosts(t, "github.com: {user: bob}")
			case "missing-auth":
				if err := saveAuth(authFile{}); err != nil {
					t.Fatal(err)
				}
			case "auth-override":
				t.Setenv("OCTOPOOL_TOKEN", "test-token")
			case "kill-switch":
				t.Setenv("OCTOPOOL_GRAPHQL_RELAY", "0")
			}
			args := []string{"api", "graphql", "--hostname", "github.com", "-f", "query=" + query}
			if _, ok := parseRepositoryGraphQL(args[1:]); ok {
				t.Fatal("unsafe viewer relayed")
			}
			if reason == "missing-auth" {
				return
			}
			capture := captureRewriteGH(t)
			if err := runGH(t.Context(), args, &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(readRewriteCapture(t, capture).Args, args) {
				t.Fatal("native arguments changed")
			}
		})
	}
}

func TestGraphQLViewerForbiddenShapes(t *testing.T) {
	for _, viewer := range []string{"viewer{login name}", "viewer{alias:login}", "viewer{login login}", "viewer{login()}", "viewer{login@skip(if:true)}", "viewer@skip(if:true){login}", "viewer(id:1){login}", "viewer{...Login}", "viewer{...on User{login}}", "viewer{login} viewer{login}", "repository:viewer{login}", "viewer{login} nested:viewer{email}"} {
		query := "{" + viewer + ` repository(owner:"o",name:"r"){id}}`
		if repositoryGraphQLRead(&graphQLReadRequest{Query: query}) {
			t.Errorf("forbidden shape accepted: %s", query)
		}
	}
	for _, query := range []string{
		`{viewer{login} repository(owner:"o",name:"r"){viewer{login}}}`,
		`{viewer{login} repository(owner:"o",name:"r"){viewerPermission}}`,
		`{viewer{login} repository(owner:"o",name:"r"){id}} fragment Hidden on Query{viewer{login}}`,
	} {
		if repositoryGraphQLRead(&graphQLReadRequest{Query: query}) {
			t.Errorf("nested viewer accepted: %s", query)
		}
	}
}

func TestRepositoryGraphQLFreshness(t *testing.T) {
	t.Setenv("GH_HOST", "github.com")
	t.Setenv("OCTOPOOL_GRAPHQL_RELAY", "")
	for _, hostname := range [][]string{nil, {"--hostname", "github.com"}, {"--hostname=github.com"}} {
		for _, test := range []struct{ fresh, header, want string }{{"", "", "max-age=20"}, {"", "max-age=0", "max-age=0"}, {"", "max-age=30", "max-age=30"}, {"1", "", "max-age=0"}, {"1", "max-age=30", "max-age=0"}} {
			t.Setenv("OCTOPOOL_FRESH", test.fresh)
			args := append(repositoryReadArgs(repositoryReadQuery)[1:], hostname...)
			if test.header != "" {
				args = append(args, "-H", "Cache-Control: "+test.header)
			}
			request, ok := parseRepositoryGraphQL(args)
			if !ok || request.headers["cache-control"] != test.want {
				t.Fatalf("hostname=%v config=%+v headers=%v ok=%v", hostname, test, request.headers, ok)
			}
		}
	}
}
