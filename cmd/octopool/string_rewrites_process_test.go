package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

type rewriteCapture struct {
	Args           []string
	Stdin          string
	Files          map[string]string
	Modes          map[string]uint32
	DirectoryModes map[string]uint32
}

func TestRewriteCaptureProcess(t *testing.T) {
	capturePath := os.Getenv("OCTOPOOL_TEST_REWRITE_CAPTURE")
	if capturePath == "" {
		return
	}
	args := os.Args
	for i, arg := range args {
		if arg == "--" {
			args = args[i+1:]
			break
		}
	}
	capture := rewriteCapture{Args: args, Files: map[string]string{}, Modes: map[string]uint32{}, DirectoryModes: map[string]uint32{}}
	input, _ := io.ReadAll(os.Stdin)
	capture.Stdin = string(input)
	for _, arg := range args {
		for _, prefix := range []string{"--body-file=", "--notes-file=", "--input="} {
			if path, ok := strings.CutPrefix(arg, prefix); ok {
				data, err := os.ReadFile(path)
				if err != nil {
					os.Exit(80)
				}
				capture.Files[path] = string(data)
				info, _ := os.Stat(path)
				capture.Modes[path] = uint32(info.Mode().Perm())
				dir, _ := os.Stat(filepath.Dir(path))
				capture.DirectoryModes[path] = uint32(dir.Mode().Perm())
			}
		}
	}
	data, _ := json.Marshal(capture)
	if err := os.WriteFile(capturePath, data, 0600); err != nil {
		os.Exit(81)
	}
	_, _ = io.WriteString(os.Stdout, "child stdout\n")
	_, _ = io.WriteString(os.Stderr, "child stderr\n")
	exit, _ := strconv.Atoi(os.Getenv("OCTOPOOL_TEST_REWRITE_EXIT"))
	os.Exit(exit)
}
func captureRewriteGH(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell process fixture")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fake-gh")
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(executable, "'", "'\\''") + "' -test.run=^TestRewriteCaptureProcess$ -- \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(t.TempDir(), "capture.json")
	t.Setenv("OCTOPOOL_GH_PATH", path)
	t.Setenv("OCTOPOOL_TEST_REWRITE_CAPTURE", capture)
	return capture
}
func readRewriteCapture(t *testing.T, path string) rewriteCapture {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var capture rewriteCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		t.Fatal(err)
	}
	return capture
}
func rewriteTestServer(t *testing.T, policyBody string, relay http.HandlerFunc) (*atomic.Value, *atomic.Int64) {
	t.Helper()
	body := &atomic.Value{}
	body.Store(policyBody)
	calls := &atomic.Int64{}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("incorrect caller auth")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/pools/maintainers/string-rewrites" {
			calls.Add(1)
			if r.Method != "GET" || r.Header.Get("Cache-Control") != "no-cache, no-store" {
				t.Error("incorrect policy method/cache")
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, body.Load().(string))
			return
		}
		if r.URL.Path != "/v1/github/request" || r.Method != "POST" || relay == nil {
			t.Error("unexpected relay dispatch")
			w.WriteHeader(400)
			return
		}
		relay(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv("OCTOPOOL_URL", server.URL)
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	t.Setenv("OCTOPOOL_POOL", "maintainers")
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	return body, calls
}

const rewriteActiveTestPolicy = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"internal-model","replacement":"public"}]}`
const rewriteEmptyTestPolicy = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[]}`

func TestStringRewriteProcessSnapshots(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct {
		name  string
		args  []string
		stdin string
		file  bool
		want  string
	}{
		{"issue inline", []string{"issue", "create", "-tinternal-model", "-binternal-model", "-Racme/repo"}, "unused", false, "public"},
		{"issue body file", []string{"issue", "edit", "1", "--body-file=FILE", "--repo=acme/repo"}, "unused", true, "public 🦞"},
		{"pr body stdin", []string{"pr", "comment", "1", "-F-", "-Racme/repo"}, "internal-model 🦞", false, "public 🦞"},
		{"review", []string{"pr", "review", "1", "--approve", "--body=internal-model", "-Racme/repo"}, "", false, "public"},
		{"release", []string{"release", "create", "v1", "--verify-tag", "--title=internal-model", "--notes-file=FILE", "-Racme/repo"}, "", true, "public 🦞"},
		{"pr create", []string{"pr", "create", "-tinternal-model", "-binternal-model", "-Hfeature", "-Bmain", "-Racme/repo"}, "", false, "public"},
		{"raw typed file", []string{"api", "repos/acme/repo/issues/1/comments", "-Fbody=@FILE"}, "", true, `{"body":"public 🦞"}`},
		{"raw typed stdin", []string{"api", "repos/acme/repo/issues/1/comments", "-Fbody=@-"}, "internal-model 🦞", false, `{"body":"public 🦞"}`},
		{"raw literal at", []string{"api", "repos/acme/repo/issues/1/comments", "-fbody=@internal-model"}, "", false, `{"body":"@public"}`},
		{"raw literal type", []string{"api", "repos/acme/repo/issues/1/comments", "-fbody=false"}, "", false, `{"body":"false"}`},
		{"raw JSON", []string{"api", "repos/acme/repo/pulls/1/reviews", "--input=-"}, `{"body":"\u0069nternal-model","event":"COMMENT","comments":[{"path":"safe.go","line":1,"body":"internal-model \ud83e\udd9e"}]}`, false, `{"body":"public","comments":[{"body":"public 🦞","line":1,"path":"safe.go"}],"event":"COMMENT"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			file := filepath.Join(t.TempDir(), "original.txt")
			original := []byte("internal-model 🦞")
			if test.file {
				if err := os.WriteFile(file, original, 0644); err != nil {
					t.Fatal(err)
				}
			}
			args := append([]string(nil), test.args...)
			for i, arg := range args {
				args[i] = strings.ReplaceAll(arg, "FILE", file)
			}
			var out, stderr bytes.Buffer
			err := execRealGHWithStdinAndEnv(t.Context(), args, strings.NewReader(test.stdin), &out, &stderr, os.Environ())
			if err != nil {
				t.Fatal(err)
			}
			if out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
				t.Fatalf("streams: %q %q", out.String(), stderr.String())
			}
			capture := readRewriteCapture(t, capturePath)
			if capture.Stdin != "" {
				t.Fatal("child retained live stdin")
			}
			if len(capture.Files) != 1 {
				t.Fatalf("files=%v", capture.Files)
			}
			for path, content := range capture.Files {
				if content != test.want {
					t.Fatalf("snapshot=%q want=%q", content, test.want)
				}
				if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
					t.Fatal("snapshot permissions are not private")
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("snapshot leaked")
				}
				if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
					t.Fatal("temporary directory leaked")
				}
			}
			for _, arg := range capture.Args {
				if strings.Contains(arg, "internal-model") || strings.Contains(arg, file) {
					t.Fatalf("unsanitized argv %q", arg)
				}
			}
			if test.file {
				data, err := os.ReadFile(file)
				if err != nil || !bytes.Equal(data, original) {
					t.Fatal("original file changed")
				}
			}
		})
	}
}
func TestStringRewriteProcessBlocks(t *testing.T) {
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, args := range [][]string{
		{"alias", "list"}, {"extension", "exec", "x"}, {"auth", "refresh"}, {"auth", "login", "--unknown"},
		{"api", "graphql", "-fquery=mutation { unsafe }"},
		{"api", "repos/acme/repo/releases/1/assets", "-XPOST", "--input=-"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "-Fbody=b"},
		{"api", "repos/acme/repo/issues/1/comments", "-Fbody=false"},
		{"api", "repos/acme/repo/issues/1/comments", "-Fbody=null"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--input=-"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--hostname=other.example"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--header=Authorization: unsafe"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--paginate"},
		{"api", "repos/acme/repo/issues/1/comments", "-Fbody={branch}"},
		{"api", "repos/acme/repo/pulls/1/reviews", "-Fcomments[0][body]=safe"},
		{"api", "repos/acme/repo/issues/1/comments?unsafe=value", "-fbody=a"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "-funknown=value"},
		{"api", "repos/acme/%69nternal-model"},
		{"api", "repos/acme/repo/issues?q=%2569nternal-model"},
		{"pr", "view", "1", "--web", "-Racme/repo"},
		{"release", "upload", "v1", "x", "-Racme/repo"},
	} {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			capture := captureRewriteGH(t)
			err := execRealGHWithStdin(t.Context(), args, strings.NewReader(`{"body":"safe"}`), io.Discard, io.Discard)
			if err != errRewriteBlocked {
				t.Fatalf("expected generic block, got %v for %v", err, args)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("blocked command executed")
			}
		})
	}
	for _, raw := range []string{`{"body":"safe","\u0062ody":"internal-model"}`, `{"body":"\ud800"}`, `{"body":"internal-model","unknown":"x"}`, `{"body":false}`, `{"body":"` + string([]byte{255}) + `"}`, `[]`} {
		capture := captureRewriteGH(t)
		err := execRealGHWithStdin(t.Context(), []string{"api", "repos/acme/repo/issues/1/comments", "--input=-"}, strings.NewReader(raw), io.Discard, io.Discard)
		if err != errRewriteBlocked {
			t.Fatalf("invalid JSON error=%v", err)
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatal("invalid JSON reached child")
		}
	}
	policy.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"a*","replacement":"b"}]}`)
	capture := captureRewriteGH(t)
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); err != errRewritePolicy {
		t.Fatalf("invalid policy: %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("invalid policy reached child")
	}
}
func TestStringRewriteFreshLocalMergeAndExit(t *testing.T) {
	policy, calls := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	args := []string{"issue", "edit", "1", "--body=internal-model", "-Racme/repo"}
	capture := captureRewriteGH(t)
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	policy.Store(strings.Replace(rewriteActiveTestPolicy, `"public"`, `"fresh"`, 1))
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	for _, content := range readRewriteCapture(t, capture).Files {
		if content != "fresh" {
			t.Fatal("stale policy")
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("policy calls=%d", calls.Load())
	}
	local := filepath.Join(t.TempDir(), "local.json")
	if err := os.WriteFile(local, []byte(`{"schema_version":1,"rules":[{"pattern":"fresh","replacement":"approved"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", local)
	t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "7")
	var out, stderr bytes.Buffer
	err := execRealGH(t.Context(), args, &out, &stderr)
	var exit exitCodeError
	if !errors.As(err, &exit) || exit.Code != 7 {
		t.Fatalf("exit=%v", err)
	}
	if out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
		t.Fatal("child streams changed")
	}
	for _, content := range readRewriteCapture(t, capture).Files {
		if content != "approved" {
			t.Fatal("server/local order wrong")
		}
	}
}
func TestStringRewriteEveryFallbackBoundary(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request["path"] != "/repos/acme/repo" {
			t.Error("unexpected normalized read path")
		}
		writeCLIFallback(t, w, "route_denied")
	})
	for _, entry := range []struct {
		name   string
		invoke func(context.Context, []string) error
	}{
		{"exec", func(ctx context.Context, args []string) error { return execRealGH(ctx, args, io.Discard, io.Discard) }},
		{"stdin", func(ctx context.Context, args []string) error {
			return execRealGHWithStdin(ctx, args, strings.NewReader(""), io.Discard, io.Discard)
		}},
		{"environment", func(ctx context.Context, args []string) error {
			return execRealGHWithStdinAndEnv(ctx, args, strings.NewReader(""), io.Discard, io.Discard, os.Environ())
		}},
		{"fallback", func(ctx context.Context, args []string) error {
			return execRealGHAfterLocalFallback(ctx, args, io.Discard, io.Discard, localFallbackError{Reason: "test"})
		}},
		{"runGH", func(ctx context.Context, args []string) error { return runGH(ctx, args, io.Discard, io.Discard) }},
	} {
		t.Run(entry.name, func(t *testing.T) {
			capture := captureRewriteGH(t)
			if err := entry.invoke(t.Context(), []string{"api", "repos/acme/repo"}); err != nil {
				t.Fatal(err)
			}
			readRewriteCapture(t, capture)
			if err := os.Remove(capture); err != nil {
				t.Fatal(err)
			}
			if err := entry.invoke(t.Context(), []string{"api", "repos/acme/internal-model"}); err == nil {
				t.Fatal("unsafe fallback accepted")
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unsafe fallback executed")
			}
		})
	}
}

func TestStringRewriteRawReleaseRequiresExistingTag(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capture := captureRewriteGH(t)
	args := []string{"api", "repos/acme/repo/releases", "-ftag_name=v1", "-fname=internal-model", "-fbody=internal-model", "-Fdraft=true"}
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	got := readRewriteCapture(t, capture)
	for _, body := range got.Files {
		if body != `{"body":"public","draft":true,"name":"public","tag_name":"v1"}` {
			t.Fatalf("release body=%q", body)
		}
	}
	t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "4")
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
		t.Fatalf("missing tag error=%v", err)
	}
	got = readRewriteCapture(t, capture)
	if len(got.Args) < 2 || got.Args[1] != "/repos/acme/repo/git/ref/tags/v1" || len(got.Files) != 0 {
		t.Fatalf("mutation ran after tag probe failed: %v", got.Args)
	}
}

func TestStringRewriteRelayReadAndAuthFailure(t *testing.T) {
	for _, code := range []int{200, 401} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			var relays atomic.Int64
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				relays.Add(1)
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["method"] != "GET" || body["path"] != "/repos/acme/repo" {
					t.Error("incorrect read dispatch")
				}
				if code == 401 {
					w.WriteHeader(401)
					_, _ = io.WriteString(w, `{"error":{"code":"invalid_auth","message":"expired"}}`)
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"name": "repo"})
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), []string{"api", "repos/acme/repo"}, &out, io.Discard)
			if (err != nil) != (code == 401) {
				t.Fatalf("error=%v", err)
			}
			if code == 200 && out.String() != `{"name":"repo"}`+"\n" {
				t.Fatalf("output=%q", out.String())
			}
			if relays.Load() != 1 {
				t.Fatal("read did not use relay")
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("relay auth error/success ran a child")
			}
		})
	}
}

func TestStringRewriteTopLevelWatchFallbackIsRefused(t *testing.T) {
	recordWatchSleeps(t)
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request["path"] != "/repos/acme/repo/actions/runs/42" {
			t.Error("unexpected watch path")
		}
		writeCLIFallback(t, w, "route_denied")
	})
	capture := captureRewriteGH(t)
	err := runGH(t.Context(), []string{"run", "watch", "42", "-Racme/repo", "-i5", "--exit-status"}, io.Discard, io.Discard)
	if err != errRewriteBlocked {
		t.Fatalf("native watch fallback was accepted: %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("native watch fallback ran a child")
	}
}

func TestStringRewriteActivePRHydrationAndPaginationFallback(t *testing.T) {
	t.Run("hydration", func(t *testing.T) {
		paths := []string{}
		rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			path, _ := request["path"].(string)
			paths = append(paths, path)
			switch path {
			case "/repos/acme/repo/pulls/1":
				writeCLIEnvelope(t, w, map[string]any{"number": 1, "head": map[string]any{"sha": "0123456789abcdef0123456789abcdef01234567"}})
			case "/repos/acme/repo/pulls/1/files":
				writeCLIEnvelope(t, w, []map[string]any{{"filename": "safe.go"}})
			default:
				t.Error("unexpected hydration path")
				w.WriteHeader(400)
			}
		})
		capture := captureRewriteGH(t)
		var out bytes.Buffer
		if err := runGH(t.Context(), []string{"pr", "view", "1", "-Racme/repo", "--json=number,files"}, &out, io.Discard); err != nil {
			t.Fatal(err)
		}
		if len(paths) != 3 || !strings.Contains(out.String(), "safe.go") {
			t.Fatalf("hydration paths=%v output=%q", paths, out.String())
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatal("hydration unexpectedly delegated")
		}
	})
	t.Run("pagination", func(t *testing.T) {
		var relays atomic.Int64
		rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
			relays.Add(1)
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if request["path"] != "/repos/acme/repo/issues" {
				t.Error("unexpected page path")
			}
			writeCLIEnvelope(t, w, []int{1})
		})
		capture := captureRewriteGH(t)
		if err := runGH(t.Context(), []string{"api", "repos/acme/repo/issues?per_page=1", "--paginate"}, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		if relays.Load() != maxRelayPages {
			t.Fatalf("page requests=%d", relays.Load())
		}
		got := readRewriteCapture(t, capture)
		if !strings.Contains(strings.Join(got.Args, " "), "--paginate") {
			t.Fatal("pagination fallback lost arguments")
		}
	})
}
