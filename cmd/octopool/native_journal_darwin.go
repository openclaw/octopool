package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func nativeJournalParents() (string, string) {
	parent, err := unix.SysctlKinfoProc("kern.proc.pid", os.Getppid())
	if err != nil {
		return "", ""
	}
	name := unix.ByteSliceToString(parent.Proc.P_comm[:])
	grandparent, err := unix.SysctlKinfoProc("kern.proc.pid", int(parent.Eproc.Ppid))
	if err != nil {
		return name, ""
	}
	return name, unix.ByteSliceToString(grandparent.Proc.P_comm[:])
}
