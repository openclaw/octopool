package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Independently inventoried from cli/cli v2.98.0 root and pr/issue/release/auth
// registration and constructors. This is the selected native-topic contract,
// not a table generated from rewriteBootstrapInvocation or its helper.
func nativeBootstrapTopics() [][]string {
	return [][]string{
		{"api"}, {"pr"}, {"issue"}, {"release"}, {"auth"}, {"status"},
		{"pr", "create"}, {"pr", "edit"}, {"pr", "comment"}, {"pr", "review"},
		{"pr", "view"}, {"pr", "list"}, {"pr", "status"}, {"pr", "merge"}, {"pr", "ready"},
		{"issue", "create"}, {"issue", "edit"}, {"issue", "comment"},
		{"issue", "view"}, {"issue", "list"}, {"issue", "status"},
		{"release", "create"}, {"release", "edit"}, {"release", "view"}, {"release", "list"},
		{"auth", "login"}, {"auth", "status"},
	}
}

func bootstrapHelpForms(topic []string) [][]string {
	forms := [][]string{append(slices.Clone(topic), "--help"), append([]string{"help"}, topic...)}
	// These native leaves register -h as a string hostname, not help.
	if len(topic) != 2 || topic[0] != "auth" {
		forms = append(forms, append(slices.Clone(topic), "-h"))
	}
	return forms
}

func buildBootstrapRecorder(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), executableName("help-recorder"))
	tool, env := testCompiler(t)
	cmd := exec.CommandContext(t.Context(), tool, "build", "-o", bin, "testdata/help-bootstrap-gh.go")
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build portable help recorder: %v\n%s", err, out)
	}
	return bin
}

type bootstrapCLI struct {
	bin, native, url, token, local, dir string
	shim                                bool
	calls                               atomic.Int64
}

func newBootstrapCLI(t *testing.T, bin, native, state string, shim bool) *bootstrapCLI {
	t.Helper()
	fixture := &bootstrapCLI{bin: bin, native: native, token: "test-token", shim: shim, dir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := fixture.calls.Add(1)
		if r.URL.Path != "/v1/pools/maintainers/string-rewrites" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("Cache-Control") != "no-cache, no-store" {
			t.Errorf("unexpected policy/relay request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(400)
			return
		}
		if state == "failed-401" || (state == "final-401" && call == 2) {
			w.WriteHeader(401)
			return
		}
		if state == "failed-503" {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, rewriteActiveTestPolicy)
	}))
	t.Cleanup(server.Close)
	fixture.url = server.URL
	if state == "missing-login" {
		fixture.token = ""
	}
	if state == "malformed-local" {
		fixture.local = filepath.Join(fixture.dir, "policy.json")
		if err := os.WriteFile(fixture.local, []byte(`{"schema_version":1,"rules":`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return fixture
}

func (fixture *bootstrapCLI) run(t *testing.T, args []string, stdin *os.File, observeInput bool, exit int) (cliResult, []rewriteCapture) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	argv := slices.Clone(args)
	if !fixture.shim {
		argv = append([]string{"gh"}, argv...)
	}
	cmd := exec.CommandContext(ctx, fixture.bin, argv...)
	cmd.Dir = fixture.dir
	cmd.Stdin = stdin
	var env []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if !strings.HasPrefix(key, "OCTOPOOL_") && !strings.HasPrefix(key, "GH_") && !strings.HasPrefix(key, "GITHUB_") {
			env = append(env, entry)
		}
	}
	for _, entry := range testConfigEnv(t.TempDir()) {
		_, dir, _ := strings.Cut(entry, "=")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		env = append(env, entry)
	}
	capturePath := filepath.Join(t.TempDir(), "dispatch.jsonl")
	env = append(env, "OCTOPOOL_URL="+fixture.url, "OCTOPOOL_TOKEN="+fixture.token,
		"OCTOPOOL_POOL=maintainers", "OCTOPOOL_STRING_REWRITE_FILE="+fixture.local,
		"OCTOPOOL_GH_PATH="+fixture.native, "OCTOPOOL_TEST_HELP_CAPTURE="+capturePath,
		"OCTOPOOL_TEST_HELP_EXIT="+strconv.Itoa(exit), "GH_HOST=other.example.test", "GH_REPO=other.example.test/wrong/repo")
	if observeInput {
		env = append(env, "OCTOPOOL_TEST_HELP_INPUT=1")
	}
	cmd.Env = env
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("CLI exceeded bounded process deadline: %v; stdout=%q stderr=%q", ctx.Err(), stdout.String(), stderr.String())
	}
	if strings.Contains(stderr.String(), "fixture:") {
		t.Fatalf("synthetic child fixture failure: %v; %s", err, stderr.String())
	}
	var captures []rewriteCapture
	data, readErr := os.ReadFile(capturePath)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatal(readErr)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	for {
		var capture rewriteCapture
		if err := decoder.Decode(&capture); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		captures = append(captures, capture)
	}
	return cliResult{stdout.String(), stderr.String(), err}, captures
}

func assertBootstrapChild(t *testing.T, result cliResult, captures []rewriteCapture, args []string, exit int) {
	t.Helper()
	if exit == 0 && result.err != nil {
		t.Errorf("canonical/bootstrap CLI failed: %v; stderr=%q", result.err, result.stderr)
	}
	if exit != 0 {
		var childExit *exec.ExitError
		if !errors.As(result.err, &childExit) || childExit.ExitCode() != exit {
			t.Errorf("child exit not preserved: %v, want %d", result.err, exit)
		}
	}
	if result.stdout != "synthetic child stdout\n" || result.stderr != "synthetic child stderr\n" {
		t.Errorf("child streams not preserved: stdout=%q stderr=%q", result.stdout, result.stderr)
	}
	if len(captures) != 1 {
		t.Fatalf("child dispatch count=%d, want 1; args=%q", len(captures), args)
	}
	capture := captures[0]
	if !slices.Equal(capture.Args, args) || capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" {
		t.Errorf("final child argv/host mismatch: %+v; want %q", capture, args)
	}
}

func assertBootstrapBlocked(t *testing.T, result cliResult, captures []rewriteCapture) {
	t.Helper()
	if result.err == nil || result.stdout != "" || len(captures) != 0 || !strings.Contains(result.stderr, "string rewrite") {
		t.Errorf("expected guarded rejection before child: err=%v stdout=%q stderr=%q dispatches=%+v", result.err, result.stdout, result.stderr, captures)
	}
}

func TestCLIHelpBootstrap(t *testing.T) {
	bin, native := buildCLIBinary(t), buildBootstrapRecorder(t)
	shim := filepath.Join(t.TempDir(), executableName("gh"))
	data, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, data, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		name, bin string
		shim      bool
	}{{"explicit", bin, false}, {"shim", shim, true}} {
		t.Run(entry.name, func(t *testing.T) {
			for _, state := range []string{"missing-login", "failed-401", "failed-503", "malformed-local"} {
				t.Run(state, func(t *testing.T) {
					fixture := newBootstrapCLI(t, entry.bin, native, state, entry.shim)
					t.Run("canonical", func(t *testing.T) {
						count := 0
						for _, topic := range nativeBootstrapTopics() {
							for _, args := range bootstrapHelpForms(topic) {
								count++
								t.Run(strings.Join(args, "_"), func(t *testing.T) {
									before := fixture.calls.Load()
									result, captures := fixture.run(t, args, nil, false, 0)
									assertBootstrapChild(t, result, captures, args, 0)
									if got := fixture.calls.Load() - before; got != 0 {
										t.Errorf("help made %d policy/relay calls", got)
									}
								})
							}
						}
						if count != 79 {
							t.Fatalf("native-topic inventory has %d forms, want 79", count)
						}
					})
					t.Run("excluded", func(t *testing.T) {
						for _, args := range excludedBootstrapHelp() {
							t.Run(strings.Join(args, "_"), func(t *testing.T) {
								before := fixture.calls.Load()
								result, captures := fixture.run(t, args, nil, false, 0)
								assertBootstrapBlocked(t, result, captures)
								want := int64(1)
								if state == "missing-login" {
									want = 0
								}
								if got := fixture.calls.Load() - before; got != want {
									t.Errorf("policy calls=%d, want %d", got, want)
								}
							})
						}
					})
				})
			}
			t.Run("root-and-auth", func(t *testing.T) { testBootstrapRootAndAuth(t, entry.bin, native, entry.shim) })
			t.Run("idle-stdin", func(t *testing.T) { testBootstrapIdleStdin(t, entry.bin, native, entry.shim) })
			t.Run("operational", func(t *testing.T) { testBootstrapOperational(t, entry.bin, native, entry.shim) })
		})
	}
}

func excludedBootstrapHelp() [][]string {
	var args [][]string
	for _, topic := range [][]string{
		{"view"}, {"list"}, {"create"}, {"edit"}, {"comment"}, {"review"}, {"login"}, {"merge"}, {"ready"},
		{"view", "pr"}, {"list", "pr"}, {"view", "list"}, {"list", "view"},
		{"issue", "review"}, {"release", "comment"}, {"auth", "create"}, {"pr", "login"}, {"pr", "pr"},
		{"pr", "view", "list"}, {"api", "pr"}, {"pr view"}, {"pr", "view list"},
		{"PR", "view"}, {"pr", "view "}, {"pr", "new"}, {"pr", "ls"}, {"environment"}, {"repo"},
	} {
		args = append(args, bootstrapHelpForms(topic)...)
	}
	args = append(args,
		[]string{"auth", "login", "-h"}, []string{"auth", "status", "-h"},
		[]string{"auth", "status", "--template", "--help"}, []string{"auth", "status", "-t", "-h"},
		[]string{"auth", "login", "--with-token", "--help"},
	)
	// Some excluded forms are true native help (notably -h=false and -sh).
	// They still carry options/operands outside the selected exact-topic contract.
	for _, tail := range [][]string{
		{"--help=false"}, {"--help=0"}, {"--help=invalid"}, {"--help="}, {"--help=TRUE"},
		{"--help", "--help=false"}, {"--help=false", "--help"}, {"--help", "false"},
		{"-h=false"}, {"-hh=false"}, {"-h", "--help=false"}, {"-sh"}, {"-sF--help"}, {"-s=falseh"},
		{"--", "--help"}, {"--", "-h"}, {"--body-file", "--", "--help"},
		{"--body-file", "--help"}, {"-F", "--help"}, {"-F--help"}, {"-F=--help"},
		{"--repo", "--help"}, {"--match-head-commit", "--help"}, {"--subject", "--help"}, {"--body", "--help"},
		{"--unknown", "--help"}, {"--help", "--unknown"}, {"--unknown", "-h"}, {"-h", "--unknown"},
		{"123", "--help"},
	} {
		args = append(args, append([]string{"pr", "merge"}, tail...))
	}
	return args
}

func testBootstrapRootAndAuth(t *testing.T, bin, native string, shim bool) {
	fixture := newBootstrapCLI(t, bin, native, "missing-login", shim)
	for _, args := range [][]string{nil, {"--help"}, {"-h"}, {"help"}, {"--version"}, {"version"}, {"--help", "view"}, {"-h", "pr", "view"}} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			result, captures := fixture.run(t, args, nil, false, 0)
			local := !shim && (len(args) == 0 || args[0] == "--help" || args[0] == "-h")
			if local {
				if result.err != nil || result.stderr != "" || !strings.HasPrefix(result.stdout, "usage: octopool gh ") || len(captures) != 0 {
					t.Fatalf("explicit root usage changed: %+v; captures=%+v", result, captures)
				}
			} else if len(args) > 1 {
				// Shim root-leading help goes directly to the final guard.
				assertBootstrapBlocked(t, result, captures)
			} else {
				assertBootstrapChild(t, result, captures, args, 0)
			}
		})
	}
	// Literal query bytes, independently specified rather than copied from the
	// production authStatusViewerQuery constant.
	viewer := []string{"api", "graphql", "--hostname", "github.com", "-f", "query=query OctopoolAuthStatus { viewer { login } }", "--jq", ".data.viewer.login"}
	for _, args := range [][]string{
		{"auth", "login", "-h", "github.com"}, {"auth", "status", "-h", "github.com"},
		{"auth", "login", "--hostname=github.com", "-p", "ssh", "-s", "repo,read:org,gist,workflow", "-w", "--skip-ssh-key", "--insecure-storage"},
		{"auth", "login", "--git-protocol=https", "--scopes=repo"},
		{"auth", "status", "-a", "--hostname=github.com", "--json", "hosts", "-q", ".hosts", "-t", "{{.}}"},
		{"auth", "status", "--template=--help"}, {"auth", "status", "--template=-h"}, viewer,
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			result, captures := fixture.run(t, args, nil, false, 0)
			assertBootstrapChild(t, result, captures, args, 0)
		})
	}
	bad := [][]string{
		{"auth", "login", "-h", "other.example.test"}, {"auth", "status", "--hostname=other.example.test"},
		{"auth", "login", "--hostname", "github.com", "-h", "github.com"},
		{"auth", "login", "-p", "git"}, {"auth", "login", "-s", "admin:org"},
		{"auth", "login", "--scopes=repo,unknown"}, {"auth", "login", "--scopes=repo,repo", "-s", "repo"},
		{"auth", "status", "--active", "-a"}, {"auth", "status", "--jq=x", "-q", "x"},
		{"auth", "status", "--template", "--help"}, {"auth", "status", "--template", "-h"},
		{"auth", "login", "--with-token", "--help"}, {"auth", "login", "--unknown"},
		{"auth", "login", "extra"}, {"auth", "refresh"}, {"auth", "token"},
	}
	for _, index := range []int{3, 5, 7} {
		args := slices.Clone(viewer)
		args[index] += "x"
		bad = append(bad, args)
	}
	bad = append(bad, append(slices.Clone(viewer), "--silent"))
	for _, args := range bad {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			result, captures := fixture.run(t, args, nil, false, 0)
			assertBootstrapBlocked(t, result, captures)
		})
	}
	t.Run("with-token", func(t *testing.T) {
		args := []string{"auth", "login", "--with-token", "-h", "github.com"}
		const token = "synthetic-login-input\n"
		result, captures := fixture.run(t, args, bootstrapInputFile(t, token), true, 0)
		assertBootstrapChild(t, result, captures, args, 0)
		if captures[0].Stdin != token {
			t.Errorf("synthetic auth token bytes changed: %q", captures[0].Stdin)
		}
	})
	if got := fixture.calls.Load(); got != 0 {
		t.Errorf("missing-login bootstrap controls made %d network calls", got)
	}
}

func testBootstrapIdleStdin(t *testing.T, bin, native string, shim bool) {
	fixture := newBootstrapCLI(t, bin, native, "malformed-local", shim)
	for _, leaf := range []string{"merge", "ready"} {
		for _, args := range bootstrapHelpForms([]string{"pr", leaf}) {
			for _, pipe := range []bool{false, true} {
				t.Run(strings.Join(args, "_")+"/pipe="+strconv.FormatBool(pipe), func(t *testing.T) {
					const input = "untouched synthetic stdin\n"
					var reader, writer *os.File
					var err error
					if pipe {
						reader, writer, err = os.Pipe()
						if err != nil {
							t.Fatal(err)
						}
						defer writer.Close()
						if _, err := writer.WriteString(input); err != nil {
							t.Fatal(err)
						}
					} else {
						reader = bootstrapInputFile(t, "prefix:"+input)
						if _, err := reader.Seek(7, io.SeekStart); err != nil {
							t.Fatal(err)
						}
					}
					defer reader.Close()
					// An open writer makes accidental stdin draining hit the existing
					// process deadline instead of being masked by immediate EOF.
					result, captures := fixture.run(t, args, reader, false, 0)
					assertBootstrapChild(t, result, captures, args, 0)
					if pipe {
						if err := writer.Close(); err != nil {
							t.Fatal(err)
						}
					} else if offset, err := reader.Seek(0, io.SeekCurrent); err != nil || offset != 7 {
						t.Fatalf("pure help consumed regular-file stdin: offset=%d err=%v", offset, err)
					}
					remaining, err := io.ReadAll(reader)
					if err != nil || string(remaining) != input {
						t.Fatalf("pure help consumed pipe/file stdin: %q; %v", remaining, err)
					}
				})
			}
		}
	}
	if got := fixture.calls.Load(); got != 0 {
		t.Errorf("pure help made %d policy calls", got)
	}
}

func bootstrapInputFile(t *testing.T, data string) *os.File {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stdin.txt")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func testBootstrapOperational(t *testing.T, bin, native string, shim bool) {
	fixture := newBootstrapCLI(t, bin, native, "active", shim)
	sha := strings.Repeat("a", 40)
	body := "Reviewed internal-model fix\n\nCo-authored-by: Contributor <contributor@example.com>\n"
	path := filepath.Join(fixture.dir, "--help")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	base := []string{"pr", "merge", "123", "--repo", "acme/repo", "--squash", "--match-head-commit", sha}
	for _, input := range []struct {
		field string
		want  string
		forms [][]string
	}{
		{"commit_message", strings.ReplaceAll(body, "internal-model", "public"), [][]string{{"--body-file", "--help"}, {"--body-file=--help"}, {"-F", "--help"}, {"-F--help"}, {"-F=--help"}}},
		{"commit_title", "--help", [][]string{{"--subject", "--help"}, {"--subject=--help"}, {"-t", "--help"}, {"-t--help"}, {"-t=--help"}}},
	} {
		for _, flags := range input.forms {
			for _, exit := range []int{0, 19} {
				t.Run(strings.Join(flags, "_")+"/exit="+strconv.Itoa(exit), func(t *testing.T) {
					stdin := bootstrapInputFile(t, "unused live stdin")
					before := fixture.calls.Load()
					result, captures := fixture.run(t, append(slices.Clone(base), flags...), stdin, true, exit)
					if len(captures) != 1 || len(captures[0].Files) != 1 {
						t.Fatalf("merge did not dispatch one private snapshot: %+v; %+v", result, captures)
					}
					for snapshot, content := range captures[0].Files {
						wantArgs := []string{"api", "repos/acme/repo/pulls/123/merge", "--method=PUT", "--hostname=github.com", "--input=" + snapshot, "--silent=true"}
						assertBootstrapChild(t, result, captures, wantArgs, exit)
						var payload map[string]string
						if err := json.Unmarshal([]byte(content), &payload); err != nil || len(payload) != 3 || payload["sha"] != sha || payload["merge_method"] != "squash" || payload[input.field] != input.want {
							t.Fatalf("merge SHA/method/content bytes changed: %q (%v)", content, err)
						}
						assertBootstrapSnapshot(t, captures[0], snapshot)
					}
					if got := fixture.calls.Load() - before; got != 2 {
						t.Errorf("merge initial/final policy calls=%d, want 2", got)
					}
					if offset, err := stdin.Seek(0, io.SeekCurrent); err != nil || offset != 0 || captures[0].Stdin != "" {
						t.Errorf("file merge consumed live stdin or forwarded it: offset=%d capture=%q err=%v", offset, captures[0].Stdin, err)
					}
					if original, err := os.ReadFile(path); err != nil || string(original) != body {
						t.Fatalf("help-named original changed: %q (%v)", original, err)
					}
				})
			}
		}
	}
	for _, flags := range [][]string{
		{"--help=false"}, {"--help=invalid"}, {"--help=TRUE"}, {"-h=false"}, {"-sh"},
		{"--", "--help"}, {"--body-file", "--", "--help"}, {"-sF--help"},
		{"--subject", "--help", "-tother"}, {"--subject"}, {"--title", "--help"},
		{"--auto"}, {"--admin"}, {"--match-head-commit", "short"},
	} {
		t.Run("strict-merge/"+strings.Join(flags, "_"), func(t *testing.T) {
			stdin := bootstrapInputFile(t, "unread input")
			before := fixture.calls.Load()
			result, captures := fixture.run(t, append(slices.Clone(base), flags...), stdin, true, 0)
			assertBootstrapBlocked(t, result, captures)
			if got := fixture.calls.Load() - before; got != 2 {
				t.Errorf("strict merge calls=%d, want 2", got)
			}
			if offset, err := stdin.Seek(0, io.SeekCurrent); err != nil || offset != 0 {
				t.Errorf("invalid merge consumed stdin: %d (%v)", offset, err)
			}
		})
	}
	for _, args := range [][]string{{"view", "--help"}, {"help", "view", "pr"}, {"pr", "view", "list", "--help"}, append(slices.Clone(base), "--subject", "--help")} {
		t.Run("fresh-final-policy/"+strings.Join(args, "_"), func(t *testing.T) {
			changed := newBootstrapCLI(t, bin, native, "final-401", shim)
			result, captures := changed.run(t, args, nil, false, 0)
			assertBootstrapBlocked(t, result, captures)
			if got := changed.calls.Load(); got != 2 {
				t.Errorf("excluded topic did not check initial and final policy: %d", got)
			}
		})
	}
	for _, test := range []struct {
		name string
		args []string
	}{
		{"short-head", []string{"pr", "merge", "123", "--repo=acme/repo", "--squash", "--match-head-commit=short"}},
		{"missing-head", []string{"pr", "merge", "123", "--repo=acme/repo", "--squash"}},
		{"nonnumeric", []string{"pr", "merge", "branch", "--repo=acme/repo", "--squash", "--match-head-commit=" + sha}},
		{"missing-squash", []string{"pr", "merge", "123", "--repo=acme/repo", "--match-head-commit=" + sha}},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, captures := fixture.run(t, test.args, nil, true, 0)
			assertBootstrapBlocked(t, result, captures)
		})
	}
	t.Run("extension-name-under-policy", func(t *testing.T) {
		args := []string{"view", "--help"}
		before := fixture.calls.Load()
		result, captures := fixture.run(t, args, nil, false, 0)
		assertBootstrapChild(t, result, captures, args, 0)
		if got := fixture.calls.Load() - before; got != 2 {
			t.Errorf("extension-name dispatch must check both policy boundaries: %d", got)
		}
	})
	for _, test := range []struct {
		name string
		args []string
		body string
	}{
		{"content", []string{"pr", "comment", "123", "--repo=acme/repo", "--body-file=-"}, "internal-model body\n"},
		{"declared-json", []string{"workflow", "run", "deploy.yml", "--repo=acme/repo", "--json", "--help=false"}, `{"message":"internal-model"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := fixture.calls.Load()
			result, captures := fixture.run(t, test.args, bootstrapInputFile(t, test.body), true, 0)
			if result.err != nil || len(captures) != 1 {
				t.Fatalf("operational sibling failed: %+v; %+v", result, captures)
			}
			capture := captures[0]
			if test.name == "content" {
				if len(capture.Files) != 1 || capture.Stdin != "" {
					t.Fatalf("content was not snapshotted: %+v", capture)
				}
				for snapshot, content := range capture.Files {
					if content != "public body\n" {
						t.Errorf("content rewrite=%q", content)
					}
					assertBootstrapSnapshot(t, capture, snapshot)
				}
			} else {
				var payload map[string]string
				if err := json.Unmarshal([]byte(capture.Stdin), &payload); err != nil || len(payload) != 1 || payload["message"] != "public" {
					t.Errorf("declared JSON was not rewritten: %q (%v)", capture.Stdin, err)
				}
			}
			if got := fixture.calls.Load() - before; got != 2 {
				t.Errorf("sibling initial/final policy calls=%d, want 2", got)
			}
		})
	}
}

func assertBootstrapSnapshot(t *testing.T, capture rewriteCapture, path string) {
	t.Helper()
	// Windows permissions use ACLs rather than POSIX mode bits; native Windows
	// executes the same creation/read/cleanup proof without asserting Unix bits.
	if runtime.GOOS != "windows" && (capture.Modes[path] != 0o600 || capture.DirectoryModes[path] != 0o700) {
		t.Errorf("snapshot permissions not private: file=%o directory=%o", capture.Modes[path], capture.DirectoryModes[path])
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("snapshot survived child exit: %s (%v)", path, err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Errorf("snapshot directory survived child exit: %s (%v)", filepath.Dir(path), err)
	}
}
