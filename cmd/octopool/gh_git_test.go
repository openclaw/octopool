package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestGitProbeFailureAndTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX synthetic git")
	}
	for _, test := range []struct{ name, script, want string }{
		{"missing", "", "executable file not found"},
		{"failure", "#!/bin/sh\nexit 7\n", "exit status 7"},
		{"timeout", "#!/bin/sh\nexec /bin/sleep 60\n", "context deadline exceeded"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "git")
			if test.script != "" {
				if err := os.WriteFile(path, []byte(test.script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", dir)
			deadline := 5 * time.Second
			if test.name == "timeout" {
				deadline = 100 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(t.Context(), deadline)
			defer cancel()
			_, err := gitProbeContext(ctx, "remote")
			var unavailable *gitUnavailableError
			if !errors.As(err, &unavailable) || !strings.Contains(err.Error(), test.want) || !strings.HasSuffix(err.Error(), "; pass -R owner/repo or fix git") {
				t.Fatalf("error=%v", err)
			}
			if test.script != "" {
				resolved, _ := filepath.EvalSymlinks(path)
				if unavailable.path != resolved {
					t.Fatalf("path=%q want=%q", unavailable.path, resolved)
				}
			}
		})
	}
	if gitProbeTimeout != 10*time.Second {
		t.Fatal("git probe deadline changed")
	}
}

func TestReadRepositoryWithoutGit(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("GH_REPO", "")
	policy := testRewritePolicy(t, stringRewriteRule{"private", "public"})
	for _, command := range [][]string{{"pr", "view", "7", "--json=number"}, {"run", "list", "--json=databaseId"}, {"run", "rerun", "42"}} {
		p := &rewritePreparation{}
		err := prepareRewriteRead(policy, command, p)
		var unavailable *gitUnavailableError
		if !errors.As(err, &unavailable) {
			t.Fatalf("command=%q err=%v", command, err)
		}
		if err := prepareRewriteRead(policy, append(command, "-Racme/repo"), p); err != nil {
			t.Fatalf("explicit repo: %v", err)
		}
		t.Setenv("GH_REPO", "acme/repo")
		if err := prepareRewriteRead(policy, command, p); err != nil {
			t.Fatalf("GH_REPO: %v", err)
		}
		if repo, ok, err := repoFromOptionOrCurrent(""); err != nil || !ok || repo != "acme/repo" {
			t.Fatalf("unprotected GH_REPO: %q %v %v", repo, ok, err)
		}
		if _, err := currentBestEffortRepo(policy); err != nil {
			t.Fatalf("best-effort GH_REPO: %v", err)
		}
		t.Setenv("GH_REPO", "")
	}
}

func TestGitProbePreservesSymlinkDispatch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX argv[0] dispatch fixture")
	}
	dir := t.TempDir()
	dispatcher := filepath.Join(dir, "dispatcher")
	if err := os.WriteFile(dispatcher, []byte("#!/bin/sh\nif [ \"${0##*/}\" != git ]; then exit 7; fi\nprintf 'acme/repo\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dispatcher, filepath.Join(dir, "git")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	if out, err := gitProbe("config", "--get", "remote.origin.url"); err != nil || out != "acme/repo\n" {
		t.Fatalf("git shim identity changed: out=%q err=%v", out, err)
	}
}

func TestMissingOriginRetainsNativeRepositorySelection(t *testing.T) {
	prReadRepo(t, "topic")
	prReadGit(t, "remote", "rename", "origin", "upstream")
	rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	capturePath := captureRewriteGH(t)
	var stdout, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"run", "list", "--json=databaseId"}, &stdout, &stderr); err != nil {
		t.Fatalf("missing origin blocked native selection: %v %q", err, stderr.String())
	}
	capture := readRewriteCapture(t, capturePath)
	if stdout.String() != "child stdout\n" || len(capture.Args) != 3 || capture.Args[0] != "run" || strings.Contains(stderr.String(), "git unavailable") {
		t.Fatalf("native fallback changed: %+v %q %q", capture, stdout.String(), stderr.String())
	}
}

func TestGitFailureDiagnosticAtDispatch(t *testing.T) {
	for _, policy := range []string{rewriteActiveTestPolicy, rewriteEmptyTestPolicy} {
		t.Run(policy, func(t *testing.T) {
			rewriteTestServer(t, policy, nil)
			t.Setenv("PATH", t.TempDir())
			t.Setenv("GH_REPO", "")
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"run", "list", "--json=databaseId"}, &stdout, &stderr)
			var exit exitCodeError
			if !errors.As(err, &exit) || exit.Code != 1 || stdout.Len() != 0 || !strings.HasPrefix(stderr.String(), "octopool: git unavailable (git):") || strings.Contains(stderr.String(), "rewrite protection") {
				t.Fatalf("stdout=%q stderr=%q error=%v", stdout.String(), stderr.String(), err)
			}
			_, err = prepareProtectedGH(t.Context(), []string{"run", "rerun", "42"}, nil)
			if policy == rewriteActiveTestPolicy {
				var unavailable *gitUnavailableError
				if !errors.As(err, &unavailable) {
					t.Fatalf("final preparation lost git error: %v", err)
				}
			}
		})
	}
}

// A git error remains distinguishable from policy rejection at final preparation.
func TestGitFailureNotRewriteDenial(t *testing.T) {
	err := &gitUnavailableError{path: "/synthetic/git", err: context.DeadlineExceeded}
	if rewriteGitError(err) != err || rewriteGitError(errors.New("unsafe")) != errRewriteBlocked {
		t.Fatal("git error lost through protection boundary")
	}
	var output bytes.Buffer
	output.WriteString(err.Error())
	if strings.Contains(output.String(), "rewrite protection") {
		t.Fatal(output.String())
	}
}
