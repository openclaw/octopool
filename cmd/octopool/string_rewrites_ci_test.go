package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func TestStringRewriteCIRetry(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"private", "public"})
	for _, test := range []struct {
		name string
		args []string
		path string
	}{
		{"run", []string{"run", "rerun", "123", "-R", "acme/repo"}, "repos/acme/repo/actions/runs/123/rerun"},
		{"failed", []string{"run", "rerun", "123", "--failed", "-Racme/repo"}, "repos/acme/repo/actions/runs/123/rerun-failed-jobs"},
		{"false", []string{"run", "rerun", "--repo=acme/repo", "123", "--failed=false"}, "repos/acme/repo/actions/runs/123/rerun"},
		{"api", []string{"api", "-X", "POST", "repos/acme/repo/actions/runs/123/rerun"}, "repos/acme/repo/actions/runs/123/rerun"},
		{"api failed", []string{"api", "repos/acme/repo/actions/runs/123/rerun-failed-jobs", "--method", "POST"}, "repos/acme/repo/actions/runs/123/rerun-failed-jobs"},
		{"job", []string{"api", "-XPOST", "repos/acme/repo/actions/jobs/123/rerun"}, "repos/acme/repo/actions/jobs/123/rerun"},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := &rewritePreparation{}
			defer p.cleanup()
			var err error
			if test.args[0] == "api" {
				err = prepareRewriteAPI(policy, test.args, strings.NewReader("unread"), p)
			} else {
				err = prepareRewriteRead(policy, test.args, p)
			}
			if err != nil || !slices.Contains(p.args, test.path) || !slices.Contains(p.args, "--method=POST") || !slices.Contains(p.args, "--hostname=github.com") {
				t.Fatalf("args=%q err=%v", p.args, err)
			}
			body, err := io.ReadAll(p.stdin)
			if err != nil || len(body) != 0 || p.directory != "" {
				t.Fatalf("body=%q err=%v directory=%q", body, err, p.directory)
			}
		})
	}
}

func TestStringRewriteCIRetryRejectsNearMisses(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"private", "public"})
	for _, args := range [][]string{
		{"run", "rerun", "0", "-Racme/repo"},
		{"run", "rerun", "01", "-Racme/repo"},
		{"run", "rerun", "-1", "-Racme/repo"},
		{"run", "rerun", "9223372036854775808", "-Racme/repo"},
		{"run", "rerun", "123/456", "-Racme/repo"},
		{"run", "rerun", "123", "456", "-Racme/repo"},
		{"run", "rerun", "123", "--job=456", "-Racme/repo"},
		{"run", "rerun", "123", "--failed", "--failed", "-Racme/repo"},
		{"run", "rerun", "123", "-Racme/../repo"},
		{"run", "rerun", "123", "-Racme/private"},
		{"api", "-XPOST", "repos/acme/repo/actions/runs/0/rerun"},
		{"api", "-XPOST", "repos/acme/repo/actions/jobs/123/rerun-failed-jobs"},
		{"api", "-XPOST", "repos/acme/repo/actions/runs/123/rerun/extra"},
		{"api", "-XGET", "repos/acme/repo/actions/runs/123/rerun"},
		{"api", "-XPOST", "repos/acme/repo/actions/runs/123/rerun?debug=true"},
		{"api", "-XPOST", "repos/acme/repo/actions/runs/123/rerun", "-f", "enable_debug_logging=true"},
		{"api", "-XPOST", "repos/acme/repo/actions/runs/123/rerun", "--input=-"},
		{"api", "-XPOST", "repos/acme/repo/actions/runs/123/rerun", "--paginate"},
		{"api", "-XPOST", "repos/acme/private/actions/runs/123/rerun"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			p := &rewritePreparation{}
			defer p.cleanup()
			var err error
			if args[0] == "api" {
				err = prepareRewriteAPI(policy, args, strings.NewReader("{}"), p)
			} else {
				err = prepareRewriteRead(policy, args, p)
			}
			if err == nil {
				t.Fatalf("accepted %q", args)
			}
		})
	}
}

func TestStringRewriteWorkflowRunsQuery(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"private", "public"})
	endpoint := "repos/acme/repo/actions/workflows/ci.yml/runs"
	sha := strings.Repeat("a", 40)
	for _, method := range [][]string{nil, {"--method", "GET"}, {"-XGET"}} {
		args := append([]string{"api", endpoint}, method...)
		args = append(args, "-f", "event=pull_request", "-F", "head_sha="+sha, "-fbranch=feature/topic", "-Fper_page=100", "-fstatus=completed")
		p := &rewritePreparation{}
		if err := prepareRewriteAPI(policy, args, nil, p); err != nil {
			t.Fatal(err)
		}
		request, fallback, err := parseGHAPIArgs(args[1:])
		if err != nil || fallback || request.method != "GET" || request.query["head_sha"] != sha || request.query["per_page"] != "100" || request.query["branch"] != "feature/topic" {
			t.Fatalf("request=%+v fallback=%v err=%v", request, fallback, err)
		}
		if strings.Contains(strings.Join(p.args, " "), "--field") || !strings.Contains(p.args[1], "branch=feature%2Ftopic") {
			t.Fatalf("fields not pinned: %q", p.args)
		}
	}
	for _, fields := range [][]string{
		{"-f", "unknown=value"}, {"-F", "branch=@file"}, {"-f", "head_sha=bad"},
		{"-f", "event=pull_request", "-F", "event=push"}, {"-F", "per_page=101"},
		{"-F", "per_page=0"}, {"-F", "branch={branch}"}, {"-f", "branch=private"},
		{"-f", "branch="}, {"--input=-"}, {"-XPOST", "-f", "event=push"},
	} {
		p := &rewritePreparation{}
		args := append([]string{"api", endpoint}, fields...)
		if err := prepareRewriteAPI(policy, args, nil, p); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
	// Existing query-only GETs keep their broader native/relay vocabulary.
	p := &rewritePreparation{}
	if err := prepareRewriteAPI(policy, []string{"api", endpoint + "?page=2&exclude_pull_requests=true"}, nil, p); err != nil {
		t.Fatalf("existing workflow read changed: %v", err)
	}
}

func TestCIRetryAndWorkflowRunsDispatch(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string            `json:"method"`
			Path   string            `json:"path"`
			Query  map[string]string `json:"query"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request.Method != "GET" || request.Path != "/repos/acme/repo/actions/workflows/ci.yml/runs" || request.Query["event"] != "pull_request" {
			t.Errorf("request=%+v", request)
		}
		writeCLIEnvelope(t, w, map[string]any{"workflow_runs": []any{}})
	})
	capture := captureRewriteGH(t)
	var stdout, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"run", "rerun", "42", "--failed", "-Racme/repo"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	got := readRewriteCapture(t, capture)
	if !slices.Contains(got.Args, "repos/acme/repo/actions/runs/42/rerun-failed-jobs") || got.Stdin != "" || strings.Contains(stderr.String(), "graphql") {
		t.Fatalf("capture=%+v stderr=%q", got, stderr.String())
	}
	stdout.Reset()
	if err := runGH(t.Context(), []string{"api", "repos/acme/repo/actions/workflows/ci.yml/runs", "-f", "event=pull_request"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "workflow_runs") {
		t.Fatalf("query did not relay: %q", stdout.String())
	}
}

func TestWorkflowRunReadFallbackKeepsGET(t *testing.T) {
	for _, policy := range []string{rewriteEmptyTestPolicy, rewriteActiveTestPolicy} {
		t.Run(policy, func(t *testing.T) {
			rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request["method"] != "GET" {
					t.Fatalf("workflow read changed method: %+v %v", request, err)
				}
				writeCLIFallback(t, w, "repo_not_public")
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			capturePath := captureRewriteGH(t)
			var stdout, stderr bytes.Buffer
			args := []string{"api", "repos/acme/repo/actions/workflows/ci.yml/runs", "-f", "event=pull_request"}
			if err := runGH(t.Context(), args, &stdout, &stderr); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if !slices.Contains(capture.Args, "--method=GET") || !slices.Contains(capture.Args, "/repos/acme/repo/actions/workflows/ci.yml/runs?event=pull_request") {
				t.Fatalf("fallback lost the read: %q", capture.Args)
			}
		})
	}
}
