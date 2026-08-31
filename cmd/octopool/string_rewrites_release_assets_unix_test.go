//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestReleaseAssetsUnixReplacementAndMutation(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"replacement before open", "symlink before open", "fifo before open", "replacement during copy", "truncate", "growth", "in-place", "restored mtime", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			data := bytes.Repeat([]byte{0, 0xff, 'a', 'b'}, rewriteSnapshotBuffer)
			source := releaseAssetFile(t, "original.zip", data)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			prepared := &rewritePreparation{ctx: ctx}
			defer prepared.cleanup()
			assets, err := prepared.releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits)
			if err != nil {
				t.Fatal(err)
			}
			before := assets[0].info
			replace := func() {
				t.Helper()
				if err := os.Rename(source, source+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(source, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "replacement before open":
				replace()
			case "symlink before open", "fifo before open":
				if err := os.Remove(source); err != nil {
					t.Fatal(err)
				}
				if kind == "symlink before open" {
					if err := os.Symlink(releaseAssetFile(t, "other.zip", data), source); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := syscall.Mkfifo(source, 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			copySnapshot := func(ctx context.Context, out io.WriteCloser, in io.Reader, expected, limit int64) (int64, error) {
				reader := &releaseChunkReader{reader: in, after: func() {
					switch kind {
					case "replacement during copy":
						replace()
					case "truncate":
						if err := os.Truncate(source, int64(len(data)/2)); err != nil {
							t.Fatal(err)
						}
					case "growth":
						if err := os.Truncate(source, int64(len(data)+1)); err != nil {
							t.Fatal(err)
						}
					case "in-place", "restored mtime":
						f, err := os.OpenFile(source, os.O_WRONLY, 0)
						if err != nil {
							t.Fatal(err)
						}
						_, writeErr := f.WriteAt([]byte("changed"), rewriteSnapshotBuffer+10)
						closeErr := f.Close()
						if writeErr != nil || closeErr != nil {
							t.Fatal(writeErr, closeErr)
						}
						mod := time.Unix(123456789, 0)
						if kind == "restored mtime" {
							mod = before.ModTime()
						}
						if err := os.Chtimes(source, mod, mod); err != nil {
							t.Fatal(err)
						}
					case "cancel":
						cancel()
					}
				}}
				return copyRewriteSnapshot(ctx, out, reader, expected, limit)
			}
			// Timeout is a deadlock assertion, not race synchronization. The mutation
			// happens synchronously at the first completed copy-buffer read.
			done := make(chan error, 1)
			go func() {
				_, _, err := prepared.snapshotReleaseAsset(assets[0], defaultRewriteReleaseLimits.file, copySnapshot)
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("mutation accepted")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("nonfollowing open/copy hung")
			}
			directory := prepared.directory
			prepared.cleanup()
			if directory != "" {
				if _, err := os.Stat(directory); !os.IsNotExist(err) {
					t.Fatal("partial snapshot leaked")
				}
			}
		})
	}
}

func TestReleaseAssetsUnixAliasesAndPermissions(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	source := releaseAssetFile(t, "archive.zip", []byte("opaque"))
	alias := filepath.Join(t.TempDir(), "alias.zip")
	if err := os.Symlink(source, alias); err != nil {
		t.Fatal(err)
	}
	prepared := &rewritePreparation{}
	if _, err := prepared.releaseAssets(policy, []string{alias}, defaultRewriteReleaseLimits); err == nil {
		t.Fatal("symlink operand accepted")
	}
	parent := filepath.Join(t.TempDir(), "parent")
	if err := os.Symlink(filepath.Dir(source), parent); err != nil {
		t.Fatal(err)
	}
	assets, err := prepared.releaseAssets(policy, []string{filepath.Join(parent, filepath.Base(source))}, defaultRewriteReleaseLimits)
	if err != nil {
		t.Fatal("parent alias rejected", err)
	}
	defer prepared.cleanup()
	if _, _, err := prepared.snapshotReleaseAsset(assets[0], defaultRewriteReleaseLimits.file, copyRewriteSnapshot); err != nil {
		t.Fatal(err)
	}
	forbiddenDir := filepath.Join(t.TempDir(), "private-term")
	if err := os.Mkdir(forbiddenDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(forbiddenDir, "archive.zip"), []byte("opaque"), 0600); err != nil {
		t.Fatal(err)
	}
	hidden := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(forbiddenDir, hidden); err != nil {
		t.Fatal(err)
	}
	if _, err := (&rewritePreparation{}).releaseAssets(policy, []string{filepath.Join(hidden, "archive.zip")}, defaultRewriteReleaseLimits); err == nil {
		t.Fatal("resolved policy match accepted")
	}
	if os.Geteuid() == 0 {
		t.Skip("permission denial requires a non-root user; alias checks completed")
	}
	if err := os.Chmod(source, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(source, 0600) })
	// The inventory may stat it; the protected descriptor open must fail.
	unreadable, err := (&rewritePreparation{}).releaseAssets(policy, []string{source}, defaultRewriteReleaseLimits)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepared.snapshotReleaseAsset(unreadable[0], defaultRewriteReleaseLimits.file, copyRewriteSnapshot); err == nil {
		t.Fatal("unreadable file accepted")
	}
}

func TestReleaseAssetsUnixSparseLimitsAndPartialPreparation(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "private-term", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	sparse := releaseAssetFile(t, "large.zip", []byte("x"))
	if err := os.Truncate(sparse, defaultRewriteReleaseLimits.file+1); err != nil {
		t.Fatal(err)
	}
	if _, err := (&rewritePreparation{}).releaseAssets(policy, []string{sparse}, defaultRewriteReleaseLimits); err == nil {
		t.Fatal("oversized sparse file accepted")
	}
	first := releaseAssetFile(t, "first.zip", []byte("1234"))
	second := releaseAssetFile(t, "second.zip", []byte("5678"))
	prepared := &rewritePreparation{}
	defer prepared.cleanup()
	assets, err := prepared.releaseAssets(policy, []string{first, second}, defaultRewriteReleaseLimits)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepared.snapshotReleaseAsset(assets[0], 4, copyRewriteSnapshot); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(second, 2); err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepared.snapshotReleaseAsset(assets[1], 4, copyRewriteSnapshot); err == nil {
		t.Fatal("partial preparation succeeded")
	}
	directory := prepared.directory
	prepared.cleanup()
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("first snapshot leaked")
	}
}
