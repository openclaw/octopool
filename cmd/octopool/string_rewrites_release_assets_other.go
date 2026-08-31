//go:build !darwin && !linux && !windows

package main

import "os"

type rewriteAssetChange struct{}

// Asset snapshots are modeled only on the platforms in the release matrix.
func inspectRewriteReleaseAsset(string) (string, os.FileInfo, rewriteAssetChange, error) {
	return "", nil, rewriteAssetChange{}, errRewriteBlocked
}

func openRewriteReleaseAsset(string) (*os.File, func(), error) {
	return nil, nil, errRewriteBlocked
}

func rewriteReleaseChange(*os.File, os.FileInfo) (rewriteAssetChange, error) {
	return rewriteAssetChange{}, errRewriteBlocked
}
