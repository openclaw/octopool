//go:build !windows

package main

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func openNativeJournalFile(path string, flags int) (*os.File, error) {
	file, err := os.OpenFile(path, flags|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ok || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
			err = os.ErrPermission
		}
	}
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
