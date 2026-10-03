//go:build !darwin

package main

import "os"

func platformRelaySlotTempDirectory() string {
	return os.TempDir()
}
