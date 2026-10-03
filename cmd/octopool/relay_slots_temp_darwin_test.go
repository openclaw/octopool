package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDarwinRelaySlotTempResolution(t *testing.T) {
	for _, mode := range []string{"canonical", "override", "error", "empty", "relative", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			temp := t.TempDir()
			canonical := "/var/folders/aa/synthetic-user/T/"
			if mode == "canonical" {
				temp = canonical
			}
			t.Setenv("TMPDIR", temp)
			calls := 0
			resolve := newDarwinRelaySlotTempDirectory(func(ctx context.Context) ([]byte, error) {
				calls++
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > time.Second {
					t.Fatal("lookup must have a short deadline")
				}
				switch mode {
				case "canonical":
					t.Fatal("canonical TMPDIR spawned a lookup")
				case "error":
					return []byte(canonical), os.ErrPermission
				case "empty":
					return []byte("\n"), nil
				case "relative":
					return []byte("relative/path\n"), nil
				case "timeout":
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return []byte(canonical + "\n"), nil
			})
			want := temp
			if mode == "override" {
				want = filepath.Clean(canonical)
			}
			for range 2 {
				if got := resolve(); got != want {
					t.Fatalf("directory=%q, want %q", got, want)
				}
			}
			wantCalls := 1
			if mode == "canonical" {
				wantCalls = 0
			}
			if calls != wantCalls {
				t.Fatalf("lookups=%d, want %d", calls, wantCalls)
			}
		})
	}
}

func TestDarwinRelaySlotDirectoryProcess(t *testing.T) {
	if os.Getenv("OCTOPOOL_TEST_DARWIN_SLOT_DIRECTORY") != "1" {
		return
	}
	directory, err := fallbackRelaySlotDirectory()
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(directory)
}

func TestDarwinRelaySlotCanonicalDirectory(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/bin/getconf", "DARWIN_USER_TEMP_DIR").Output()
	if err != nil {
		t.Fatal(err)
	}
	canonical := strings.TrimSpace(string(output))
	want := filepath.Join(canonical, "octopool-relay-slots-"+strconv.Itoa(os.Getuid()))
	t.Setenv("TMPDIR", t.TempDir())
	if got, err := fallbackRelaySlotDirectory(); err != nil || got != want {
		t.Fatalf("directory=%q err=%v, want %q", got, err, want)
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, temp := range []string{canonical, "/tmp/x"} {
		cmd := exec.CommandContext(t.Context(), executable, "-test.run=^TestDarwinRelaySlotDirectoryProcess$", "-test.timeout=5s")
		cmd.Env = append(os.Environ(), "TMPDIR="+temp, "OCTOPOOL_TEST_DARWIN_SLOT_DIRECTORY=1")
		output, err := cmd.CombinedOutput()
		got := strings.SplitN(string(output), "\n", 2)[0]
		if err != nil || got != want {
			t.Fatalf("TMPDIR=%q: err=%v output=%q, want %q", temp, err, output, want)
		}
		t.Logf("TMPDIR=%s -> %s", temp, got)
	}
}
