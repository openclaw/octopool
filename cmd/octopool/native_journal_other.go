//go:build !darwin && !linux

package main

func nativeJournalParents() (string, string) { return "", "" }
