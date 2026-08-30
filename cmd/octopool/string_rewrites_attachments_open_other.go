//go:build !aix && !android && !darwin && !dragonfly && !freebsd && !illumos && !ios && !linux && !netbsd && !openbsd && !solaris && !windows

package main

import "os"

func openRewriteAttachment(path string) (*os.File, error) {
	return os.Open(path)
}
