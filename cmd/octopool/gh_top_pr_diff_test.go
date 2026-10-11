package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestPRDiffNamesGHParity(t *testing.T) {
	// The first seven fixtures are ported from cli/cli's Test_changedFileNames:
	// v2.102.0 (fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd),
	// pkg/cmd/pr/diff/diff_test.go. Its lineBufferSize is 4096.
	for _, test := range []struct{ name, diff, want string }{
		{"gh_empty", "", ""},
		{"gh_newline", "\n", ""},
		{"gh_added", "diff --git a/cmd.go b/cmd.go\n--- /dev/null\n+++ b/cmd.go\n@@ -0,0 +1,313 @@", "cmd.go\n"},
		{"gh_deleted", "diff --git a/cmd.go b/cmd.go\n--- a/cmd.go\n+++ /dev/null\n@@ -0,0 +1,313 @@", "cmd.go\n"},
		{"gh_renamed", fmt.Sprintf("diff --git a/baz.go b/rename.go\n--- a/baz.go\n+++ b/rename.go\n+foo\n-b%sr", strings.Repeat("a", 2*4096)), "rename.go\n"},
		{"gh_modified", fmt.Sprintf("diff --git a/baz.go b/baz.go\n--- a/baz.go\n+++ b/baz.go\n+foo\n-b%sr", strings.Repeat("a", 2*4096)), "baz.go\n"},
		{"gh_quoted_unicode", "diff --git \"a/\343\202\212\343\203\274\343\201\251\343\201\277\343\203\274.md\" \"b/\343\202\212\343\203\274\343\201\251\343\201\277\343\203\274.md\"", "\"\343\202\212\343\203\274\343\201\251\343\201\277\343\203\274.md\"\n"},
		{"spaces", "diff --git a/hello world.txt b/hello world.txt\nindex 123..456 100644\n", "hello world.txt\n"},
		{"quoted_spaces", "diff --git \"a/hello world.txt\" \"b/hello world.txt\"\n", "\"hello world.txt\"\n"},
		{"git_escaped_unicode", `diff --git "a/hello-\360\237\230\200-world" "b/hello-\360\237\230\200-world"`, "\"hello-\\360\\237\\230\\200-world\"\n"},
		{"git_escapes", `diff --git "a/tab\tquote\"slash\\line\n.txt" "b/tab\tquote\"slash\\line\n.txt"`, "\"tab\\tquote\\\"slash\\\\line\\n.txt\"\n"},
		{"unquoted_unicode", "diff --git a/café-日本語.txt b/café-日本語.txt\n", "café-日本語.txt\n"},
		{"binary", "diff --git a/logo.png b/logo.png\nindex 123..456 100644\nBinary files a/logo.png and b/logo.png differ\n", "logo.png\n"},
		{"binary_added", "diff --git a/new.png b/new.png\nnew file mode 100644\nBinary files /dev/null and b/new.png differ\n", "new.png\n"},
		{"binary_deleted", "diff --git a/old.png b/old.png\ndeleted file mode 100644\nBinary files a/old.png and /dev/null differ\n", "old.png\n"},
		{"rename_only", "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n", "new name.txt\n"},
		{"order_and_duplicates", "diff --git a/z b/z\ndiff --git a/a b/a\ndiff --git a/z b/z\n", "z\na\nz\n"},
		{"no_headers", "--- a/ignored\n+++ b/ignored\n+diff --git a/ignored b/ignored\n", ""},
		{"whitespace", "preamble\ndiff\t--git a/file b/file \t\r\n", "file\n"},
		{"greedy_b_prefix", "diff --git a/dir b/file.txt b/dir b/file.txt\n", "file.txt\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := writePRDiffNames(&out, test.diff); err != nil {
				t.Fatal(err)
			}
			if out.String() != test.want {
				t.Fatalf("output = %q, want %q", out.String(), test.want)
			}
		})
	}
}

func TestRunGHPRDiffNameOnlyRelay(t *testing.T) {
	const diff = "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n"
	const names = "new name.txt\n"
	for _, policy := range []struct{ name, body string }{{"empty", rewriteEmptyTestPolicy}, {"active", rewriteActiveTestPolicy}} {
		t.Run(policy.name, func(t *testing.T) {
			for _, test := range []struct {
				name, media, body, want, encoding string
				flags                             []string
			}{
				{"name_only", "diff", diff, names, "text", []string{"--name-only"}},
				{"name_only_equals", "diff", diff, names, "text", []string{"--name-only=true"}},
				{"name_only_patch", "diff", diff, names, "text", []string{"--name-only", "--patch"}},
				{"patch_name_only", "diff", diff, names, "text", []string{"--patch", "--name-only"}},
				{"repeated_true", "diff", diff, names, "text", []string{"--name-only=false", "--name-only"}},
				{"repeated_false", "diff", diff, diff, "text", []string{"--name-only", "--name-only=false"}},
				{"false_with_patch", "patch", diff, diff, "text", []string{"--name-only=false", "--patch"}},
				{"plain", "diff", diff, diff, "text", nil},
				{"patch", "patch", diff, diff, "text", []string{"--patch"}},
				{"empty", "diff", "", "", "text", []string{"--name-only"}},
				{"base64", "diff", diff, names, "base64", []string{"--name-only"}},
				{"tty", "diff", diff, names, "text", []string{"--name-only"}},
			} {
				t.Run(test.name, func(t *testing.T) {
					calls := 0
					rewriteTestServer(t, policy.body, func(w http.ResponseWriter, r *http.Request) {
						calls++
						var request struct {
							Method, Path string
							Headers      map[string]string
						}
						if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
							t.Error(err)
						}
						if request.Method != "GET" || request.Path != "/repos/acme/repo/pulls/233" || request.Headers["accept"] != "application/vnd.github.v3."+test.media {
							t.Errorf("unexpected request: %+v", request)
						}
						body := test.body
						if test.encoding == "base64" {
							body = base64.StdEncoding.EncodeToString([]byte(body))
						}
						raw, _ := json.Marshal(body)
						if err := json.NewEncoder(w).Encode(relayEnvelope{Status: 200, BodyEncoding: test.encoding, Body: raw}); err != nil {
							t.Error(err)
						}
					})
					capture := captureRewriteGH(t)
					t.Setenv("GH_HOST", "github.com")
					t.Setenv("GH_REPO", "")
					t.Setenv("OCTOPOOL_NO_FALLBACK", "")
					t.Setenv("OCTOPOOL_NATIVE_JOURNAL", "1")
					t.Setenv("GH_FORCE_TTY", "")
					if test.name == "tty" {
						t.Setenv("GH_FORCE_TTY", "80")
						t.Setenv("CLICOLOR_FORCE", "1")
					}
					args := append([]string{"pr", "diff", "233", "--repo", "acme/repo"}, test.flags...)
					var out, stderr bytes.Buffer
					if err := runGH(t.Context(), args, &out, &stderr); err != nil {
						t.Fatal(err)
					}
					if calls != 1 || out.String() != test.want || stderr.Len() != 0 {
						t.Fatalf("calls=%d stdout=%q stderr=%q, want %q", calls, out.String(), stderr.String(), test.want)
					}
					fallback, err := fallbackRelaySlotDirectory()
					if err != nil {
						t.Fatal(err)
					}
					for _, path := range []string{capture, journalTestPath(t), filepath.Join(fallback, nativeJournalName)} {
						if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
							t.Fatalf("relay created native capture or delegation journal %s: %v", path, err)
						}
					}
				})
			}
		})
	}
}

func TestPRDiffNameOnlyUnsupportedModifiersDelegate(t *testing.T) {
	for _, flags := range [][]string{
		{"--color", "always"}, {"--color=never"}, {"--color=auto"}, {"--color=invalid"},
		{"--web"}, {"-w"}, {"--web=false"}, {"--exclude", "*.go"}, {"-e", "*.go"},
		{"--allow-escape-sequences"}, {"--json", "files"}, {"--jq", "."},
		{"--template", "{{.}}"}, {"--unknown"},
	} {
		t.Run(strings.Join(flags, "_"), func(t *testing.T) {
			for _, names := range [][]string{nil, {"--name-only"}} {
				args := append([]string{"diff", "233", "--repo", "acme/repo"}, names...)
				args = append(args, flags...)
				var out bytes.Buffer
				result := handleGHPR(t.Context(), args, &out)
				if result.action != ghDelegate || result.err != nil || out.Len() != 0 {
					t.Fatalf("args=%q action=%v err=%v output=%q", args, result.action, result.err, out.String())
				}
			}
		})
	}
}

func TestPRDiffNameOnlyRelayFallback(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		writeCLIFallback(t, w, "local_credentials_required")
	})
	capture := captureRewriteGH(t)
	t.Setenv("OCTOPOOL_NO_FALLBACK", "")
	t.Setenv("OCTOPOOL_NATIVE_JOURNAL", "1")
	t.Setenv("GH_HOST", "github.com")
	t.Setenv("GH_REPO", "")
	args := []string{"pr", "diff", "233", "--repo=acme/repo", "--name-only", "--patch"}
	var out bytes.Buffer
	if err := runGH(t.Context(), args, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) || out.String() != "child stdout\n" {
		t.Fatalf("fallback args=%q output=%q", got.Args, out.String())
	}
	if entries := readJournalEntries(t, journalTestPath(t)); len(entries) == 0 || entries[len(entries)-1].Category != "local-fallback:local_credentials_required" {
		t.Fatalf("fallback journal=%+v", entries)
	}
}

func TestPRDiffNamesWriteError(t *testing.T) {
	want := errors.New("synthetic output closed")
	if err := writePRDiffNames(prChecksBrokenWriter{want}, "diff --git a/file b/file\n"); !errors.Is(err, want) {
		t.Fatalf("output error = %v, want %v", err, want)
	}
}
