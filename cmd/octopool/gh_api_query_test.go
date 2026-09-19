package main

import (
	"bytes"
	"errors"
	"net/http"
	"os"
	"reflect"
	"slices"
	"testing"
)

func TestGHExplicitGETFieldsRelay(t *testing.T) {
	for _, policy := range []string{rewriteEmptyTestPolicy, rewriteActiveTestPolicy} {
		t.Run(policy, func(t *testing.T) {
			calls := 0
			rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				request := decodeCLIRequest(t, w, r)
				want := map[string]any{"ref": "feature/a&b", "page": "2", "per_page": "10", "enabled": "true", "empty": "", "literal": "0007"}
				if request["method"] != "GET" || request["path"] != "/repos/acme/repo/contents/README.md" || !reflect.DeepEqual(request["query"], want) {
					t.Errorf("GET query changed: %#v", request)
				}
				headers, _ := request["headers"].(map[string]any)
				if headers["accept"] != "application/vnd.github+json" || headers["cache-control"] != "max-age=0" || headers["if-none-match"] != `"fixture"` {
					t.Errorf("headers changed: %#v", headers)
				}
				writeCLIEnvelope(t, w, map[string]any{"name": "README.md"})
			})
			capture := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			var out, stderr bytes.Buffer
			args := []string{"api", "repos/acme/repo/contents/README.md?page=2", "--method=GET", "-f", "ref=feature/a&b", "-Fper_page=0010", "--field=enabled=true", "-F", "empty=null", "--raw-field=literal=0007", "-H", "Accept: application/vnd.github+json", "-H", "Cache-Control: max-age=0", "-H", `If-None-Match: "fixture"`}
			if err := runGH(t.Context(), args, &out, &stderr); err != nil || calls != 1 || string(bytes.TrimSpace(out.Bytes())) != `{"name":"README.md"}` || stderr.Len() != 0 {
				t.Fatalf("err=%v calls=%d out=%q stderr=%q", err, calls, out.String(), stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("explicit scalar GET must relay")
			}
		})
	}
}

func TestGHExplicitGETFieldsNativeBoundaries(t *testing.T) {
	for _, args := range [][]string{
		{"api", "repos/acme/repo/issues", "-f", "title=hello"},
		{"api", "repos/acme/repo/issues", "-X", "POST", "-f", "title=hello"},
		{"api", "repos/acme/repo/contents/README.md", "-X", "GET", "-F", "ref=@missing-file"},
		{"api", "repos/acme/repo/contents/README.md", "-X", "GET", "-F", "ref={branch}"},
		{"api", "repos/acme/repo/contents/README.md", "-X", "GET", "-F", "ref=:branch"},
		{"api", "repos/acme/repo/issues", "-X", "GET", "-f", "labels[]=bug"},
		{"api", "repos/acme/repo/issues", "-X", "GET", "-f", "filter[state]=open"},
		{"api", "repos/acme/repo/issues", "-X", "GET", "-f", "state=open", "-f", "state=closed"},
		{"api", "repos/acme/repo/issues?state=open", "-X", "GET", "-f", "state=closed"},
		{"api", "repos/acme/repo/issues?label=bug&label=urgent", "-X", "GET", "-f", "state=open"},
		{"api", "repos/acme/repo/issues", "-X", "GET", "-f", "access_token=fixture"},
		{"api", "repos/{owner}/{repo}/issues", "-X", "GET", "-f", "state=open"},
	} {
		t.Run(args[1]+"/"+args[len(args)-1], func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) {
				t.Fatalf("native arguments changed: %q", got.Args)
			}
		})
	}
}

func TestGHExplicitGETFieldsPagination(t *testing.T) {
	for _, test := range []struct {
		name  string
		flags []string
		want  string
	}{
		{"enabled", []string{"--paginate", "--slurp"}, `[[{"number":7}]]`},
		{"disabled", []string{"--paginate=false", "--slurp=false"}, `[{"number":7}]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				request := decodeCLIRequest(t, w, r)
				query, _ := request["query"].(map[string]any)
				if request["method"] != "GET" || query["state"] != "open" || query["per_page"] != "100" {
					t.Errorf("query changed: %#v", request)
				}
				if test.name == "enabled" && query["page"] != "1" || test.name == "disabled" && query["page"] != nil {
					t.Errorf("pagination flag changed: %#v", query)
				}
				writeCLIEnvelope(t, w, []any{map[string]any{"number": 7}})
			})
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			args := append([]string{"api", "repos/acme/repo/issues", "--method=GET", "-f", "state=open", "-F", "per_page=100"}, test.flags...)
			if err := runGH(t.Context(), args, &out, &stderr); err != nil || calls != 1 || string(bytes.TrimSpace(out.Bytes())) != test.want {
				t.Fatalf("err=%v calls=%d out=%q stderr=%q", err, calls, out.String(), stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("scalar query pagination must relay")
			}
		})
	}
}

func TestGHExplicitGETFieldsPreservePolicyDenial(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capture := captureRewriteGH(t)
	var out, stderr bytes.Buffer
	err := runGH(t.Context(), []string{"api", "repos/acme/repo/contents/README.md", "--method", "GET", "-f", "ref=internal-model"}, &out, &stderr)
	if !errors.Is(err, errRewriteBlocked) {
		t.Fatalf("expected structural policy denial, got %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("policy denial must not dispatch native gh")
	}
}
