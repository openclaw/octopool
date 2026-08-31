//go:build darwin || linux

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

type rewriteAssetChange struct{ seconds, nanos int64 }

func inspectRewriteReleaseAsset(path string) (string, os.FileInfo, rewriteAssetChange, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", nil, rewriteAssetChange{}, err
	}
	// Resolve parent aliases (including macOS /tmp), but never a symlink operand.
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return "", nil, rewriteAssetChange{}, err
	}
	resolved := filepath.Join(parent, filepath.Base(absolute))
	info, err := os.Lstat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, rewriteAssetChange{}, errRewriteBlocked
	}
	change, err := rewriteReleaseChange(nil, info)
	return resolved, info, change, err
}

func openRewriteReleaseAsset(path string) (*os.File, func(), error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	return file, func() { _ = file.Close() }, nil
}
