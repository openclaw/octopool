package main

import (
	"os"
	"syscall"
)

func rewriteReleaseChange(_ *os.File, info os.FileInfo) (rewriteAssetChange, error) {
	if info == nil {
		return rewriteAssetChange{}, errRewriteBlocked
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return rewriteAssetChange{}, errRewriteBlocked
	}
	return rewriteAssetChange{stat.Ctimespec.Sec, stat.Ctimespec.Nsec}, nil
}
