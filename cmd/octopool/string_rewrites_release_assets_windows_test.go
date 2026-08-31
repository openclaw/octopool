package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Clean the destination after deferred handle closure even if a pinning assertion
// unexpectedly moves the tree away from the preparation's cleanup path.
func rewriteWindowsRenameDestination(t *testing.T, path string) string {
	t.Helper()
	moved := path + "-moved"
	if _, err := os.Lstat(moved); !os.IsNotExist(err) {
		t.Fatalf("rename destination already exists or cannot be checked: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(moved); err != nil {
			t.Errorf("remove rename destination: %v", err)
		}
	})
	return moved
}

func TestReleaseAssetsWindowsPinsDirectoryAncestors(t *testing.T) {
	for _, target := range []string{"staging", "parent", "ancestor"} {
		t.Run(target, func(t *testing.T) {
			ancestor := filepath.Join(t.TempDir(), "ancestor")
			parent := filepath.Join(ancestor, "parent")
			if err := os.MkdirAll(parent, 0700); err != nil {
				t.Fatal(err)
			}
			for _, variable := range []string{"TMPDIR", "TMP", "TEMP"} {
				t.Setenv(variable, parent)
			}
			prepared := &rewritePreparation{ctx: t.Context()}
			defer prepared.cleanup()
			snapshot, err := prepared.snapshot([]byte("snapshot"))
			if err != nil {
				t.Fatal(err)
			}
			path := prepared.directory
			if target == "parent" {
				path = parent
			} else if target == "ancestor" {
				path = ancestor
			}
			moved := rewriteWindowsRenameDestination(t, path)
			if err := os.Rename(path, moved); err == nil {
				t.Fatalf("%s directory was not pinned", target)
			}
			if target == "staging" {
				// Exercise the owned release callback without deleting the directory
				// so its name can be renamed after the handles are closed.
				prepared.closeDirectory()
				prepared.closeDirectory = nil
			} else {
				prepared.cleanup()
				if _, err := os.Stat(prepared.directory); !os.IsNotExist(err) {
					t.Fatalf("private directory leaked after cleanup: %v", err)
				}
			}
			if err := os.Rename(path, moved); err != nil {
				t.Fatalf("%s remained pinned after handle release: %v", target, err)
			}
			if err := os.Rename(moved, path); err != nil {
				t.Fatalf("restore %s after rename: %v", target, err)
			}
			if target == "staging" {
				if data, err := os.ReadFile(snapshot); err != nil || string(data) != "snapshot" {
					t.Fatalf("snapshot changed after rename: %q, %v", data, err)
				}
			}
			prepared.cleanup()
			assertReleaseAssetTempEmpty(t, parent)
		})
	}
}

func TestReleaseAssetsWindowsMetadataStagingSpecialTemp(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	source := releaseAssetFile(t, "asset.zip", []byte("opaque"))
	media := releaseAssetFile(t, "source.png", []byte{0, 0xff, 1})
	link := filepath.Join(t.TempDir(), "source-link.png")
	if err := os.Symlink(media, link); err != nil {
		t.Fatalf("native attachment symlink proof requires symlink support: %v", err)
	}
	for _, name := range []string{"notes#staging", "notes[staging]"} {
		t.Run(name, func(t *testing.T) {
			temporary := filepath.Join(t.TempDir(), name)
			if err := os.Mkdir(temporary, 0700); err != nil {
				t.Fatal(err)
			}
			for _, variable := range []string{"TMPDIR", "TMP", "TEMP"} {
				t.Setenv(variable, temporary)
			}
			for _, test := range []struct {
				name    string
				args    []string
				blocked bool
			}{
				{"issue metadata", []string{"issue", "create", "--repo=acme/repo", "--title=Safe", "--body=private-term"}, false},
				{"assetless release", []string{"release", "create", "v1", "--repo=acme/repo", "--verify-tag", "--title=Safe", "--notes=private-term"}, false},
				{"attachment symlink", []string{"pr", "comment", "1", "--repo=acme/repo", "--body=private-term", "--attach", link}, false},
				{"release asset", releaseAssetArgs(source), true},
			} {
				t.Run(test.name, func(t *testing.T) {
					prepared := &rewritePreparation{ctx: t.Context()}
					defer prepared.cleanup()
					err := prepareRewriteContent(policy, test.args, strings.NewReader(""), prepared)
					if test.blocked {
						if err != errRewriteBlocked {
							t.Fatalf("nonliteral asset operand error=%v", err)
						}
					} else {
						if err != nil {
							t.Fatal(err)
						}
						found := false
						for _, arg := range prepared.args {
							for _, prefix := range []string{"--body-file=", "--notes-file="} {
								if path, ok := strings.CutPrefix(arg, prefix); ok {
									data, err := os.ReadFile(path)
									if err != nil || string(data) != "public" || !strings.Contains(path, name) {
										t.Fatalf("metadata snapshot=%q error=%v", data, err)
									}
									found = true
								}
							}
						}
						if !found {
							t.Fatal("metadata snapshot missing")
						}
						if test.name == "attachment symlink" {
							path := capturedAttachmentSnapshot(prepared.args, ".png")
							data, err := os.ReadFile(path)
							if err != nil || !bytes.Equal(data, []byte{0, 0xff, 1}) {
								t.Fatal("attachment source symlink contract changed", err)
							}
						}
					}
					// Shared filesystem staging must work even when the release
					// operand boundary subsequently rejects its generated path.
					if prepared.directory == "" {
						t.Fatal("filesystem staging was blocked")
					}
					dir, closeDir, err := openRewriteWindowsPath(prepared.directory, true)
					if err != nil {
						t.Fatal(err)
					}
					err = checkRewritePrivateWindowsDirectory(dir, user.User.Sid)
					closeDir()
					if err != nil {
						t.Fatal(err)
					}
					moved := rewriteWindowsRenameDestination(t, prepared.directory)
					if err := os.Rename(prepared.directory, moved); err == nil {
						t.Fatal("staging directory was not pinned")
					}
					prepared.cleanup()
					assertReleaseAssetTempEmpty(t, temporary)
				})
			}
		})
	}
}

func TestReleaseAssetsWindowsPrivateStaging(t *testing.T) {
	prepared := &rewritePreparation{}
	if err := prepared.ensureSnapshotDirectory(); err != nil {
		t.Fatal(err)
	}
	defer prepared.cleanup()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	dir, closeDir, err := openRewriteWindowsPath(prepared.directory, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkRewritePrivateWindowsDirectory(dir, user.User.Sid); err != nil {
		closeDir()
		t.Fatal(err)
	}
	closeDir()
	moved := rewriteWindowsRenameDestination(t, prepared.directory)
	if err := os.Rename(prepared.directory, moved); err == nil {
		t.Fatal("private staging directory was not pinned")
	}
	source := releaseAssetFile(t, "archive.zip", []byte{0, 0xff, 0xfe, 3})
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	assets, err := prepared.releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits)
	if err != nil {
		t.Fatal(err)
	}
	path, _, err := prepared.snapshotReleaseAsset(assets[0], defaultRewriteReleaseLimits.file, copyRewriteSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, []byte{0, 0xff, 0xfe, 3}) {
		t.Fatal("snapshot bytes", err)
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.READ_CONTROL, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	_ = windows.CloseHandle(handle)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		t.Fatal("file did not inherit private ACL", err)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		t.Fatal(err)
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || !windows.EqualSid((*windows.SID)(unsafe.Pointer(&ace.SidStart)), user.User.Sid) {
		t.Fatal("file ACL grants another principal")
	}
	directory := prepared.directory
	prepared.cleanup()
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("private directory leaked", err)
	}
}

func TestReleaseAssetsWindowsRejectsReparseAndLocksSource(t *testing.T) {
	source := releaseAssetFile(t, "archive.zip", []byte("opaque"))
	link := filepath.Join(t.TempDir(), "link.zip")
	if err := os.Symlink(source, link); err != nil {
		t.Fatalf("native reparse proof requires symlink support: %v", err)
	}
	if file, closeFile, err := openRewriteReleaseAsset(link); err == nil {
		closeFile()
		t.Fatalf("followed reparse operand %v", file)
	}
	parentLink := filepath.Join(t.TempDir(), "parent")
	if err := os.Symlink(filepath.Dir(source), parentLink); err != nil {
		t.Fatal(err)
	}
	if _, closeFile, err := openRewriteReleaseAsset(filepath.Join(parentLink, filepath.Base(source))); err == nil {
		closeFile()
		t.Fatal("followed reparse ancestor")
	}
	file, closeFile, err := openRewriteReleaseAsset(source)
	if err != nil {
		t.Fatal(err)
	}
	if writer, err := os.OpenFile(source, os.O_WRONLY, 0); err == nil {
		writer.Close()
		closeFile()
		t.Fatal("source allowed writing while captured")
	}
	if err := os.Rename(source, source+".old"); err == nil {
		closeFile()
		t.Fatal("source allowed replacement while captured")
	}
	info, err := file.Stat()
	if err != nil {
		closeFile()
		t.Fatal(err)
	}
	before, err := rewriteReleaseChange(file, info)
	if err != nil {
		closeFile()
		t.Fatal(err)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		closeFile()
		t.Fatal(err)
	}
	after, err := rewriteReleaseChange(file, info)
	closeFile()
	if err != nil || before != after || string(data) != "opaque" {
		t.Fatal("read changed mutation stamp", err)
	}
	writer, err := os.OpenFile(source, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, closeFile, err := openRewriteReleaseAsset(source); err == nil {
		closeFile()
		writer.Close()
		t.Fatal("accepted preexisting write handle")
	}
	writer.Close()
}

func TestReleaseAssetsWindowsRejectsAliasesAndReplacements(t *testing.T) {
	for _, path := range []string{`\\server\share\a.zip`, `\\?\C:\a.zip`, `\\.\pipe\a`, `C:a.zip`, `C:\a.zip:stream`, `C:\NUL.zip`, `C:\dir\..\a.zip`, `C:\dir\a.zip.`, `C:\dir\a.zip `} {
		if validRewriteReleasePath(path) {
			t.Fatalf("unsafe Windows path accepted: %q", path)
		}
	}
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	source := releaseAssetFile(t, "archive.zip", []byte("opaque"))
	prepared := &rewritePreparation{}
	defer prepared.cleanup()
	assets, err := prepared.releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(source, source+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("opaque"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepared.snapshotReleaseAsset(assets[0], defaultRewriteReleaseLimits.file, copyRewriteSnapshot); err == nil {
		t.Fatal("replacement accepted")
	}
	if prepared.directory != "" {
		t.Fatal("replaced input created staging")
	}
}

func TestReleaseAssetsWindowsChecksResolvedCaseAlias(t *testing.T) {
	source := releaseAssetFile(t, "ArchiveMixed.zip", []byte("opaque"))
	alias := filepath.Join(filepath.Dir(source), "archivemixed.zip")
	resolved, info, _, err := inspectRewriteReleaseAsset(alias)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.Stat(source)
	if err != nil || !os.SameFile(info, original) || filepath.Base(resolved) != "ArchiveMixed.zip" {
		t.Fatalf("canonical alias path=%q error=%v", resolved, err)
	}
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "ArchiveMixed", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&rewritePreparation{}).releaseAssets(policy, []string{alias}, defaultRewriteReleaseLimits); err == nil {
		t.Fatal("resolved path policy match was hidden by case alias")
	}
}
