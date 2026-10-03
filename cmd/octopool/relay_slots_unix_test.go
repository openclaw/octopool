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
	for _, mode := range []string{"normal", "primary unwritable", "both unwritable", "insecure temp", "symlink temp"} {
		t.Run(mode, func(t *testing.T) {
			isolateTestConfig(t)
			temp := isolateRelaySlotTemp(t)
			cache, err := os.UserCacheDir()
			if err != nil {
				t.Fatal(err)
			}
			primary := filepath.Join(temp, "octopool-relay-slots-"+strconv.Itoa(os.Getuid()))
			fallback := filepath.Join(cache, "octopool", "relay-slots")
			if err := os.MkdirAll(fallback, 0700); err != nil {
				t.Fatal(err)
			}
			if mode == "symlink temp" {
				if err := os.Symlink(t.TempDir(), primary); err != nil {
					t.Fatal(err)
				}
			} else if mode != "normal" {
				if err := os.Mkdir(primary, 0700); err != nil {
					t.Fatal(err)
				}
				permissions := os.FileMode(0500)
				if mode == "insecure temp" {
					permissions = 0755
				}
				if err := os.Chmod(primary, permissions); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(primary, 0700) })
				if permissions == 0500 {
					if probe, err := os.Create(filepath.Join(primary, "probe")); err == nil {
						probe.Close()
						t.Skip("current user bypasses directory permissions")
					}
				}
			}
			if mode == "both unwritable" {
				if err := os.Chmod(fallback, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(fallback, 0700) })
			}
			file := acquireRelaySlot(t.Context(), 1, time.Second)
			if mode == "both unwritable" {
				if file != nil {
					file.Close()
					t.Fatal("unusable directories should fail open")
				}
				return
			}
			if file == nil {
				t.Fatal("did not acquire slot")
			}
			defer file.Close()
			want := fallback
			if mode == "normal" {
				want = primary
				info, err := os.Lstat(primary)
				if err != nil || info.Mode().Perm() != 0700 {
					t.Fatalf("temp directory not private: %v %v", info, err)
				}
			}
			if filepath.Dir(file.Name()) != want {
				t.Fatalf("slot = %q, want directory %q", file.Name(), want)
			}
			if mode == "insecure temp" || mode == "symlink temp" {
				info, err := os.Lstat(primary)
				if err != nil {
					t.Fatal(err)
				}
				if mode == "insecure temp" && info.Mode().Perm() != 0755 || mode == "symlink temp" && info.Mode()&os.ModeSymlink == 0 {
					t.Fatalf("insecure temp directory was changed: %v", info.Mode())
				}
			}
		})
	}
}
