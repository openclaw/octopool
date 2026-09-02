package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func prReadGit(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		t.Fatalf("fixture git %q: %v: %s", args, err, out)
	}
}

func prReadRepo(t *testing.T, branch string) {
	t.Helper()
	for _, name := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GH_REPO", "")
	t.Setenv("GH_HOST", "github.com")
	t.Chdir(t.TempDir())
	prReadGit(t, "init", "--quiet", "--initial-branch="+branch)
	prReadGit(t, "remote", "add", "origin", "https://github.com/acme/repo.git")
	prReadGit(t, "config", "remote.origin.gh-resolved", "base")
}

func prReadPolicy(pattern string) string {
	data, _ := json.Marshal(map[string]any{
		"schema_version": 1, "revision": 1, "updated_at": "2026-09-02T00:00:00Z",
		"rules": []map[string]string{{"pattern": pattern, "replacement": "public"}},
	})
	return string(data)
}

func TestProtectedPRReadBranchNative(t *testing.T) {
	for _, test := range []struct {
		name       string
		args, want []string
	}{
		{"incident", []string{"pr", "view", "openclaw/ultra-selection-issue", "-R", "openclaw/openclaw", "--json", "number,title,state,url,headRefName,headRefOid"}, []string{"pr", "view", "openclaw/ultra-selection-issue", "--repo=https://github.com/openclaw/openclaw", "--json", "number,title,state,url,headRefName,headRefOid"}},
		{"ordinary_attached", []string{"pr", "view", "topic", "-Racme/repo", "--json=number", "--jq", `"blocked-word"`}, []string{"pr", "view", "topic", "--repo=https://github.com/acme/repo", "--json=number", "--jq", `"blocked-word"`}},
		{"qualified_numeric", []string{"pr", "view", "alice:123", "--repo=acme/repo", "--json=number"}, []string{"pr", "view", "alice:123", "--repo=https://github.com/acme/repo", "--json=number"}},
		{"diff_repeated", []string{"pr", "diff", "-R=acme/other", "--patch", "--repo", "acme/repo", "--", "feature/topic"}, []string{"pr", "diff", "--repo=https://github.com/acme/other", "--patch", "--repo=https://github.com/acme/repo", "--", "feature/topic"}},
		{"checks", []string{"pr", "checks", "feature/topic", "--repo=github.com/acme/repo", "--required", "--json", "name,state", "-q.[0]"}, []string{"pr", "checks", "feature/topic", "--repo=https://github.com/acme/repo", "--required", "--json", "name,state", "-q.[0]"}},
		{"jq_owns_delimiter", []string{"pr", "view", "topic", "-Racme/repo", "--json=number", "--jq", "--"}, []string{"pr", "view", "topic", "--repo=https://github.com/acme/repo", "--json=number", "--jq", "--"}},
		{"implicit_view", []string{"pr", "view", "--json=number", "--jq", "("}, []string{"pr", "view", "topic", "--json=number", "--jq", "(", "--repo=https://github.com/acme/repo"}},
		{"implicit_diff_delimiter", []string{"pr", "diff", "--patch", "--"}, []string{"pr", "diff", "topic", "--patch", "--repo=https://github.com/acme/repo", "--"}},
		{"implicit_checks", []string{"pr", "checks", "--json=name"}, []string{"pr", "checks", "topic", "--json=name", "--repo=https://github.com/acme/repo"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			prReadRepo(t, "topic")
			_, policies := rewriteTestServer(t, prReadPolicy("blocked-word"), nil)
			capture := captureRewriteGH(t)
			original := slices.Clone(test.args)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), test.args, &out, &stderr)
			if err != nil {
				t.Fatalf("protected PR branch read rejected: %v", err)
			}
			got := readRewriteCapture(t, capture)
			if !slices.Equal(got.Args, test.want) || !slices.Equal(test.args, original) || policies.Load() != 2 || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" || got.Stdin != "" || out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
				t.Fatalf("native boundary: args=%q want=%q policies=%d output=%q/%q env=%v", got.Args, test.want, policies.Load(), out.String(), stderr.String(), got.Env)
			}
		})
	}
}

func TestProtectedPRReadCurrentTracking(t *testing.T) {
	for _, test := range []struct {
		name   string
		config [][2]string
		want   string
	}{
		{"pr_ref", [][2]string{{"branch.topic.merge", "refs/pull/42/head"}}, "42"},
		{"pr_ref_canonical", [][2]string{{"branch.topic.merge", "refs/pull/00042/head"}}, "42"},
		{"upstream_renamed", [][2]string{{"branch.topic.remote", "origin"}, {"branch.topic.merge", "refs/heads/remote/topic"}, {"push.default", "upstream"}}, "remote/topic"},
		{"push_remote_fork", [][2]string{{"branch.topic.remote", "origin"}, {"branch.topic.pushRemote", "fork"}}, "alice:topic"},
		{"remote_push_default", [][2]string{{"branch.topic.remote", "origin"}, {"remote.pushDefault", "fork"}}, "alice:topic"},
		{"push_remote_precedence", [][2]string{{"remote.pushDefault", "origin"}, {"branch.topic.pushRemote", "fork"}}, "alice:topic"},
		{"remote_url", [][2]string{{"branch.topic.remote", "https://github.com/alice/repo.git"}}, "alice:topic"},
		{"owner_case", [][2]string{{"branch.topic.remote", "https://github.com/Alice/repo.git"}}, "Alice:topic"},
	} {
		t.Run(test.name, func(t *testing.T) {
			prReadRepo(t, "topic")
			prReadGit(t, "remote", "add", "fork", "https://github.com/alice/repo.git")
			for _, pair := range test.config {
				prReadGit(t, "config", pair[0], pair[1])
			}
			rewriteTestServer(t, prReadPolicy("blocked-word"), nil)
			capture := captureRewriteGH(t)
			// Unknown export fields still use the modeled selector guard, but force native output.
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "view", "--json=unknown"}, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			got := readRewriteCapture(t, capture)
			if len(got.Args) < 3 || got.Args[2] != test.want {
				t.Fatalf("selector=%q want=%q", got.Args, test.want)
			}
		})
	}
}

func TestProtectedPRReadDenials(t *testing.T) {
	for _, test := range []struct {
		name    string
		args    []string
		pattern string
	}{
		{"private_branch", []string{"feature/blocked-word"}, "blocked-word"},
		{"private_component", []string{"feature/blocked-word"}, "^blocked-word$"},
		{"private_owner", []string{"blocked-word:topic"}, "^blocked-word$"},
		{"percent", []string{"feature/%62locked-word"}, "blocked-word"},
		{"layered", []string{"feature/%2562locked-word"}, "blocked-word"},
		{"malformed_ref", []string{"feature/../topic"}, "blocked-word"},
		{"invalid_ref", []string{"topic.lock"}, "blocked-word"},
		{"empty", []string{""}, "blocked-word"},
		{"multiple", []string{"topic", "other"}, "blocked-word"},
		{"url", []string{"https://github.com/acme/repo/pull/42"}, "blocked-word"},
		{"foreign_url", []string{"https://example.com/acme/repo/pull/42"}, "blocked-word"},
		{"url_shaped", []string{"github.com/acme/repo/pull/42"}, "blocked-word"},
		{"empty_owner", []string{":topic"}, "blocked-word"},
		{"extra_colon", []string{"alice:topic:other"}, "blocked-word"},
		{"query_model", []string{"alice:feature/topic"}, "headRefName.*feature/topic"},
		{"canonical_host", []string{"topic"}, "https://github\\.com/acme/repo"},
		{"canonical_flag", []string{"topic"}, "^--repo=https://github\\.com/acme/repo$"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var data atomic.Int64
			rewriteTestServer(t, prReadPolicy(test.pattern), func(w http.ResponseWriter, r *http.Request) { data.Add(1); w.WriteHeader(400) })
			capture := captureRewriteGH(t)
			args := append([]string{"pr", "view", "--repo=acme/repo", "--json=number"}, test.args...)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			if !errors.Is(err, errRewriteBlocked) || err.Error() != errRewriteBlocked.Error() || out.Len() != 0 || stderr.Len() != 0 || data.Load() != 0 {
				t.Fatalf("denial err=%v output=%q/%q data=%d", err, out.String(), stderr.String(), data.Load())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("denied read started child")
			}
		})
	}
}

func TestProtectedPRReadRepositoryDenials(t *testing.T) {
	for _, repo := range []string{
		"blocked-word/repo", "acme/blocked-word", "acme/%62locked-word", "acme/%2562locked-word",
		"https://example.com/acme/repo", "example.com/acme/repo", "git@example.com:acme/repo",
		"https://github.com:443/acme/repo", "https://user@github.com/acme/repo",
		"https://github.com/acme/repo?x=1", "https://github.com/acme/repo#fragment",
		"ssh://git@github.com:2222/acme/repo", "../repo", "acme/repo/extra",
		"ssh://git@github.com/acme/repo", "git@github.com:acme/repo",
		"acme/repo.git.git",
	} {
		t.Run(repo, func(t *testing.T) {
			var data atomic.Int64
			rewriteTestServer(t, prReadPolicy("^blocked-word$"), func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			// Even an overwritten repository must pass host and component checks.
			err := runGH(t.Context(), []string{"pr", "view", "topic", "-R" + repo, "--repo=acme/repo", "--json=number"}, &out, &stderr)
			assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
		})
	}
}

func assertPRReadDenied(t *testing.T, err error, capture string, out, stderr *bytes.Buffer, data int64) {
	t.Helper()
	if !errors.Is(err, errRewriteBlocked) || err.Error() != errRewriteBlocked.Error() || out.Len() != 0 || stderr.Len() != 0 || data != 0 {
		t.Fatalf("denial err=%v output=%q/%q data=%d", err, out.String(), stderr.String(), data)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("denied read started child")
	}
}

func TestProtectedPRReadCurrentDenials(t *testing.T) {
	for _, test := range []struct {
		name, branch, pattern string
		config                [][2]string
		args                  []string
	}{
		{"local_branch", "feature/blocked-word", "^blocked-word$", nil, nil},
		{"encoded_local", "feature/%2562locked-word", "blocked-word", nil, nil},
		{"numeric_local", "123", "blocked-word", nil, nil},
		{"numeric_target", "topic", "blocked-word", [][2]string{{"push.default", "upstream"}, {"branch.topic.merge", "refs/heads/123"}}, nil},
		{"private_target", "topic", "^blocked-word$", [][2]string{{"push.default", "upstream"}, {"branch.topic.merge", "refs/heads/blocked-word"}}, nil},
		{"private_base", "topic", "^blocked-word$", [][2]string{{"remote.origin.gh-resolved", "blocked-word/repo"}}, nil},
		{"foreign_base", "topic", "blocked-word", [][2]string{{"remote.origin.url", "https://example.com/acme/repo"}}, nil},
		{"foreign_head", "topic", "blocked-word", [][2]string{{"branch.topic.pushRemote", "https://example.com/alice/repo"}}, nil},
		{"derived_label", "topic", "^alice:topic$", [][2]string{{"branch.topic.remote", "https://github.com/alice/repo"}}, nil},
		{"derived_owner", "topic", "^alice$", [][2]string{{"branch.topic.remote", "https://github.com/alice/repo"}}, nil},
		{"private_tracking_number", "topic", "^42$", [][2]string{{"branch.topic.merge", "refs/pull/42/head"}}, nil},
		{"invalid_tracking_number", "topic", "blocked-word", [][2]string{{"branch.topic.merge", "refs/pull/0/head"}}, nil},
		{"invalid_push_default", "topic", "blocked-word", [][2]string{{"push.default", "invalid"}}, nil},
		{"url_push_default", "topic", "blocked-word", [][2]string{{"remote.pushDefault", "https://github.com/alice/repo"}}, nil},
		{"missing_remote", "topic", "blocked-word", [][2]string{{"branch.topic.pushRemote", "missing"}}, nil},
		{"ssh_default", "topic", "blocked-word", [][2]string{{"remote.origin.url", "git@github.com:acme/repo"}}, nil},
		{"encoded_target", "topic", "blocked-word", [][2]string{{"push.default", "upstream"}, {"branch.topic.merge", "refs/heads/%2562locked-word"}}, nil},
		{"canonical_tracking_number", "topic", "^42$", [][2]string{{"branch.topic.merge", "refs/pull/00042/head"}}, nil},
		{"repo_without_selector", "topic", "blocked-word", nil, []string{"-Racme/repo"}},
		{"delimiter_flag_is_positional", "topic", "blocked-word", nil, []string{"--", "--repo=acme/repo"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			prReadRepo(t, test.branch)
			for _, pair := range test.config {
				prReadGit(t, "config", pair[0], pair[1])
			}
			var data atomic.Int64
			rewriteTestServer(t, prReadPolicy(test.pattern), func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), append([]string{"pr", "view", "--json=number"}, test.args...), &out, &stderr)
			assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
		})
	}
}

func TestProtectedPRReadContextEdges(t *testing.T) {
	for _, test := range []struct {
		name, branch, envRepo, want string
		config                      [][2]string
		deny                        bool
	}{
		{name: "env_repo", branch: "topic", envRepo: "github.com/acme/other", want: "topic"},
		{name: "private_env_repo", branch: "topic", envRepo: "blocked-word/repo", deny: true},
		{name: "foreign_env_repo", branch: "topic", envRepo: "example.com/acme/repo", deny: true},
		{name: "qualified_numeric_current", branch: "123", want: "alice:123", config: [][2]string{{"branch.123.remote", "https://github.com/alice/repo"}}},
		{name: "default_branch_label", branch: "main", want: "main"},
		{name: "fork_default_branch_label", branch: "main", want: "alice:main", config: [][2]string{{"branch.main.remote", "https://github.com/alice/repo"}}},
		{name: "multiple_defaults", branch: "topic", deny: true, config: [][2]string{{"remote.fork.url", "https://github.com/alice/repo"}, {"remote.fork.gh-resolved", "base"}}},
		{name: "duplicate_merge", branch: "topic", deny: true, config: [][2]string{{"branch.topic.merge", "refs/heads/topic"}, {"branch.topic.merge", "refs/heads/other"}}},
		{name: "duplicate_url", branch: "topic", deny: true, config: [][2]string{{"remote.origin.url", "https://github.com/acme/other"}}},
		{name: "original_before_insteadOf", branch: "topic", deny: true, config: [][2]string{{"url.https://github.com/acme/repo.insteadOf", "https://github.com/blocked-word/repo"}, {"branch.topic.remote", "fork"}, {"remote.fork.url", "https://github.com/blocked-word/repo"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			prReadRepo(t, test.branch)
			t.Setenv("GH_REPO", test.envRepo)
			for _, pair := range test.config {
				prReadGit(t, "config", "--add", pair[0], pair[1])
			}
			var data atomic.Int64
			rewriteTestServer(t, prReadPolicy("blocked-word"), func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "--json=number"}, &out, &stderr)
			if test.deny {
				assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := readRewriteCapture(t, capture)
			if got.Args[2] != test.want || data.Load() != 0 {
				t.Fatalf("wrong selector: %q data=%d", got.Args, data.Load())
			}
		})
	}
}

func TestProtectedPRReadOtherNumericRestrictions(t *testing.T) {
	for _, args := range [][]string{
		{"issue", "view", "topic", "-Racme/repo"},
		{"run", "view", "topic", "-Racme/repo"},
		{"run", "watch", "topic", "-Racme/repo"},
		{"pr", "merge", "topic", "-Racme/repo", "--squash"},
	} {
		t.Run(strings.Join(args[:2], "_"), func(t *testing.T) {
			rewriteTestServer(t, prReadPolicy("blocked-word"), nil)
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), args, &out, &stderr)
			assertPRReadDenied(t, err, capture, &out, &stderr, 0)
		})
	}
}

func TestProtectedPRReadPolicyAndContextBoundaries(t *testing.T) {
	for _, current := range []bool{false, true} {
		for _, stage := range []string{"initial", "final", "query_final", "empty_to_active", "unavailable", "context_changed", "active_to_empty"} {
			t.Run(stage+map[bool]string{false: "/explicit", true: "/current"}[current], func(t *testing.T) {
				prReadRepo(t, "topic")
				var data atomic.Int64
				policies := rewriteTestServerPolicySequence(t, func(ordinal int64) (string, int) {
					if ordinal == 1 {
						if stage == "initial" {
							return prReadPolicy("topic"), 200
						}
						if stage == "empty_to_active" {
							return rewriteEmptyTestPolicy, 200
						}
						return prReadPolicy("blocked-word"), 200
					}
					if stage == "unavailable" {
						return "", 503
					}
					if stage == "final" || stage == "empty_to_active" {
						return prReadPolicy("^topic$"), 200
					}
					if stage == "query_final" {
						return prReadPolicy("headRefName.*topic"), 200
					}
					prReadGit(t, "symbolic-ref", "HEAD", "refs/heads/changed")
					prReadGit(t, "config", "remote.origin.url", "https://example.com/changed/repo")
					if stage == "active_to_empty" {
						return rewriteEmptyTestPolicy, 200
					}
					return prReadPolicy("blocked-word"), 200
				}, func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
				capture := captureRewriteGH(t)
				args := []string{"pr", "view"}
				if !current {
					args = append(args, "topic", "-Racme/repo")
				}
				args = append(args, "--json=number", "--jq", "(")
				var out, stderr bytes.Buffer
				err := runGH(t.Context(), args, &out, &stderr)
				if data.Load() != 0 {
					t.Fatal("branch selection entered relay")
				}
				if stage == "context_changed" || stage == "active_to_empty" {
					if err != nil {
						t.Fatal(err)
					}
					got := readRewriteCapture(t, capture)
					if !slices.Contains(got.Args, "topic") || !slices.Contains(got.Args, "--repo=https://github.com/acme/repo") || !slices.Contains(got.Args, "(") {
						t.Fatalf("lost pinned context/argv: %q", got.Args)
					}
				} else if stage == "unavailable" {
					if !errors.Is(err, errRewritePolicy) || out.Len() != 0 || stderr.Len() != 0 {
						t.Fatalf("policy failure: %v", err)
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("unavailable policy ran child")
					}
				} else {
					assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
				}
				wantPolicies := int64(2)
				if stage == "initial" {
					wantPolicies = 1
				}
				if policies.Load() != wantPolicies {
					t.Fatalf("policy calls=%d want=%d", policies.Load(), wantPolicies)
				}
			})
		}
	}
}

// Construct objects only inside the synthetic repository; no worktree commit or
// user identity is involved. Real refs let git itself prove @{push} resolution.
func prReadFixtureCommit(t *testing.T) string {
	t.Helper()
	hash := func(kind, data string) string {
		cmd := exec.Command("git", "hash-object", "-w", "-t", kind, "--stdin")
		cmd.Stdin = strings.NewReader(data)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	tree := hash("tree", "")
	return hash("commit", "tree "+tree+"\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nfixture\n")
}

func TestProtectedPRReadPushRevision(t *testing.T) {
	prReadRepo(t, "topic")
	sha := prReadFixtureCommit(t)
	prReadGit(t, "update-ref", "refs/heads/topic", sha)
	prReadGit(t, "update-ref", "refs/remotes/origin/pushed/topic", sha)
	prReadGit(t, "config", "branch.topic.remote", "origin")
	prReadGit(t, "config", "branch.topic.merge", "refs/heads/other")
	prReadGit(t, "config", "remote.origin.push", "refs/heads/topic:refs/heads/pushed/topic")
	push, err := exec.Command("git", "rev-parse", "--symbolic-full-name", "topic@{push}").Output()
	if err != nil || string(push) != "refs/remotes/origin/pushed/topic\n" {
		t.Fatalf("real push ref=%q err=%v", push, err)
	}
	t.Logf("real git topic@{push} = %s", strings.TrimSpace(string(push)))
	rewriteTestServer(t, prReadPolicy("blocked-word"), nil)
	capture := captureRewriteGH(t)
	var out, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"pr", "view", "--json=number"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	got := readRewriteCapture(t, capture)
	if got.Args[2] != "pushed/topic" {
		t.Fatalf("native push target lost: %q", got.Args)
	}
}

func TestProtectedPRReadMissingAndDetachedContext(t *testing.T) {
	for _, detached := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "detached"}[detached], func(t *testing.T) {
			prReadRepo(t, "topic")
			if detached {
				prReadGit(t, "update-ref", "--no-deref", "HEAD", prReadFixtureCommit(t))
			} else {
				t.Chdir(t.TempDir())
			}
			var data atomic.Int64
			rewriteTestServer(t, prReadPolicy("blocked-word"), func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "--json=number"}, &out, &stderr)
			assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
		})
	}
}

func TestProtectedPRReadGitOutputBound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte("[test]\nvalue = "+strings.Repeat("x", rewriteMaxContent+1)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := rewritePRReadGit("config", "--file", path, "--get", "test.value")
	if err == nil || len(out) > rewriteMaxContent {
		t.Fatalf("git output limit: bytes=%d err=%v", len(out), err)
	}
}

func TestProtectedPRReadNoDefault(t *testing.T) {
	for _, test := range []struct {
		name, origin, envRepo, forceTTY, wantRepo, wantSelector string
		remotes, config                                         [][2]string
		explicit                                                bool
	}{
		{name: "no_default", wantRepo: "acme/repo"},
		{name: "explicit_branch", explicit: true, wantRepo: "acme/repo"},
		{name: "upstream_first", remotes: [][2]string{{"github", "acme/github"}, {"upstream", "vendor/base"}}, wantRepo: "vendor/base"},
		{name: "github_before_origin", remotes: [][2]string{{"aaa", "acme/aaa"}, {"github", "acme/github"}}, wantRepo: "acme/github"},
		{name: "origin_before_other_ties", remotes: [][2]string{{"aaa", "acme/aaa"}, {"zzz", "acme/zzz"}}, wantRepo: "acme/repo"},
		{name: "single_other_remote", origin: "source", wantRepo: "acme/repo"},
		{name: "case_insensitive_priority", remotes: [][2]string{{"UPSTREAM", "vendor/base"}, {"github", "acme/github"}}, wantRepo: "vendor/base"},
		{name: "env_before_priority", envRepo: "github.com/acme/override", remotes: [][2]string{{"upstream", "vendor/base"}}, wantRepo: "acme/override"},
		{name: "configured_before_priority", remotes: [][2]string{{"upstream", "vendor/base"}}, config: [][2]string{{"remote.origin.gh-resolved", "base"}}, wantRepo: "acme/repo"},
		{name: "configured_named_repo", remotes: [][2]string{{"upstream", "vendor/base"}}, config: [][2]string{{"remote.origin.gh-resolved", "acme/override"}}, wantRepo: "acme/override"},
		{name: "forced_output_tty_still_noninteractive", forceTTY: "120", wantRepo: "acme/repo"},
		{name: "tracking_fork_label", remotes: [][2]string{{"upstream", "vendor/base"}}, config: [][2]string{{"branch.topic.remote", "origin"}}, wantRepo: "vendor/base", wantSelector: "acme:topic"},
	} {
		t.Run(test.name, func(t *testing.T) {
			prReadRepo(t, "topic")
			prReadGit(t, "config", "--unset", "remote.origin.gh-resolved")
			if test.origin != "" {
				prReadGit(t, "remote", "rename", "origin", test.origin)
			}
			for _, remote := range test.remotes {
				prReadGit(t, "remote", "add", remote[0], "https://github.com/"+remote[1]+".git")
			}
			for _, pair := range test.config {
				prReadGit(t, "config", pair[0], pair[1])
			}
			t.Setenv("GH_REPO", test.envRepo)
			t.Setenv("GH_FORCE_TTY", test.forceTTY)
			_, policies := rewriteTestServer(t, prReadPolicy("blocked-word"), nil)
			capture := captureRewriteGH(t)
			// Prove the actual native boundary is non-TTY even with forced TTY output.
			path := os.Getenv("OCTOPOOL_GH_PATH")
			script, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			script = bytes.Replace(script, []byte("#!/bin/sh\n"), []byte("#!/bin/sh\nif [ -t 0 ]; then exit 91; fi\n"), 1)
			if err := os.WriteFile(path, script, 0700); err != nil {
				t.Fatal(err)
			}
			args := []string{"pr", "view"}
			if test.explicit {
				args = append(args, "topic")
			}
			args = append(args, "--json", "number", "--jq", "(")
			original := slices.Clone(args)
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatalf("locally provable noninteractive PR read rejected: %v", err)
			}
			selector := test.wantSelector
			if selector == "" {
				selector = "topic"
			}
			want := []string{"pr", "view", selector, "--json", "number", "--jq", "(", "--repo=https://github.com/" + test.wantRepo}
			got := readRewriteCapture(t, capture)
			if !slices.Equal(got.Args, want) || !slices.Equal(args, original) || policies.Load() != 2 || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" || got.Stdin != "" || out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
				t.Fatalf("native no-default boundary: args=%q want=%q policies=%d capture=%+v output=%q/%q", got.Args, want, policies.Load(), got, out.String(), stderr.String())
			}
		})
	}
}

func TestProtectedPRReadNoDefaultDenials(t *testing.T) {
	for _, test := range []struct {
		name, origin, pattern string
		remotes               [][2]string
	}{
		{name: "tied_other_names", origin: "alpha", remotes: [][2]string{{"beta", "https://github.com/acme/other"}}},
		{name: "tied_casefold_priority", remotes: [][2]string{{"ORIGIN", "https://github.com/acme/other"}}},
		{name: "foreign_higher_priority", remotes: [][2]string{{"upstream", "https://example.com/acme/repo"}}},
		{name: "foreign_lower_priority", remotes: [][2]string{{"other", "https://example.com/acme/repo"}}},
		{name: "ssh_candidate", remotes: [][2]string{{"upstream", "git@github.com:acme/repo"}}},
		{name: "private_higher_priority", remotes: [][2]string{{"upstream", "https://github.com/blocked-word/repo"}}},
		{name: "private_lower_priority", remotes: [][2]string{{"other", "https://github.com/acme/blocked-word"}}},
		{name: "private_selected_component", pattern: "^acme$"},
		{name: "layered_repository", remotes: [][2]string{{"upstream", "https://github.com/acme/%2562locked-word"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			prReadRepo(t, "topic")
			prReadGit(t, "config", "--unset", "remote.origin.gh-resolved")
			if test.origin != "" {
				prReadGit(t, "remote", "rename", "origin", test.origin)
			}
			for _, remote := range test.remotes {
				prReadGit(t, "remote", "add", remote[0], remote[1])
			}
			pattern := test.pattern
			if pattern == "" {
				pattern = "blocked-word"
			}
			var data atomic.Int64
			rewriteTestServer(t, prReadPolicy(pattern), func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "--json", "number"}, &out, &stderr)
			assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
		})
	}
}

func TestProtectedPRReadNoDefaultPolicyAndContext(t *testing.T) {
	for _, denyFinal := range []bool{false, true} {
		t.Run(map[bool]string{false: "freeze_before_new_upstream", true: "revalidate_selected_repo"}[denyFinal], func(t *testing.T) {
			prReadRepo(t, "topic")
			prReadGit(t, "config", "--unset", "remote.origin.gh-resolved")
			var data atomic.Int64
			policies := rewriteTestServerPolicySequence(t, func(ordinal int64) (string, int) {
				if ordinal == 2 {
					prReadGit(t, "remote", "add", "upstream", "https://github.com/acme/other")
					prReadGit(t, "symbolic-ref", "HEAD", "refs/heads/changed")
					if denyFinal {
						return prReadPolicy("^acme$"), 200
					}
				}
				return prReadPolicy("blocked-word"), 200
			}, func(w http.ResponseWriter, r *http.Request) { data.Add(1) })
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"pr", "view", "--json", "number"}, &out, &stderr)
			if denyFinal {
				assertPRReadDenied(t, err, capture, &out, &stderr, data.Load())
			} else {
				if err != nil {
					t.Fatal(err)
				}
				got := readRewriteCapture(t, capture)
				want := []string{"pr", "view", "topic", "--json", "number", "--repo=https://github.com/acme/repo"}
				if !slices.Equal(got.Args, want) || data.Load() != 0 {
					t.Fatalf("selection changed after initial pin: args=%q data=%d", got.Args, data.Load())
				}
			}
			if policies.Load() != 2 {
				t.Fatalf("policy checks=%d, want initial and final", policies.Load())
			}
		})
	}
}
