package main

import (
	"errors"
	"os"
)

func openNativeJournalFile(path string, flags int) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil && !info.Mode().IsRegular() {
		return nil, os.ErrPermission
	}
	return os.OpenFile(path, flags, 0600)
}
