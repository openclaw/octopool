//go:build windows

package main

import "os"

func openRewriteAttachment(path string) (*os.File, error) {
	return os.Open(path)
}
