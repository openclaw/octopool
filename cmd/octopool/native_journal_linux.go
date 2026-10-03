package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func nativeJournalParents() (string, string) {
	parent, ppid := nativeJournalProcess(os.Getppid())
	grandparent, _ := nativeJournalProcess(ppid)
	return parent, grandparent
}

func nativeJournalProcess(pid int) (string, int) {
	if pid <= 0 {
		return "", 0
	}
	directory := "/proc/" + strconv.Itoa(pid)
	name := ""
	if executable, err := os.Readlink(directory + "/exe"); err == nil {
		name = filepath.Base(executable)
	}
	data, err := os.ReadFile(directory + "/stat")
	if err != nil {
		return name, 0
	}
	// comm is parenthesized and can itself contain spaces and parentheses.
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return name, 0
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 2 {
		return name, 0
	}
	ppid, _ := strconv.Atoi(fields[1])
	return name, ppid
}
