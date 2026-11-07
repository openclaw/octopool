package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func mergeBranchPR(head, headRepo, baseRepo, defaultBranch string) string {
	data, _ := json.Marshal(map[string]any{
		"state": "open", "merged": false,
		"head": map[string]any{"ref": head, "repo": map[string]string{"full_name": headRepo}},
		"base": map[string]any{"repo": map[string]string{"full_name": baseRepo, "default_branch": defaultBranch}},
	})
	return string(data)
}

func TestProtectedMergeDeleteBranch(t *testing.T) {
	for _, test := range []struct {
		name, flag, headRepo, head, defaultBranch, response, notice string
		code                                                        int
		wantDelete, wantError                                       bool
	}{
		{name: "long", flag: "--delete-branch", wantDelete: true},
		{name: "short", flag: "-d", wantDelete: true},
		{name: "explicit true", flag: "--delete-branch=true", wantDelete: true},
		{name: "explicit false", flag: "--delete-branch=false"},
		{name: "fork", flag: "-d", headRepo: "contributor/repo", notice: "Skipped deleting the remote branch of a pull request from fork"},
		{name: "missing ref", flag: "-d", code: 422, response: `{"message":"Reference does not exist"}`, wantDelete: true},
		{name: "missing ref 404", flag: "-d", code: 404, response: `{"message":"Reference does not exist"}`, wantDelete: true},
		{name: "other 422", flag: "-d", code: 422, response: `{"message":"Cannot delete branch"}`, wantDelete: true, wantError: true},
		{name: "permission denied", flag: "-d", code: 403, response: `{"message":"Forbidden"}`, wantDelete: true, wantError: true},
		{name: "default branch", flag: "-d", head: "main", notice: "skipped deleting the repository default branch"},
		{name: "unknown default", flag: "-d", defaultBranch: "missing", wantError: true},
		{name: "wrong base", flag: "-d", headRepo: "other/repo", defaultBranch: "wrong-base", wantError: true},
		{name: "policy head", flag: "-d", head: "internal-model", wantError: true},
		{name: "encoded policy head", flag: "-d", head: "topic/internal-model", wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests []string
			var capture string
			capture = restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
				if r.Method == "DELETE" {
					child := readRewriteCapture(t, capture)
					if !slices.Contains(child.Args, "--method=PUT") || !slices.Contains(child.Args, "repos/acme/repo/pulls/7/merge") {
						t.Fatalf("cleanup ran before merge PUT: %v", child.Args)
					}
				}
				requests = append(requests, r.Method+" "+r.URL.EscapedPath())
				if r.Method == "GET" {
					head, headRepo, baseRepo, defaultBranch := test.head, test.headRepo, "acme/repo", "main"
					if head == "" {
						head = "topic/merge-cleanup"
					}
					if headRepo == "" {
						headRepo = "ACME/repo"
					}
					if test.defaultBranch == "missing" {
						defaultBranch = ""
					}
					if test.defaultBranch == "wrong-base" {
						baseRepo = "other/repo"
					}
					return restWriteResponse(200, mergeBranchPR(head, headRepo, baseRepo, defaultBranch))
				}
				code := test.code
				if code == 0 {
					code = 204
				}
				return restWriteResponse(code, test.response)
			})
			t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", mergeHeaderFrame(200, 4958))
			var stderr bytes.Buffer
			err := execRealGH(t.Context(), append(mergeDiagnosticArgs(), test.flag), io.Discard, &stderr)
			if (err != nil) != test.wantError {
				t.Fatalf("err=%v stderr=%s", err, &stderr)
			}
			if test.wantError && !strings.Contains(err.Error(), "merge succeeded but branch deletion failed") {
				t.Fatalf("lost merge success: %v", err)
			}
			if !strings.Contains(stderr.String(), test.notice) {
				t.Fatalf("missing notice: %s", &stderr)
			}
			want := []string{"GET /repos/acme/repo/pulls/7"}
			if test.wantDelete {
				want = append(want, "DELETE /repos/acme/repo/git/refs/heads/topic%2Fmerge-cleanup")
			}
			if !slices.Equal(requests, want) {
				t.Fatalf("requests=%v want=%v", requests, want)
			}
			line := mergeDiagnosticLine(t, stderr.String())
			if !strings.Contains(line, "outcome=succeeded") || !strings.Contains(line, "exit_code=0") || !strings.Contains(line, "http_status=200") {
				t.Fatalf("cleanup corrupted merge diagnostics: %s", line)
			}
		})
	}
}

func TestProtectedMergeDeleteBranchAfterFailure(t *testing.T) {
	restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
		if r.Method != "GET" {
			t.Fatal("cleanup ran after failed merge")
		}
		return restWriteResponse(200, restWritePRJSON)
	})
	t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "19")
	err := execRealGH(t.Context(), append(mergeDiagnosticArgs(), "-d"), io.Discard, io.Discard)
	var exit exitCodeError
	if !errors.As(err, &exit) || exit.Code != 19 {
		t.Fatalf("merge failure was not preserved: %v", err)
	}
}

func TestProtectedMergeKeepsLocalBranch(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "--initial-branch=topic/merge-cleanup", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	cmd = exec.Command("git", "-C", dir, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v %s", err, out)
	}
	t.Chdir(dir)
	restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
		if r.Method == "GET" {
			return restWriteResponse(200, mergeBranchPR("topic/merge-cleanup", "acme/repo", "acme/repo", "main"))
		}
		return restWriteResponse(204, "")
	})
	for _, auto := range []bool{false, true} {
		args := append(mergeDiagnosticArgs(), "-d")
		if auto {
			args = append(args, "--auto", "--subject=safe", "--body-file=-")
		}
		var stderr bytes.Buffer
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("safe"), io.Discard, &stderr); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(stderr.String(), "kept the local head branch") {
			t.Fatalf("missing local notice: %s", &stderr)
		}
		branch, err := gitProbe("symbolic-ref", "--short", "HEAD")
		if err != nil || strings.TrimSpace(branch) != "topic/merge-cleanup" {
			t.Fatalf("local branch changed: %q %v", branch, err)
		}
	}
}

func TestProtectedAutoMergeDeleteBranch(t *testing.T) {
	for _, flag := range []string{"--delete-branch", "-d", "--delete-branch=true", "--delete-branch=false"} {
		t.Run(flag, func(t *testing.T) {
			calls := 0
			capture := restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "GET" {
					t.Fatal("auto cleanup must remain native")
				}
				return restWriteResponse(200, mergeBranchPR("topic/merge-cleanup", "acme/repo", "acme/repo", "main"))
			})
			args := append(mergeDiagnosticArgs(), "--auto", flag, "--subject=internal-model", "--body-file=-")
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("internal-model"), io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			child := readRewriteCapture(t, capture)
			value := "true"
			if flag == "--delete-branch=false" {
				value = "false"
			}
			if !slices.Contains(child.Args, "--delete-branch="+value) || !slices.Contains(child.Args, "--repo=acme/repo") || !slices.Contains(child.Args, "--subject=public") {
				t.Fatalf("unprotected auto args: %v", child.Args)
			}
			wantCalls := 1
			if value == "false" {
				wantCalls = 0
			}
			if calls != wantCalls {
				t.Fatalf("calls=%d", calls)
			}
		})
	}
}

func TestProtectedPROptionError(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, command := range []string{"merge", "ready"} {
		for _, option := range []string{"--future-internal-model=private-input", "--delete-branch=private-input", "--repo", "private-input"} {
			t.Run(command+"/"+option, func(t *testing.T) {
				capture := captureRewriteGH(t)
				args := []string{"pr", command, "7", "--repo=acme/repo"}
				if command == "merge" {
					args = mergeDiagnosticArgs()
				}
				args = append(args, option)
				err := runGH(t.Context(), args, io.Discard, io.Discard)
				if !errors.Is(err, errRewritePROption) || errors.Is(err, errRewriteUnsupported) || errors.Is(err, errRewriteBlocked) {
					t.Fatalf("wrong error boundary: %v", err)
				}
				if !strings.Contains(err.Error(), "gh pr "+command+" option") || !strings.Contains(err.Error(), "supported:") || strings.Contains(err.Error(), "private-input") || strings.Contains(err.Error(), "internal-model") {
					t.Fatalf("unsafe/unhelpful error: %v", err)
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("unmodeled option fell through to native")
				}
			})
		}
	}
}

func TestProtectedMergeAlreadyMerged(t *testing.T) {
	for _, branch := range []string{"present", "gone"} {
		for _, deleteBranch := range []bool{false, true} {
			t.Run(branch+"/delete="+strconv.FormatBool(deleteBranch), func(t *testing.T) {
				t.Chdir(t.TempDir()) // Explicit --repo must work outside a checkout.
				calls := 0
				capture := restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
					calls++
					if r.Method != "GET" || r.URL.Path != "/repos/acme/repo/pulls/7" {
						t.Fatalf("already-merged PR must never be written: %s %s", r.Method, r.URL.Path)
					}
					pr := strings.Replace(mergeBranchPR("topic/merge-cleanup", "acme/repo", "acme/repo", "main"), `"merged":false`, `"merged":true`, 1)
					pr = strings.Replace(pr, `"state":"open"`, `"state":"closed"`, 1)
					if branch == "gone" {
						pr = strings.Replace(pr, `"ref":"topic/merge-cleanup"`, `"ref":""`, 1)
					}
					return restWriteResponse(200, pr)
				})
				t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
				args := mergeDiagnosticArgs()
				if deleteBranch {
					args = append(args, "--delete-branch")
				}
				var stdout, stderr bytes.Buffer
				if err := execRealGH(t.Context(), args, &stdout, &stderr); err != nil {
					t.Fatal(err)
				}
				warning := "! Pull request acme/repo#7 was already merged\n"
				if stdout.Len() != 0 || !strings.HasPrefix(stderr.String(), warning) || calls != 1 {
					t.Fatalf("stdout=%q stderr=%q reads=%d", &stdout, &stderr, calls)
				}
				line := mergeDiagnosticLine(t, stderr.String())
				if !strings.Contains(line, "child_started=false outcome=already_merged") || strings.Contains(line, "exit_code=") {
					t.Fatalf("no merge should be claimed: %s", line)
				}
				assertNoRESTWriteChild(t, capture)
			})
		}
	}
}

func TestProtectedMergeOpenAndClosedUnmerged(t *testing.T) {
	for _, state := range []string{"open", "closed"} {
		for _, diagnostics := range []string{"", "1"} {
			t.Run(state+"/diagnostics="+diagnostics, func(t *testing.T) {
				calls := 0
				capture := restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
					calls++
					if r.Method != "GET" || r.URL.Path != "/repos/acme/repo/pulls/7" {
						t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
					}
					return restWriteResponse(200, strings.Replace(restWritePRJSON, `"state":"open"`, `"state":"`+state+`"`, 1))
				})
				t.Setenv("OCTOPOOL_DIAGNOSTICS", diagnostics)
				t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", "")
				t.Setenv("OCTOPOOL_TEST_REWRITE_STDERR", "")
				if state == "closed" {
					t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "1")
					t.Setenv("OCTOPOOL_TEST_REWRITE_STDERR", "gh: Pull Request is not mergeable (HTTP 405)\n")
				}
				var stdout, stderr bytes.Buffer
				err := execRealGH(t.Context(), mergeDiagnosticArgs(), &stdout, &stderr)
				if state == "open" && err != nil {
					t.Fatal(err)
				}
				if state == "closed" {
					var exit exitCodeError
					if !errors.As(err, &exit) || exit.Code != 1 || !strings.Contains(stderr.String(), "HTTP 405") {
						t.Fatalf("merge failure lost: %v %s", err, &stderr)
					}
				}
				if calls != 1 || stdout.Len() != 0 || strings.Contains(stderr.String(), "was already merged") {
					t.Fatalf("calls=%d stdout=%s stderr=%s", calls, &stdout, &stderr)
				}
				child := readRewriteCapture(t, capture)
				if !slices.Contains(child.Args, "--method=PUT") || !slices.Contains(child.Args, "repos/acme/repo/pulls/7/merge") || len(child.Files) != 1 {
					t.Fatalf("open/closed-unmerged must retain merge PUT: %+v", child)
				}
				for _, content := range child.Files {
					var payload map[string]string
					if json.Unmarshal([]byte(content), &payload) != nil || payload["sha"] != strings.Repeat("a", 40) || payload["merge_method"] != "squash" {
						t.Fatalf("head guarantee changed: %q", content)
					}
				}
			})
		}
	}
}

func TestProtectedMergeStateReadFailsClosed(t *testing.T) {
	for _, body := range []string{`{}`, `{"state":"open","merged":true}`, `{"state":"closed"}`, `{"state":"unknown","merged":false}`} {
		t.Run(body, func(t *testing.T) {
			capture := restWriteFixture(t, rewriteActiveTestPolicy, func(*http.Request) (*http.Response, error) {
				return restWriteResponse(200, body)
			})
			if err := execRealGH(t.Context(), mergeDiagnosticArgs(), io.Discard, io.Discard); err == nil {
				t.Fatal("unverified merge state allowed publication")
			}
			assertNoRESTWriteChild(t, capture)
		})
	}
}

func TestProtectedAutoMergeRetainsNativeAlreadyMergedHandling(t *testing.T) {
	capture := restWriteFixture(t, rewriteActiveTestPolicy, func(*http.Request) (*http.Response, error) {
		t.Fatal("native auto-merge owns its state read")
		return nil, nil
	})
	t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", "")
	t.Setenv("OCTOPOOL_TEST_REWRITE_STDERR", "! Pull request acme/repo#7 was already merged\n")
	var stdout, stderr bytes.Buffer
	args := append(mergeDiagnosticArgs(), "--auto", "--subject=safe", "--body-file=-")
	if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("safe"), &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	child := readRewriteCapture(t, capture)
	if !slices.Contains(child.Args, "--auto") || stdout.Len() != 0 || withoutGraphQLNotice(stderr.String()) != "! Pull request acme/repo#7 was already merged\n" {
		t.Fatalf("native already-merged result changed: %+v %s", child.Args, &stderr)
	}
}
