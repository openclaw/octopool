//go:build !windows

package main

import "os"

func newRewritePrivateDirectory() (string, func(), error) {
	path, err := os.MkdirTemp("", "octopool-content-")
	return path, nil, err
}
