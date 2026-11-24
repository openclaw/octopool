package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestRunGHAPIPRDetailRESTControls(t *testing.T) {
	for _, test := range []struct{ field, path string }{
		{"commits", "/repos/acme/repo/pulls/7/commits"},
		{"comments", "/repos/acme/repo/issues/7/comments"},
		{"reviews", "/repos/acme/repo/pulls/7/reviews"},
	} {
		t.Run(test.field, func(t *testing.T) {
			body := prDetailRESTFixture(test.field)
			data := 0
			_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				data++
				req := decodeCLIRequest(t, w, r)
				headers, _ := req["headers"].(map[string]any)
				if req["method"] != "GET" || req["path"] != test.path || req["route_hint"] != nil || headers["x-octopool-public-shape"] != nil {
					t.Errorf("raw REST must use existing unprojected route: %v", req)
				}
				writeCLIEnvelope(t, w, body)
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"api", strings.TrimPrefix(test.path, "/")}, &out, &stderr)
			want, marshalErr := json.Marshal(body)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			if err != nil || !bytes.Equal(bytes.TrimSpace(out.Bytes()), want) || stderr.Len() != 0 || data != 1 || policies.Load() != 2 {
				t.Fatalf("raw REST changed: err=%v data=%d policies=%d out=%q want=%q stderr=%q", err, data, policies.Load(), out.String(), want, stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("raw detail GET must still relay, not use native GraphQL export")
			}
		})
	}
}

func TestParseGHAPIArgs(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{
		"repos/openclaw/openclaw/pulls/85341?per_page=100",
		"--jq",
		".number",
		"-H",
		"Accept: application/vnd.github+json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fallback {
		t.Fatal("unexpected fallback")
	}
	if request.path != "/repos/openclaw/openclaw/pulls/85341" {
		t.Fatalf("path = %q", request.path)
	}
	if request.query["per_page"] != "100" {
		t.Fatalf("query = %#v", request.query)
	}
	if request.headers["accept"] != "application/vnd.github+json" {
		t.Fatalf("headers = %#v", request.headers)
	}
	if request.jq != ".number" {
		t.Fatalf("jq = %q", request.jq)
	}
}

func TestParseGHAPIArgsOptionTypeControls(t *testing.T) {
	for _, test := range []struct {
		name       string
		args       []string
		jq, accept string
		fallback   bool
	}{
		{"missing_cache_value", []string{"--cache"}, "", "", true},
		{"empty_cache_value", []string{"--cache="}, "", "", true},
		{"attached_header", []string{"-HAccept: application/json"}, "", "application/json", false},
		{"equals_short_header", []string{"-H=Accept: application/json"}, "", "application/json", false},
		{"empty_header", []string{"--header="}, "", "", false},
		{"ignored_header_without_colon", []string{"--header=invalid"}, "", "", false},
		{"unsafe_attached_header", []string{"-HAuthorization: value"}, "", "", true},
		{"unsupported_short_jq_equals", []string{"-q=.number"}, "", "", true},
		{"unsupported_short_method_equals", []string{"-X=GET"}, "", "", true},
		{"last_jq", []string{"--jq", "(", "--jq=.number"}, ".number", "", false},
		{"empty_last_jq", []string{"--jq", "(", "--jq="}, "", "", false},
		{"literal_header_comma", []string{"-H", "Accept: application/json,text/plain"}, "", "application/json,text/plain", false},
		{"native_only_field", []string{"-f", "labels=a,b"}, "", "", true},
		{"native_only_top_json", []string{"--json="}, "", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			req, fallback, err := parseGHAPIArgs(append([]string{"repos/acme/repo"}, test.args...))
			if err != nil || fallback != test.fallback || req.jq != test.jq || req.headers["accept"] != test.accept {
				t.Fatalf("request=%#v fallback=%v err=%v", req, fallback, err)
			}
		})
	}
}

func TestParseGHAPIArgsDecodesQueryOnce(t *testing.T) {
	request, fallback, err := parseGHAPIArgs([]string{
		"/repos/openclaw/openclaw/actions/runs?branch=feature%2Ffoo&label=a&label=b",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fallback {
		t.Fatal("unexpected fallback")
	}
	if request.query["branch"] != "feature/foo" {
		t.Fatalf("query = %#v", request.query)
	}
	labels, ok := request.query["label"].([]string)
	if !ok || len(labels) != 2 || labels[0] != "a" || labels[1] != "b" {
		t.Fatalf("query = %#v", request.query)
	}
}

func TestParseGHAPIArgsFallsBackForSensitiveHeaders(t *testing.T) {
	_, fallback, err := parseGHAPIArgs([]string{
		"/user",
		"-H",
		"Authorization: Bearer secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !fallback {
		t.Fatal("expected fallback")
	}
}

func TestSafeRelayRequest(t *testing.T) {
	for _, tc := range []struct {
		path  string
		relay bool
	}{
		{"/repos/openclaw/openclaw/pulls/1", true},
		{"/users/openperf", true},
		{"/users/dependabot%5Bbot%5D", true},
		{"/users/dependabot[bot]", true},
		{"/repos/openclaw/octopool", true},
		{"/repos/openclaw/octopool/pulls?state=open", true},
		{"/repos/openclaw/octopool/pulls/1/commits", true},
		{"/repos/openclaw/octopool/commits/main", true},
		{"/repos/openclaw/octopool/commits/v1.2.3", true},
		{"/repos/openclaw/octopool/commits/main/check-runs", true},
		{"/repos/openclaw/octopool/commits/main/check-suites", true},
		{"/repos/openclaw/octopool/commits/main/status", true},
		{"/repos/openclaw/octopool/commits/main/statuses", true},
		{"/repos/openclaw/octopool/issues?state=open", true},
		{"/repos/openclaw/octopool/issues/1/events", true},
		{"/repos/openclaw/octopool/contents/README.md?ref=main", true},
		{"/repos/openclaw/octopool/compare/main...feature", true},
		{"/repos/openclaw/octopool/actions/workflows/ci.yml", true},
		{"/repos/openclaw/octopool/actions/workflows/ci.yml/runs", true},
		{"/repos/openclaw/octopool/releases", true},
		{"/repos/openclaw/octopool/releases/latest", true},
		{"/repos/openclaw/octopool/releases/tags/v0.2.5", true},
		{"/repos/openclaw/octopool/releases/123", true},
		{"/search/issues?q=repo:openclaw/openclaw", true},
		{"/search/issues", true},
		{"/gitignore/templates/C%2B%2B", true},
		{"/search/repositories?q=octopool+relay", true},
		{"/search/repositories?q=language:go", false},
		{"/repos/cli/cli/pulls/1", true},
		{"/repos/openclaw/openclaw/pulls/1?access_token=x", false},
		{"/repos/openclaw/openclaw/pulls/1?client_secret=x", false},
		{"/repos/openclaw/openclaw/contents/../secret?ref=main", false},
	} {
		t.Run(tc.path, func(t *testing.T) {
			request, fallback, err := parseGHAPIArgs([]string{tc.path})
			if err != nil || fallback {
				t.Fatalf("parse fallback=%v err=%v", fallback, err)
			}
			if got := safeRelayRequest(request); got != tc.relay {
				t.Fatalf("safeRelayRequest = %v, want %v", got, tc.relay)
			}
		})
	}
}

func TestParseGHAPIArgsFallsBackForMutation(t *testing.T) {
	_, fallback, err := parseGHAPIArgs([]string{"--method", "POST", "/repos/openclaw/openclaw/issues"})
	if err != nil {
		t.Fatal(err)
	}
	if !fallback {
		t.Fatal("expected fallback")
	}
}

func TestRunGHAPIPlaceholderPathExecutesLocallyWithoutRelay(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return nil
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{"api", "repos/:owner/:repo"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 0 {
		t.Fatalf("relay requests = %d, want 0", requests)
	}
	if !strings.HasPrefix(out.String(), "real-gh:api repos/:owner/:repo") {
		t.Fatalf("output = %q, want real gh execution", out.String())
	}
}

func TestRunGHAPIColonOutsidePlaceholderSegmentRelays(t *testing.T) {
	requests := 0
	relayTestServer(t, func(body map[string]any) any {
		requests++
		query, _ := body["query"].(map[string]any)
		if body["path"] != "/repos/openclaw/octopool/contents/README.md" || query["ref"] != "heads/foo:bar" {
			t.Fatalf("relay body = %#v", body)
		}
		return map[string]any{"relayed": true}
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/contents/README.md?ref=heads/foo:bar",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("relay requests = %d, want 1", requests)
	}
	if strings.Contains(out.String(), "real-gh:") || !strings.Contains(out.String(), `"relayed":true`) {
		t.Fatalf("output = %q, want relay response", out.String())
	}
}

func TestParseGHAPIArgsMissingValue(t *testing.T) {
	for _, flag := range []string{"--hostname", "--method", "--jq", "--header", "-X", "-q", "-H"} {
		name := map[string]string{"-X": "--method", "-q": "--jq", "-H": "--header"}[flag]
		if name == "" {
			name = flag
		}
		_, fallback, err := parseGHAPIArgs([]string{"/repos/acme/repo", flag})
		if fallback || err == nil || err.Error() != name+" requires a value" {
			t.Fatalf("flag=%q: fallback=%v err=%v", flag, fallback, err)
		}
	}
}
