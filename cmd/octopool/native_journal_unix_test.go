//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestNativeJournalSandboxStorage(t *testing.T) {
	for _, mode := range []string{"cache unwritable", "both unwritable", "insecure temp", "symlink temp", "symlink file", "fifo file"} {
		t.Run(mode, func(t *testing.T) {
			isolateTestConfig(t)
			isolateRelaySlotTemp(t)
			path := journalTestPath(t)
			primary := filepath.Dir(path)
			if err := os.MkdirAll(primary, 0700); err != nil {
				t.Fatal(err)
			}
			fallback, err := fallbackRelaySlotDirectory()
			if err != nil {
				t.Fatal(err)
			}
			if mode == "symlink file" {
				target := filepath.Join(t.TempDir(), "unrelated")
				if err := os.WriteFile(target, []byte("sentinel"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if data, _ := os.ReadFile(target); string(data) != "sentinel" {
						t.Error("journal followed symlink")
					}
				})
			} else if mode == "fifo file" {
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Chmod(primary, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(primary, 0700) })
				if probe, err := os.Create(filepath.Join(primary, "probe")); err == nil {
					probe.Close()
					t.Skip("current user bypasses directory permissions")
				}
			}
			switch mode {
			case "both unwritable", "insecure temp":
				permissions := os.FileMode(0500)
				if mode == "insecure temp" {
					permissions = 0755
				}
				if err := os.Chmod(fallback, permissions); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(fallback, 0700) })
			case "symlink temp":
				if err := os.Remove(fallback); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(t.TempDir(), fallback); err != nil {
					t.Fatal(err)
				}
			}
			start := time.Now()
			journalNativeDelegation(t.Context(), []string{"api", "user", "--include"}, nil, "")
			if time.Since(start) > time.Second {
				t.Fatal("journal blocked command on unusable storage")
			}
			data, _ := os.ReadFile(filepath.Join(fallback, nativeJournalName))
			wantRecord := mode == "cache unwritable" || mode == "symlink file" || mode == "fifo file"
			if strings.Contains(string(data), "gh api GET /user") != wantRecord {
				t.Fatalf("unexpected fallback journal: %q", data)
			}
		})
	}
}

func TestNativeJournalLockContention(t *testing.T) {
	directory := t.TempDir()
	lock, err := openNativeJournalFile(filepath.Join(directory, nativeJournalName+".lock"), os.O_CREATE|os.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if locked, err := tryLockRelaySlot(lock); err != nil || !locked {
		t.Fatalf("lock: %t %v", locked, err)
	}
	path := filepath.Join(directory, nativeJournalName)
	if err := os.WriteFile(path, []byte(strings.Repeat("x", nativeJournalLimit+1)), 0600); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := appendNativeJournal(directory, []byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("journal waited for a held lock")
	}
	if data, err := os.ReadFile(path); err != nil || !strings.HasSuffix(string(data), "{}\n") {
		t.Fatal("rotation contention dropped the append")
	}
}
