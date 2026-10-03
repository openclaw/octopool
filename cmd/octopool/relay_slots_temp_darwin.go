package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var platformRelaySlotTempDirectory = newDarwinRelaySlotTempDirectory(func(ctx context.Context) ([]byte, error) {
	return exec.CommandContext(ctx, "/usr/bin/getconf", "DARWIN_USER_TEMP_DIR").Output()
})

func newDarwinRelaySlotTempDirectory(lookup func(context.Context) ([]byte, error)) func() string {
	return sync.OnceValue(func() string {
		temp := os.TempDir()
		if canonical, _ := filepath.Match("/var/folders/*/*/T", filepath.Clean(temp)); canonical {
			return temp
		}
		// Gateways can override TMPDIR; use the same per-user pool as sandboxed
		// callers without requiring cgo or spawning getconf on every acquisition.
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		output, err := lookup(ctx)
		directory := strings.TrimSpace(string(output))
		if err == nil && filepath.IsAbs(directory) {
			return filepath.Clean(directory)
		}
		return temp
	})
}
