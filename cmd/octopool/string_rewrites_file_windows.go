package main

import "os"

func openRewriteSnapshot(path string) (*os.File, error) { return os.Open(path) }
