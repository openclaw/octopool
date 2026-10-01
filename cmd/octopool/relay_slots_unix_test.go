//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestRelaySlotUnwritableDirectories(t *testing.T) {
	for _, mode := range []string{"primary unwritable", "both unwritable", "insecure temp", "symlink temp"} {
		t.Run(mode, func(t *testing.T) {
			isolateTestConfig(t)
			temp := isolateRelaySlotTemp(t)
			cache, err := os.UserCacheDir()
			if err != nil {
				t.Fatal(err)
			}
			primary := filepath.Join(cache, "octopool", "relay-slots")
			fallback := filepath.Join(temp, "octopool-relay-slots-"+strconv.Itoa(os.Getuid()))
			if err := os.MkdirAll(primary, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(primary, 0500); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(primary, 0700) })
			if probe, err := os.Create(filepath.Join(primary, "probe")); err == nil {
				probe.Close()
				t.Skip("current user bypasses directory permissions")
			}
			if mode == "symlink temp" {
				if err := os.Symlink(t.TempDir(), fallback); err != nil {
					t.Fatal(err)
				}
			} else if mode != "primary unwritable" {
				if err := os.Mkdir(fallback, 0700); err != nil {
					t.Fatal(err)
				}
				permissions := os.FileMode(0500)
				if mode == "insecure temp" {
					permissions = 0755
				}
				if err := os.Chmod(fallback, permissions); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(fallback, 0700) })
			}
			file := acquireRelaySlot(t.Context(), 1, time.Second)
			if mode != "primary unwritable" {
				if file != nil {
					file.Close()
					t.Fatal("unusable fallback should fail open")
				}
				return
			}
			if file == nil {
				t.Fatal("did not use writable temp directory")
			}
			defer file.Close()
			if filepath.Dir(file.Name()) != fallback {
				t.Fatalf("slot = %q, want directory %q", file.Name(), fallback)
			}
			info, err := os.Lstat(fallback)
			if err != nil || info.Mode().Perm() != 0700 {
				t.Fatalf("fallback not private: %v %v", info, err)
			}
		})
	}
}
