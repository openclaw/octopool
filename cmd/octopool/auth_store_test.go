package main

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSaveAuthReplacesFileAtomically(t *testing.T) {
	isolateTestConfig(t)
	path, err := authPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := saveAuth(authFile{URL: "https://octopool.example", Token: "first-token", Client: "first"}); err != nil {
		t.Fatal(err)
	}
	var held *os.File
	if runtime.GOOS != "windows" {
		// A reader that opened the old file must keep seeing complete old
		// content: replacement is a rename, never an in-place truncate.
		held, err = os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer held.Close()
	}
	if err := saveAuth(authFile{URL: "https://octopool.example", Token: "second-token", Client: "second"}); err != nil {
		t.Fatal(err)
	}
	auth, err := loadAuth()
	if err != nil {
		t.Fatal(err)
	}
	if auth.Token != "second-token" || auth.Client != "second" {
		t.Fatalf("saved auth = %+v", auth)
	}
	if held != nil {
		old, err := io.ReadAll(held)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(old), "first-token") {
			t.Fatalf("held reader saw %q, want the complete previous file", old)
		}
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("auth mode = %o, want 600", mode)
		}
	}
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".auth-*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("temporary auth files left behind: %v", leftovers)
	}
}
