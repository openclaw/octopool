// A portable dispatch recorder, not an implementation of gh help or extensions.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "fixture:", err)
		os.Exit(90)
	}
}

func main() {
	capture := struct {
		Args           []string
		Stdin          string
		Files          map[string]string
		Modes          map[string]uint32
		DirectoryModes map[string]uint32
		Env            map[string]string
	}{
		Args: os.Args[1:], Files: map[string]string{}, Modes: map[string]uint32{},
		DirectoryModes: map[string]uint32{},
		Env:            map[string]string{"GH_HOST": os.Getenv("GH_HOST"), "GH_REPO": os.Getenv("GH_REPO")},
	}
	// Pure dispatch recording deliberately leaves stdin untouched. Operational
	// tests explicitly request observation of the prepared input and snapshots.
	if os.Getenv("OCTOPOOL_TEST_HELP_INPUT") == "1" {
		data, err := io.ReadAll(os.Stdin)
		must(err)
		capture.Stdin = string(data)
		for _, arg := range capture.Args {
			path, ok := strings.CutPrefix(arg, "--input=")
			if !ok {
				path, ok = strings.CutPrefix(arg, "--body-file=")
			}
			if !ok || path == "-" {
				continue
			}
			data, err := os.ReadFile(path)
			must(err)
			info, err := os.Stat(path)
			must(err)
			dir, err := os.Stat(filepath.Dir(path))
			must(err)
			capture.Files[path] = string(data)
			capture.Modes[path] = uint32(info.Mode().Perm())
			capture.DirectoryModes[path] = uint32(dir.Mode().Perm())
		}
	}
	file, err := os.OpenFile(os.Getenv("OCTOPOOL_TEST_HELP_CAPTURE"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	must(err)
	must(json.NewEncoder(file).Encode(capture))
	must(file.Close())
	fmt.Fprintln(os.Stdout, "synthetic child stdout")
	fmt.Fprintln(os.Stderr, "synthetic child stderr")
	exit, err := strconv.Atoi(os.Getenv("OCTOPOOL_TEST_HELP_EXIT"))
	must(err)
	os.Exit(exit)
}
