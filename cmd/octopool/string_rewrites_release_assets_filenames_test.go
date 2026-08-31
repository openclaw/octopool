package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseAssetsStagingProcessRejectsSpecialTempRoots(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	// Create the original before selecting a special temp root: only the generated
	// operand should contain native gh label/pattern syntax.
	source := releaseAssetFile(t, "asset.zip", []byte{0, 0xff, 1})
	if !validRewriteReleasePath(source) {
		t.Fatal("source fixture is not a literal release operand")
	}
	for _, name := range []string{"label#root", "glob[ab]", "glob{a,b}", "glob*", "glob?"} {
		t.Run(name, func(t *testing.T) {
			capture := captureRewriteGH(t)
			temporary := filepath.Join(t.TempDir(), name)
			if err := os.Mkdir(temporary, 0700); err != nil {
				t.Fatal(err)
			}
			for _, variable := range []string{"TMPDIR", "TMP", "TEMP"} {
				t.Setenv(variable, temporary)
			}
			if err := execRealGHWithStdin(t.Context(), releaseAssetArgs(source), strings.NewReader(""), io.Discard, io.Discard); err != errRewriteBlocked {
				t.Errorf("nonliteral generated operand was not blocked: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				got := readRewriteCapture(t, capture)
				path := got.Args[len(got.Args)-1]
				if path == source || !strings.Contains(path, name) || filepath.Base(path) != "asset.zip" {
					t.Fatalf("unexpected reproduction operand: %q", path)
				}
				t.Errorf("native child received unsafe generated release operand %q", path)
			}
			assertReleaseAssetTempEmpty(t, temporary)
		})
	}
}

func TestReleaseAssetsStagingProcessPreservesMetadata(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, name := range []string{"notes#staging", "notes[staging]"} {
		t.Run(name, func(t *testing.T) {
			for _, test := range []struct {
				name string
				args []string
			}{
				{"issue", []string{"issue", "create", "--repo=acme/repo", "--title=Safe", "--body=internal-model"}},
				{"assetless release", []string{"release", "create", "v1", "--repo=acme/repo", "--verify-tag", "--title=Safe", "--notes=internal-model"}},
			} {
				t.Run(test.name, func(t *testing.T) {
					capture := captureRewriteGH(t)
					temporary := filepath.Join(t.TempDir(), name)
					if err := os.Mkdir(temporary, 0700); err != nil {
						t.Fatal(err)
					}
					for _, variable := range []string{"TMPDIR", "TMP", "TEMP"} {
						t.Setenv(variable, temporary)
					}
					if err := execRealGHWithStdin(t.Context(), test.args, strings.NewReader(""), io.Discard, io.Discard); err != nil {
						t.Fatal(err)
					}
					got := readRewriteCapture(t, capture)
					if len(got.FileData) != 1 || !rewriteCaptureHasContent(got, "public") {
						t.Fatal("metadata snapshot changed")
					}
					for path := range got.FileData {
						if !strings.Contains(path, name) {
							t.Fatalf("special temp root not used: %q", path)
						}
					}
					assertReleaseAssetTempEmpty(t, temporary)
				})
			}
		})
	}
}

func TestReleaseAssetsStagingFilesystemSyntax(t *testing.T) {
	for _, test := range []struct {
		component           string
		filesystem, operand bool
	}{
		{"hash#root", true, false},
		{"glob[ab]", true, false},
		{"glob{a,b}", true, false},
		{"glob*", false, false},
		{"glob?", false, false},
		{".claude", true, true},
		{"space bearing", true, true},
		{"日本語", true, true},
		{"..", false, false},
		{"NUL", false, false},
		{"stream:dir", false, false},
		{"control\n", false, false},
	} {
		t.Run(test.component, func(t *testing.T) {
			path := "source/" + test.component + "/asset.zip"
			if got := validRewriteFilesystemPath(path); got != test.filesystem {
				t.Errorf("filesystem path=%v want=%v", got, test.filesystem)
			}
			if got := validRewriteReleasePath(path); got != test.operand {
				t.Errorf("release operand=%v want=%v", got, test.operand)
			}
		})
	}
	for _, path := range []string{`\\server\share\asset.zip`, `\\?\C:\asset.zip`, `\\.\pipe\input`} {
		if validRewriteFilesystemPath(path) || validRewriteReleasePath(path) {
			t.Errorf("unsafe filesystem namespace accepted: %q", path)
		}
	}
}

func TestReleaseAssetsFilenameProcessRejectsRenamedPublicNames(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, name := range []string{".asset.zip", "asset name.zip", "日本語.zip", "asset+build.zip", "asset@build.zip", "asset(1).zip"} {
		t.Run(name, func(t *testing.T) {
			capture := captureRewriteGH(t)
			source := releaseAssetFile(t, name, []byte{0, 0xff, 1})
			temporary := releaseAssetTemp(t)
			if err := execRealGHWithStdin(t.Context(), releaseAssetArgs(source), strings.NewReader(""), io.Discard, io.Discard); err != errRewriteBlocked {
				t.Errorf("existing unsupported public name was not blocked: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("native child executed for an unsupported public name")
			}
			assertReleaseAssetTempEmpty(t, temporary)
		})
	}
}

func releaseAssetFilenameSourceDirectory(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".claude", "release candidates + symbols", "日本語")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

// This filesystem proof runs natively on Windows too, without the shell harness.
func TestReleaseAssetsFilenameSourceDirectories(t *testing.T) {
	sourceDirectory := releaseAssetFilenameSourceDirectory(t)
	temporary := filepath.Join(t.TempDir(), ".private staging", "日本語")
	if err := os.MkdirAll(temporary, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(name, temporary)
	}
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	prepared := &rewritePreparation{ctx: t.Context()}
	defer prepared.cleanup()
	names := []string{"_asset-1.2.3.zip", "checksums.txt", "provenance.json"}
	paths := make([]string, len(names))
	payload := []byte{0, 0xff, 1, 2}
	for i, name := range names {
		paths[i] = filepath.Join(sourceDirectory, name)
		if err := os.WriteFile(paths[i], payload, 0600); err != nil {
			t.Fatal(err)
		}
	}
	assets, err := prepared.releaseAssets(policy, paths, defaultRewriteReleaseLimits)
	if err != nil {
		t.Fatal(err)
	}
	for i, asset := range assets {
		path, size, err := prepared.snapshotReleaseAsset(asset, defaultRewriteReleaseLimits.file, copyRewriteSnapshot)
		if err != nil || size != int64(len(payload)) || filepath.Base(path) != names[i] || !prepared.snapshots[path] {
			t.Fatalf("snapshot %d: path=%q size=%d error=%v", i, path, size, err)
		}
		if data, err := os.ReadFile(path); err != nil || !bytes.Equal(data, payload) {
			t.Fatalf("snapshot %d changed opaque bytes: %v", i, err)
		}
	}
	prepared.cleanup()
	assertReleaseAssetTempEmpty(t, temporary)
}

func TestReleaseAssetsFilenameValidation(t *testing.T) {
	for _, test := range []struct {
		name           string
		public, source bool
	}{
		{"asset-1.2_amd64.tar.gz", true, true},
		{"_asset.zip", true, true},
		{"_", true, true},
		{"asset_", true, true},
		{"asset-", true, true},
		{"asset..zip", true, true},
		{".asset.zip", false, true},
		{".claude", false, true},
		{"asset name.zip", false, true},
		{"日本語.zip", false, true},
		{"asset+build.zip", false, true},
		{"asset@build.zip", false, true},
		{"asset(1).zip", false, true},
		{"ARCHIV~1.ZIP", false, true},
		{"", false, false},
		{".", false, false},
		{"..", false, false},
		{"asset.zip.", false, false},
		{"asset.zip ", false, false},
		{"-asset.zip", false, true},
		{"CON.zip", false, false},
		{"nul", false, false},
		{"LPT1.zip", false, false},
		{"COM¹.zip", false, false},
		{"asset#label", false, false},
		{"asset:stream", false, false},
		{"asset*.zip", false, false},
		{"asset\n.zip", false, false},
		{"asset\xff.zip", false, false},
		{strings.Repeat("a", 255), true, true},
		{strings.Repeat("a", 256), false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := validRewriteReleaseName(test.name); got != test.public {
				t.Errorf("public-name validation=%v want=%v", got, test.public)
			}
			if got := validRewriteReleasePath("source/" + test.name); got != test.source {
				t.Errorf("source-path validation=%v want=%v", got, test.source)
			}
		})
	}
	for _, path := range []string{"source/../asset.zip", "source/./asset.zip", "source/CON/asset.zip", `\\server\share\asset.zip`, `\\?\C:\asset.zip`} {
		if validRewriteReleasePath(path) {
			t.Errorf("unsafe source path accepted: %q", path)
		}
	}
}
