package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const repositoryReadQuery = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid}}}`

func repositoryReadArgs(query string) []string {
	return []string{"api", "graphql", "-f", "query=" + query, "-f", "owner=openclaw", "-f", "name=octopool", "-F", "pr=42"}
}

func TestRepositoryGraphQLGrammar(t *testing.T) {
	t.Setenv("GH_HOST", "github.com")
	t.Setenv("OCTOPOOL_GRAPHQL_RELAY", "")
	t.Setenv("OCTOPOOL_FRESH", "")
	for _, query := range []string{
		repositoryReadQuery,
		`query { r:repository(owner:"openclaw",name:"octopool") { name } __typename }`,
		`query { p1:repository(owner:"OpenClaw",name:"Octopool") { name } p2:repository(owner:$owner,name:$name) { name } }`,
		`{repository(owner:"openclaw",name:"octopool") @include(if:true) {name}}`,
		`query Q($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){...Fields}} fragment Fields on Repository { name }`,
		"# header\n" + repositoryReadQuery,
	} {
		t.Run(query, func(t *testing.T) {
			request, ok := parseRepositoryGraphQL(repositoryReadArgs(query)[1:])
			if !ok || request.method != "POST" || request.path != "/graphql" || request.headers["cache-control"] != "max-age=60" || request.graphql.Query != query || request.graphql.Variables["pr"] != 42 {
				t.Fatalf("query not relayed: %#v, %v", request, ok)
			}
		})
	}
	for _, test := range []struct {
		name, query string
		extra       []string
	}{
		{"mutation", `mutation{repository(owner:"openclaw",name:"octopool"){name}}`, nil},
		{"subscription", `subscription{repository(owner:"openclaw",name:"octopool"){name}}`, nil},
		{"viewer", `{viewer{login}}`, nil},
		{"nested-viewer", strings.Replace(repositoryReadQuery, "state", "alias: viewerPermission", 1), nil},
		{"rateLimit", `{rateLimit{remaining}}`, nil},
		{"second-root", `{repository(owner:"openclaw",name:"octopool"){name} rateLimit{remaining}}`, nil},
		{"organization", `{organization(login:"openclaw"){name}}`, nil},
		{"node", `{node(id:"x"){id}}`, nil},
		{"introspection", `{__schema{types{name}}}`, nil},
		{"two-operations", repositoryReadQuery + repositoryReadQuery, nil},
		{"two-repositories", `{repository(owner:"openclaw",name:"octopool"){name} r:repository(owner:"openclaw",name:"other"){name}}`, nil},
		{"oversized", repositoryReadQuery + strings.Repeat(" ", 16384), nil},
		{"deep", `{repository(owner:"openclaw",name:"octopool"){` + strings.Repeat("owner{", 13) + "login" + strings.Repeat("}", 15), nil},
		{"input", repositoryReadQuery, []string{"--input", "body.json"}},
		{"pagination", repositoryReadQuery, []string{"--paginate"}},
		{"pagination-false", repositoryReadQuery, []string{"--paginate=false"}},
		{"slurp", repositoryReadQuery, []string{"--slurp"}},
		{"tokens", `{viewer{login} repository(owner:"openclaw",name:"octopool"){` + strings.Repeat("id ", 4000) + `}}`, nil},
		{"template", repositoryReadQuery, []string{"--template", "{{.data}}"}},
		{"include", repositoryReadQuery, []string{"--include"}},
		{"conditional", repositoryReadQuery, []string{"-H", "If-None-Match: old"}},
		{"auth-header", repositoryReadQuery, []string{"-H", "Authorization: synthetic"}},
		{"foreign-host", repositoryReadQuery, []string{"--hostname", "github.example"}},
		{"get", repositoryReadQuery, []string{"-X", "GET"}},
		{"file-field", repositoryReadQuery, []string{"-F", "cursor=@source"}},
		{"array-field", repositoryReadQuery, []string{"-f", "cursor[]=x"}},
		{"duplicate", repositoryReadQuery, []string{"-f", "owner=another"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, ok := parseRepositoryGraphQL(append(repositoryReadArgs(test.query)[1:], test.extra...)); ok {
				t.Fatal("unsupported query relayed")
			}
		})
	}
	request, ok := parseRepositoryGraphQL(append(repositoryReadArgs(repositoryReadQuery)[1:], "--hostname=github.com", "-H", "Cache-Control: max-age=30"))
	if !ok || request.headers["cache-control"] != "max-age=30" {
		t.Fatal("explicit freshness lost")
	}
	t.Setenv("OCTOPOOL_GRAPHQL_RELAY", "0")
	if _, ok := parseRepositoryGraphQL(repositoryReadArgs(repositoryReadQuery)[1:]); ok {
		t.Fatal("kill switch ignored")
	}
	// The existing exact landing projections have their original routing.
	if _, ok := parseLandingGraphQL(landingGraphQLArgs(githubLandingQueryPullRequestCISummary, "pr")[1:]); !ok {
		t.Fatal("kill switch changed exact landing path")
	}
}

func TestRepositoryGraphQLRelayNativeFixture(t *testing.T) {
	t.Setenv("OCTOPOOL_FRESH", "")
	fixture, err := os.ReadFile("testdata/graphql-read/native.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, jq := range []string{"", ".data.repository.nameWithOwner"} {
		t.Run(jq, func(t *testing.T) {
			if jq != "" && !jqAvailable() {
				t.Skip("jq unavailable")
			}
			calls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				request := decodeCLIRequest(t, w, r)
				graphql := request["graphql"].(map[string]any)
				if request["method"] != "POST" || request["path"] != "/graphql" || graphql["query"] != repositoryReadQuery || !reflect.DeepEqual(graphql["variables"], map[string]any{"owner": "openclaw", "name": "octopool", "pr": float64(42)}) {
					t.Errorf("request=%#v", request)
				}
				if request["headers"].(map[string]any)["cache-control"] != "max-age=60" {
					t.Error("read missing bounded reuse")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "body": string(fixture), "body_encoding": "text", "relay": map[string]string{"route_kind": "graphql_read", "cache": "miss"}})
			})
			capture := captureRewriteGH(t)
			args := repositoryReadArgs(repositoryReadQuery)
			if jq != "" {
				args = append(args, "--jq", jq)
			}
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			expected := fixture
			if jq != "" {
				expected = []byte("openclaw/octopool\n")
			}
			if !bytes.Equal(out.Bytes(), expected) || calls != 1 || stderr.Len() != 0 {
				t.Fatalf("output changed: %q, calls=%d stderr=%q", out.Bytes(), calls, stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("native gh ran")
			}
		})
	}
}

func TestRepositoryGraphQLFallback(t *testing.T) {
	for _, response := range []struct {
		code int
		body string
	}{
		{424, `{"error":{"code":"fallback_local","details":{"reason":"github_app_repo_token_unavailable"}}}`},
		{403, `{"error":{"code":"method_denied","message":"Only GET routes are enabled"}}`},
		{503, `{"error":{"code":"internal_error"}}`},
	} {
		for _, blocked := range []bool{false, true} {
			t.Run(response.body+graphQLFallbackLabel(blocked), func(t *testing.T) {
				calls := 0
				rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					w.WriteHeader(response.code)
					_, _ = w.Write([]byte(response.body))
				})
				capture := captureRewriteGH(t)
				if blocked {
					t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				}
				args := repositoryReadArgs(repositoryReadQuery)
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), args, &out, &stderr)
				if calls != 1 {
					t.Fatalf("calls=%d", calls)
				}
				if blocked {
					if !isLocalFallback(err) || out.Len() != 0 {
						t.Fatalf("blocked: %v %q", err, out.String())
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("blocked native gh ran")
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if !slices.Equal(readRewriteCapture(t, capture).Args, args) {
						t.Fatal("native arguments changed")
					}
				}
			})
		}
	}
}

func graphQLFallbackLabel(value bool) string {
	if value {
		return "/blocked"
	}
	return "/native"
}

func TestRepositoryGraphQLPolicyAndErrors(t *testing.T) {
	t.Run("literal-policy", func(t *testing.T) {
		rewriteTestServer(t, rewriteActiveTestPolicy, nil)
		query := `{repository(owner:"openclaw",name:"octopool"){object(expression:"\u0069nternal-model"){id}}}`
		err := runGH(t.Context(), repositoryReadArgs(query), &bytes.Buffer{}, &bytes.Buffer{})
		if !errors.Is(err, errRewriteBlocked) {
			t.Fatalf("escaped policy value allowed: %v", err)
		}
	})
	for _, code := range []string{"string_rewrite_denied", "pool_policy_unavailable"} {
		t.Run(code, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(503)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code}})
			})
			capture := captureRewriteGH(t)
			if err := runGH(t.Context(), repositoryReadArgs(repositoryReadQuery), &bytes.Buffer{}, &bytes.Buffer{}); err == nil || isLocalFallback(err) {
				t.Fatalf("policy allowed fallback: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("policy failure dispatched gh")
			}
		})
	}
	t.Run("upstream-errors", func(t *testing.T) {
		body := `{"data":null,"errors":[{"message":"synthetic GraphQL error"}]}`
		rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "body": body, "body_encoding": "text", "relay": map[string]string{"route_kind": "graphql_read"}})
		})
		capture := captureRewriteGH(t)
		var out bytes.Buffer
		if err := runGH(t.Context(), repositoryReadArgs(repositoryReadQuery), &out, &bytes.Buffer{}); err == nil || isLocalFallback(err) || out.String() != body {
			t.Fatalf("errors changed: %v %q", err, out.String())
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatal("GraphQL error dispatched gh")
		}
	})
}
