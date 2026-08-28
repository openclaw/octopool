//go:build !windows

package main

import (
	"os"
	"syscall"
)

func openRewriteSnapshot(path string) (*os.File, error) {
	// A concurrently replaced FIFO must not stall before File.Stat rejects it.
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
