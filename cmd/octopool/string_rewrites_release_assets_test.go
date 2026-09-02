package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestReleaseAssetsProcessEightOpaqueSnapshots(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capturePath := captureRewriteGH(t)
	t.Setenv("GH_HOST", "other.example")
	t.Setenv("GH_REPO", "other/repo")
	directory := releaseAssetFilenameSourceDirectory(t)
	notes := "# Toolkit 1.2.3\r\n\nReviewed release notes. 🦞\n"
	notesPath := filepath.Join(directory, "notes.md")
	if err := os.WriteFile(notesPath, []byte(notes), 0600); err != nil {
		t.Fatal(err)
	}
	names := []string{"toolkit_1.2.3_darwin_amd64.tar.gz", "toolkit_1.2.3_darwin_arm64.tar.gz", "toolkit_1.2.3_linux_amd64.tar.gz", "toolkit_1.2.3_linux_arm64.tar.gz", "toolkit_1.2.3_windows_amd64.zip", "toolkit_1.2.3_windows_arm64.zip", "checksums.txt", "provenance.json"}
	args := []string{"release", "create", "v1.2.3", "--repo", "acme/toolkit", "--draft", "--verify-tag", "--title", "Toolkit 1.2.3", "--notes-file", notesPath}
	payloads := make([][]byte, len(names))
	for i, name := range names {
		payloads[i] = append([]byte{byte(i), 0, 0xff, 0xfe}, []byte("internal-model\n"+rewriteActiveTestPolicy)...)
		if name == "provenance.json" {
			payloads[i] = []byte(rewriteActiveTestPolicy)
		}
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, payloads[i], 0600); err != nil {
			t.Fatal(err)
		}
		args = append(args, path)
	}
	var stdout, stderr bytes.Buffer
	if err := execRealGHWithStdin(context.Background(), args, strings.NewReader("must not reach child"), &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	capture := readRewriteCapture(t, capturePath)
	if !slices.Equal(capture.Args[:3], []string{"release", "create", "v1.2.3"}) || !slices.Contains(capture.Args, "--title=Toolkit 1.2.3") || !slices.Contains(capture.Args, "--repo=acme/toolkit") || !slices.Contains(capture.Args, "--draft=true") || !slices.Contains(capture.Args, "--verify-tag=true") {
		t.Fatalf("metadata: %v", capture.Args)
	}
	if capture.Stdin != "" || capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" {
		t.Fatalf("stdin/host: %+v", capture)
	}
	if stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
		t.Fatalf("streams: %q %q", stdout.String(), stderr.String())
	}
	if len(capture.FileData) != 9 || !rewriteCaptureHasContent(capture, notes) {
		t.Fatal("canonical notes or asset count changed")
	}
	assets := []string{}
	for _, arg := range capture.Args[3:] {
		if !strings.HasPrefix(arg, "-") {
			assets = append(assets, arg)
		}
	}
	if len(assets) != len(names) {
		t.Fatalf("assets: %v", assets)
	}
	for i, path := range assets {
		if filepath.Base(path) != names[i] || !bytes.Equal(capture.FileData[path], payloads[i]) || path == filepath.Join(directory, names[i]) {
			t.Fatalf("asset %d changed", i)
		}
	}
	for path := range capture.FileData {
		if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
			t.Fatal("nonprivate snapshot")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("snapshot leaked")
		}
		if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
			t.Fatal("snapshot directory leaked")
		}
	}
}

func releaseAssetArgs(paths ...string) []string {
	return append([]string{"release", "create", "v1.2.3", "--repo=acme/toolkit", "--draft", "--verify-tag", "--title=Toolkit 1.2.3", "--notes=Reviewed notes.\n"}, paths...)
}

func TestReleaseHostQualifiedRepoSnapshots(t *testing.T) {
	rewriteTestServer(t, prReadPolicy("private-term"), nil)
	t.Setenv("GH_HOST", "other.example")
	t.Setenv("GH_REPO", "other.example/wrong/repo")
	for _, repo := range []string{"github.com/Acme/Toolkit", "https://github.com/Acme/Toolkit", "Acme/Toolkit"} {
		for _, spelling := range []string{"--repo", "--repo=", "-R", "-Rattached"} {
			for _, assets := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/assets=%t", repo, spelling, assets), func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					title, notes := "private-term release", "# private-term\r\n\nSynthetic notes. 🦞\n"
					if assets {
						title, notes = "Toolkit 1.2.3", "# Toolkit 1.2.3\r\n\nSynthetic frozen notes. 🦞\n"
					}
					notesPath := releaseAssetFile(t, "frozen.md", []byte(notes))
					args := []string{"release", "create", "v1.2.3", "--draft", "--verify-tag", "--title", title, "--notes-file", notesPath}
					switch spelling {
					case "--repo", "-R":
						args = append(args, spelling, repo)
					case "--repo=":
						args = append(args, spelling+repo)
					case "-Rattached":
						args = append(args, "-R"+repo)
					}
					payload := []byte{0, 0xff, 1, 2}
					assetPath := ""
					if assets {
						assetPath = releaseAssetFile(t, "toolkit.zip", payload)
						args = append(args, assetPath)
					}
					original := slices.Clone(args)
					if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("unused"), io.Discard, io.Discard); err != nil {
						t.Fatal(err)
					}
					got := readRewriteCapture(t, capturePath)
					wantTitle := strings.ReplaceAll(title, "private-term", "public")
					wantNotes := strings.ReplaceAll(notes, "private-term", "public")
					for _, arg := range []string{"--repo=acme/Toolkit", "--title=" + wantTitle, "--draft=true", "--verify-tag=true"} {
						if !slices.Contains(got.Args, arg) {
							t.Errorf("missing %q in native args %q", arg, got.Args)
						}
					}
					if !slices.Equal(args, original) || !slices.Equal(got.Args[:3], args[:3]) || got.Stdin != "" || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" {
						t.Fatalf("argument/host/stream boundary changed: %+v", got)
					}
					wantFiles := 1
					if assets {
						wantFiles++
						staged := got.Args[len(got.Args)-1]
						if staged == assetPath || filepath.Base(staged) != "toolkit.zip" || !bytes.Equal(got.FileData[staged], payload) {
							t.Fatal("asset snapshot changed")
						}
						if data, err := os.ReadFile(assetPath); err != nil || !bytes.Equal(data, payload) {
							t.Fatal("source asset changed")
						}
					}
					if len(got.Files) != wantFiles || !rewriteCaptureHasContent(got, wantNotes) {
						t.Fatal("native child did not receive expected notes/assets")
					}
					for path := range got.Files {
						if path == notesPath || got.Modes[path] != 0600 || got.DirectoryModes[path] != 0700 {
							t.Fatal("source path or nonprivate snapshot reached native child")
						}
						if _, err := os.Stat(path); !os.IsNotExist(err) {
							t.Fatal("snapshot leaked")
						}
					}
					if data, err := os.ReadFile(notesPath); err != nil || string(data) != notes {
						t.Fatal("original notes changed")
					}
					if os.Getenv("GH_HOST") != "other.example" || os.Getenv("GH_REPO") != "other.example/wrong/repo" {
						t.Fatal("parent environment changed")
					}
				})
			}
		}
	}
}

func TestReleaseHostQualifiedRepoRejectsUnsafeInputs(t *testing.T) {
	rewriteTestServer(t, prReadPolicy("private-term"), nil)
	safe := releaseAssetFile(t, "safe.zip", []byte("synthetic opaque bytes"))
	for _, test := range []struct{ name, title, notes, asset string }{
		{"changed title", "private-term", "safe", safe},
		{"changed notes", "safe", "private-term", safe},
		{"changed asset", "safe", "safe", releaseAssetFile(t, "private-term.zip", []byte("synthetic"))},
		{"asset label", "safe", "safe", safe + "#label"},
		{"policy material", "safe", prReadPolicy("private-term"), ""},
		{"invalid title", "\xff", "safe", ""},
		{"invalid notes", "safe", "\xff", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			capture := captureRewriteGH(t)
			temporary := releaseAssetTemp(t)
			args := []string{"release", "create", "v1", "--repo=github.com/acme/repo", "--draft", "--verify-tag", "--title=" + test.title, "--notes=" + test.notes}
			if test.asset != "" {
				args = append(args, test.asset)
			}
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(""), io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("error=%v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unsafe child executed")
			}
			assertReleaseAssetTempEmpty(t, temporary)
		})
	}
}

func releaseAssetFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func releaseAssetTemp(t *testing.T) string {
	t.Helper()
	path := t.TempDir()
	t.Setenv("TMPDIR", path)
	t.Setenv("TMP", path)
	t.Setenv("TEMP", path)
	return path
}

func assertReleaseAssetTempEmpty(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("leaked preparation: %v %v", entries, err)
	}
}

func TestReleaseAssetsProcessRejectsUnsafeInputs(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	safe := releaseAssetFile(t, "safe.zip", []byte("opaque"))
	names := []string{"-", "https://example.com/asset.zip", "//server/share/a.zip", `\\server\share\a.zip`, `\\?\C:\a.zip`, `\\.\pipe\input`, "../a.zip", "a/../b.zip", "a/*", "a/[ab].zip", "a/{b,c}.zip", "a#label", "a\n.zip", "a\x00.zip", "a\xff.zip", "a:b.zip", "a ", "a.", "CON", "con.zip", "PRN.txt", "COM1.zip", "LPT².zip", "NUL", "CONIN$", "a\u202e.zip", strings.Repeat("a", 256)}
	cases := map[string][]string{
		"missing draft":      slices.Delete(slices.Clone(releaseAssetArgs(safe)), 4, 5),
		"false draft":        append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 4, 5), "--draft=false"),
		"missing verify":     slices.Delete(slices.Clone(releaseAssetArgs(safe)), 5, 6),
		"false verify":       append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 5, 6), "--verify-tag=false"),
		"conflicting draft":  append(releaseAssetArgs(safe), "-d=false"),
		"duplicate verify":   append(releaseAssetArgs(safe), "--verify-tag"),
		"unknown flag":       append(releaseAssetArgs(safe), "--target=main"),
		"label flag":         append(releaseAssetArgs(safe), "--clobber"),
		"changed title":      append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 6, 7), "--title=internal-model"),
		"changed notes":      append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 7, 8), "--notes=internal-model"),
		"blank title":        append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 6, 7), "--title= \t"),
		"blank notes":        append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 7, 8), "--notes= \n"),
		"invalid utf8 title": append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 6, 7), "--title=\xff"),
		"invalid utf8 notes": append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 7, 8), "--notes=\xff"),
		"policy material":    append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 7, 8), "--notes="+rewriteActiveTestPolicy),
		"notes conflict":     append(releaseAssetArgs(safe), "--notes-file=missing"),
		"missing title":      slices.Delete(slices.Clone(releaseAssetArgs(safe)), 6, 7),
		"missing notes":      slices.Delete(slices.Clone(releaseAssetArgs(safe)), 7, 8),
		"too much text":      append(slices.Delete(slices.Clone(releaseAssetArgs(safe)), 7, 8), "--notes="+strings.Repeat("x", rewriteMaxContent)),
		"duplicate source":   releaseAssetArgs(safe, safe),
		"duplicate basename": releaseAssetArgs(safe, releaseAssetFile(t, "safe.zip", []byte("different"))),
		"case collision":     releaseAssetArgs(safe, releaseAssetFile(t, "SAFE.ZIP", []byte("different"))),
		"fold collision":     releaseAssetArgs(releaseAssetFile(t, "k.zip", []byte("a")), releaseAssetFile(t, "K.zip", []byte("b"))),
		"missing file":       releaseAssetArgs(filepath.Join(t.TempDir(), "missing.zip")),
		"empty file":         releaseAssetArgs(releaseAssetFile(t, "empty.zip", nil)),
		"directory":          releaseAssetArgs(t.TempDir()),
		"changed source":     releaseAssetArgs(releaseAssetFile(t, "internal-model.zip", []byte("data"))),
	}
	for i, name := range names {
		cases[fmt.Sprintf("bad path %d", i)] = releaseAssetArgs(name)
	}
	tooMany := []string{}
	for i := 0; i < 17; i++ {
		tooMany = append(tooMany, safe)
	}
	cases["too many files"] = releaseAssetArgs(tooMany...)
	edit := releaseAssetArgs(safe)
	edit[1] = "edit"
	edit = slices.Delete(edit, 5, 6)
	cases["edit arity"] = edit
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			capture := captureRewriteGH(t)
			temporary := releaseAssetTemp(t)
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(""), io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("error=%v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("child executed")
			}
			assertReleaseAssetTempEmpty(t, temporary)
		})
	}
}

func TestReleaseAssetsLimitsAndIdentity(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	first := releaseAssetFile(t, "one.zip", []byte("1234"))
	second := releaseAssetFile(t, "two.zip", []byte("5678"))
	alias := filepath.Join(t.TempDir(), "alias.zip")
	if err := os.Link(first, alias); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		paths  []string
		limits rewriteReleaseLimits
		ok     bool
	}{
		{"at limits", []string{first, second}, rewriteReleaseLimits{2, 4, 8}, true},
		{"file limit", []string{first}, rewriteReleaseLimits{2, 3, 8}, false},
		{"total limit", []string{first, second}, rewriteReleaseLimits{2, 4, 7}, false},
		{"count limit", []string{first, second}, rewriteReleaseLimits{1, 4, 8}, false},
		{"hardlink", []string{first, alias}, defaultRewriteReleaseLimits, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			prepared := &rewritePreparation{}
			_, err := prepared.releaseAssets(policy, test.paths, test.limits)
			if (err == nil) != test.ok {
				t.Fatalf("error=%v", err)
			}
			if prepared.directory != "" {
				t.Fatal("inventory staged bytes")
			}
		})
	}
	if defaultRewriteReleaseLimits != (rewriteReleaseLimits{16, 1 << 30, 4 << 30}) || rewriteSnapshotBuffer != 65536 || rewriteMaxReleaseBasename != 255 || rewriteMaxContent != 1048576 {
		t.Fatal("resource contract changed")
	}
	if !validRewriteReleaseName(strings.Repeat("a", 255)) || validRewriteReleaseName(strings.Repeat("é", 128)) {
		t.Fatal("basename budget is not bytes")
	}
}

func TestReleaseAssetsPostStagingSourceChange(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capturePath := captureRewriteGH(t)
	source := releaseAssetFile(t, "frozen.zip", []byte{0, 0xff, 3, 4})
	temporary := releaseAssetTemp(t)
	// The child mutates the original after preparation, before reading argv files.
	t.Setenv("OCTOPOOL_TEST_REWRITE_MUTATE_FILE", source)
	if err := execRealGHWithStdin(t.Context(), releaseAssetArgs(source), strings.NewReader("ignored"), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	capture := readRewriteCapture(t, capturePath)
	if !rewriteCaptureHasData(capture, []byte{0, 0xff, 3, 4}) {
		t.Fatal("child did not receive the completed snapshot")
	}
	if data, err := os.ReadFile(source); err != nil || string(data) != "later source bytes" {
		t.Fatal("child did not mutate the original")
	}
	assertReleaseAssetTempEmpty(t, temporary)
}

func TestReleaseAssetsProcessFailureCleanup(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	source := releaseAssetFile(t, "safe.zip", []byte("data"))
	for _, kind := range []string{"child", "start", "canceled"} {
		t.Run(kind, func(t *testing.T) {
			capture := captureRewriteGH(t)
			invalidGH := releaseAssetFile(t, "invalid-gh", []byte("not an executable format"))
			if err := os.Chmod(invalidGH, 0700); err != nil {
				t.Fatal(err)
			}
			temporary := releaseAssetTemp(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if kind == "child" {
				t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "37")
			}
			if kind == "start" {
				t.Setenv("OCTOPOOL_GH_PATH", invalidGH)
			}
			if kind == "canceled" {
				cancel()
			}
			var stdout, stderr bytes.Buffer
			err := execRealGHWithStdin(ctx, releaseAssetArgs(source), strings.NewReader(""), &stdout, &stderr)
			if err == nil {
				t.Fatal("expected failure")
			}
			if kind == "child" {
				var exit exitCodeError
				if !errors.As(err, &exit) || exit.Code != 37 {
					t.Fatalf("exit=%v", err)
				}
				if stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
					t.Fatal("streams changed")
				}
				readRewriteCapture(t, capture)
			} else if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("child executed")
			}
			assertReleaseAssetTempEmpty(t, temporary)
		})
	}
}

type failingSnapshotOutput struct {
	bytes.Buffer
	failWrite, shortWrite, failClose bool
	closed                           bool
}

func (w *failingSnapshotOutput) Write(p []byte) (int, error) {
	if w.failWrite {
		return 0, io.ErrClosedPipe
	}
	if w.shortWrite {
		return len(p) - 1, nil
	}
	return w.Buffer.Write(p)
}
func (w *failingSnapshotOutput) Close() error {
	w.closed = true
	if w.failClose {
		return io.ErrClosedPipe
	}
	return nil
}

type releaseChunkReader struct {
	reader io.Reader
	after  func()
	calls  int
}

func (r *releaseChunkReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.calls++
	if r.calls == 1 && r.after != nil {
		r.after()
	}
	return n, err
}

func TestReleaseAssetsBoundedCopyFailures(t *testing.T) {
	for _, kind := range []string{"write", "short write", "close", "truncated", "grown", "canceled", "read"} {
		t.Run(kind, func(t *testing.T) {
			output := &failingSnapshotOutput{failWrite: kind == "write", shortWrite: kind == "short write", failClose: kind == "close"}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			data := bytes.Repeat([]byte("z"), rewriteSnapshotBuffer+8)
			expected := int64(len(data))
			if kind == "truncated" {
				expected++
			}
			if kind == "grown" {
				expected--
			}
			var input io.Reader = bytes.NewReader(data)
			if kind == "read" {
				input = errReleaseReader{}
			}
			if kind == "canceled" {
				input = &releaseChunkReader{reader: input, after: cancel}
			}
			_, err := copyRewriteSnapshot(ctx, output, input, expected, expected)
			if err == nil || !output.closed {
				t.Fatalf("error=%v closed=%v", err, output.closed)
			}
			if kind == "canceled" && output.Len() > rewriteSnapshotBuffer {
				t.Fatal("read continued after cancellation")
			}
		})
	}
}

type errReleaseReader struct{}

func (errReleaseReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestReleaseAssetsExistingPublicationCommands(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, test := range []struct {
		name string
		args []string
		body string
	}{
		{"asset verifier inputs", []string{"workflow", "run", "verify-assets.yml", "--repo=acme/toolkit", "--ref=main", "-f", "release_id=123", "-f", "tag=v1.2.3", "-f", "tag_object=" + sha, "-f", "tag_commit=" + sha, "-f", "verifier_commit=" + sha, "-f", "workflow_commit=" + sha, "-f", "draft=true"}, ""},
		{"package verifier inputs", []string{"workflow", "run", "verify-package.yml", "--repo=acme/toolkit", "--ref=main", "-f", "tag=v1.2.3", "-f", "tag_object=" + sha, "-f", "source_commit=" + sha, "-f", "verifier_commit=" + sha, "-f", "release_id=123", "-f", "public_verifier_run_id=456"}, ""},
		{"numeric publication patch", []string{"api", "repos/acme/toolkit/releases/123", "--method=PATCH", "--input=-"}, `{"draft":false}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			if err := execRealGHWithStdin(t.Context(), test.args, strings.NewReader(test.body), io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if test.body != "" {
				if len(capture.FileData) != 1 || !rewriteCaptureHasContent(capture, test.body) {
					t.Fatal("publication patch changed")
				}
				return
			}
			for i, arg := range test.args {
				if i > 0 && test.args[i-1] == "-f" && !slices.Contains(capture.Args, arg) {
					t.Fatalf("workflow input lost: %s in %v", arg, capture.Args)
				}
			}
		})
	}
}

func TestReleaseAssetsSnapshotWriteCloseAndCancellationCleanup(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	source := releaseAssetFile(t, "archive.zip", bytes.Repeat([]byte("x"), rewriteSnapshotBuffer+1))
	for _, kind := range []string{"write", "close", "canceled after copy", "exclusive create"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			prepared := &rewritePreparation{ctx: ctx}
			defer prepared.cleanup()
			assets, err := prepared.releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "exclusive create" {
				if _, _, err := prepared.snapshotReleaseAsset(assets[0], defaultRewriteReleaseLimits.file, copyRewriteSnapshot); err != nil {
					t.Fatal(err)
				}
			}
			copySnapshot := func(ctx context.Context, out io.WriteCloser, in io.Reader, expected, limit int64) (int64, error) {
				if kind == "write" || kind == "close" {
					out = &releaseFailingCloser{WriteCloser: out, failWrite: kind == "write", failClose: kind == "close"}
				}
				n, err := copyRewriteSnapshot(ctx, out, in, expected, limit)
				if kind == "canceled after copy" {
					cancel()
				}
				return n, err
			}
			if _, _, err := prepared.snapshotReleaseAsset(assets[0], defaultRewriteReleaseLimits.file, copySnapshot); err == nil {
				t.Fatal("failure accepted")
			}
			directory := prepared.directory
			prepared.cleanup()
			if _, err := os.Stat(directory); !os.IsNotExist(err) {
				t.Fatal("failed snapshot leaked")
			}
		})
	}
}

type releaseFailingCloser struct {
	io.WriteCloser
	failWrite, failClose bool
}

func (w *releaseFailingCloser) Write(p []byte) (int, error) {
	if w.failWrite {
		return 0, io.ErrClosedPipe
	}
	return w.WriteCloser.Write(p)
}
func (w *releaseFailingCloser) Close() error {
	err := w.WriteCloser.Close()
	if w.failClose {
		return io.ErrClosedPipe
	}
	return err
}

func TestReleaseAssetsProcessCancellationCleansStaging(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capturePath := captureRewriteGH(t)
	source := releaseAssetFile(t, "archive.zip", []byte("opaque"))
	temporary := releaseAssetTemp(t)
	t.Setenv("OCTOPOOL_TEST_REWRITE_WAIT", "1")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	output := &releaseCancelWriter{cancel: cancel}
	err := execRealGHWithStdin(ctx, releaseAssetArgs(source), strings.NewReader(""), output, io.Discard)
	if err == nil || !output.ready || ctx.Err() != context.Canceled {
		t.Fatalf("cancellation error=%v ready=%v context=%v", err, output.ready, ctx.Err())
	}
	capture := readRewriteCapture(t, capturePath)
	if len(capture.FileData) != 2 {
		t.Fatal("child ran before staging completed")
	}
	assertReleaseAssetTempEmpty(t, temporary)
}

type releaseCancelWriter struct {
	cancel context.CancelFunc
	ready  bool
	data   string
}

func (w *releaseCancelWriter) Write(p []byte) (int, error) {
	w.data += string(p)
	if strings.Contains(w.data, "child ready\n") {
		w.ready = true
		w.cancel()
	}
	return len(p), nil
}

func TestReleaseAssetsExactBasenameAndTextBudget(t *testing.T) {
	source := releaseAssetFile(t, "archive.zip", []byte("opaque"))
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "^archive[.]zip$", Replacement: "renamed.zip"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&rewritePreparation{}).releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits); err == nil {
		t.Fatal("basename-only policy match accepted")
	}
	policy, err = compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	prepared := &rewritePreparation{inputBytes: rewriteMaxContent - len(source), outputBytes: rewriteMaxContent - len(source)}
	if _, err := prepared.releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits); err == nil {
		t.Fatal("aggregate text metadata budget bypassed")
	}
}
