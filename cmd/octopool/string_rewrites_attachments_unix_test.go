//go:build darwin || linux

package main

import (
	"io"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestStringRewriteAttachmentFIFOIsNonblocking(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	fifo := filepath.Join(t.TempDir(), "pipe.png")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	captureRewriteGH(t)
	done := make(chan error, 1)
	go func() {
		args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "safe", "--attach", fifo}
		done <- execRealGH(t.Context(), args, io.Discard, io.Discard)
	}()
	select {
	case err := <-done:
		if err != errRewriteBlocked {
			t.Fatalf("FIFO error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("FIFO attachment blocked during open")
	}
}
