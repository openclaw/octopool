package main

import (
	"bytes"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestGHAPIHostnameLandingReadsRelay(t *testing.T) {
	for _, policy := range []string{rewriteEmptyTestPolicy, rewriteActiveTestPolicy} {
		for _, test := range []struct {
			name, path string
			flags      []string
			query      map[string]any
			body       any
			want       string
		}{
			{"pull", "repos/acme/repo/pulls/7", []string{"--hostname", "github.com"}, nil, map[string]any{"number": 7}, `{"number":7}`},
			{"merge-ref", "repos/acme/repo/git/ref/pull/7/merge", []string{"--hostname=github.com"}, nil, map[string]any{"ref": "refs/pull/7/merge"}, `{"ref":"refs/pull/7/merge"}`},
			{"reviews", "repos/acme/repo/pulls/7/reviews?per_page=100", []string{"--hostname", "github.com", "--paginate", "--slurp"}, map[string]any{"page": "1", "per_page": "100"}, []any{}, `[[]]`},
			{"check-runs", "repos/acme/repo/commits/0123456789abcdef0123456789abcdef01234567/check-runs", []string{"--hostname=github.com", "-X", "GET", "-f", "filter=latest", "-F", "per_page=100"}, map[string]any{"filter": "latest", "per_page": "100"}, map[string]any{"total_count": 0, "check_runs": []any{}}, `{"check_runs":[],"total_count":0}`},
		} {
			t.Run(policy+"/"+test.name, func(t *testing.T) {
				calls := 0
				rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					request := decodeCLIRequest(t, w, r)
					path, _, _ := strings.Cut(test.path, "?")
					headers, _ := request["headers"].(map[string]any)
					query, _ := request["query"].(map[string]any)
					if request["method"] != "GET" || request["path"] != "/"+path || !reflect.DeepEqual(query, test.query) || headers["cache-control"] != "max-age=0" {
						t.Errorf("landing request changed: %#v", request)
					}
					writeCLIEnvelope(t, w, test.body)
				})
				t.Setenv("GH_HOST", "enterprise.example")
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				capture := captureRewriteGH(t)
				args := append([]string{"api", test.path}, test.flags...)
				args = append(args, "-H", "Cache-Control: max-age=0")
				var out, stderr bytes.Buffer
				if err := runGH(t.Context(), args, &out, &stderr); err != nil || calls != 1 || strings.TrimSpace(out.String()) != test.want {
					t.Fatalf("err=%v calls=%d out=%q stderr=%q", err, calls, out.String(), stderr.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("public-host landing read dispatched native gh")
				}
			})
		}
	}
}

func TestGHAPIHostnameNativeBoundaries(t *testing.T) {
	for _, test := range []struct {
		name, ambient string
		flags         []string
	}{
		{"enterprise", "", []string{"--hostname", "enterprise.example"}},
		{"enterprise-equals", "", []string{"--hostname=enterprise.example"}},
		{"last-host-wins", "", []string{"--hostname=github.com", "--hostname", "enterprise.example"}},
		{"empty-host", "", []string{"--hostname="}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
			t.Setenv("GH_HOST", test.ambient)
			capture := captureRewriteGH(t)
			args := append([]string{"api", "repos/acme/repo/pulls/7"}, test.flags...)
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
