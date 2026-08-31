// This synthetic child captures prepared inputs without invoking gh or a network.
package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	capture := struct {
		Args           []string
		Stdin          string
		Files          map[string]string
		Modes          map[string]uint32
		DirectoryModes map[string]uint32
		Env            map[string]string
		Include        bool
		Silent         bool
		Help           bool
		Headers        []string
		Fields         []string
		RawFields      []string
	}{Args: os.Args[1:], Files: map[string]string{}, Modes: map[string]uint32{}, DirectoryModes: map[string]uint32{}, Env: map[string]string{"GH_HOST": os.Getenv("GH_HOST"), "GH_REPO": os.Getenv("GH_REPO")}}
	// Independent synthetic target semantics, checked against native gh loopback
	// and stdin-offset controls. Do not import the protection descriptor here.
	var paths []string
	values := map[string]bool{"repo": true, "ref": true, "field": true, "raw-field": true, "header": true, "method": true, "jq": true, "template": true, "cache": true, "preview": true, "hostname": true, "input": true}
	short := map[byte]string{'R': "repo", 'r': "ref", 'F': "field", 'f': "raw-field", 'H': "header", 'X': "method", 'q': "jq", 't': "template", 'p': "preview", 'i': "include"}
	set := func(name, value string) {
		switch name {
		case "include", "silent", "help":
			v, err := strconv.ParseBool(value)
			if err != nil {
				panic(err)
			}
			switch name {
			case "include":
				capture.Include = v
			case "silent":
				capture.Silent = v
			case "help":
				capture.Help = v
			}
		case "input":
			paths = append(paths, value)
		case "field":
			capture.Fields = append(capture.Fields, value)
			_, source, _ := strings.Cut(value, "=")
			if strings.HasPrefix(source, "@") {
				paths = append(paths, source[1:])
			}
		case "raw-field":
			capture.RawFields = append(capture.RawFields, value)
		case "header":
			capture.Headers = append(capture.Headers, value)
		}
	}
parse:
	for i := 0; i < len(capture.Args); i++ {
		arg := capture.Args[i]
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "--") {
			name, value, equal := strings.Cut(arg[2:], "=")
			if values[name] && !equal {
				i++
				if i >= len(capture.Args) {
					panic("missing fixture value")
				}
				value = capture.Args[i]
			}
			if (name == "help" || name == "include" || name == "silent") && !equal {
				value = "true"
			}
			set(name, value)
		} else if strings.HasPrefix(arg, "-") && len(arg) > 1 {
			for tail := arg[1:]; len(tail) > 0; {
				letter := tail[0]
				tail = tail[1:]
				// Native gh inherits a long help flag without an h alias. Pflag
				// handles unregistered h by immediately returning ErrHelp.
				if letter == 'h' {
					capture.Help = true
					break parse
				}
				name, known := short[letter]
				if !known {
					os.Exit(2)
				}
				value := "true"
				if len(tail) > 1 && tail[0] == '=' {
					value = tail[1:]
					tail = ""
				} else if values[name] {
					if tail != "" {
						value = tail
						tail = ""
					} else {
						i++
						if i >= len(capture.Args) {
							panic("missing fixture value")
						}
						value = capture.Args[i]
					}
				}
				set(name, value)
			}
		}
	}
	if !capture.Help {
		input, err := io.ReadAll(os.Stdin)
		if err != nil {
			panic(err)
		}
		capture.Stdin = string(input)
		if path := os.Getenv("OCTOPOOL_TEST_DECLARED_MUTATE"); path != "" {
			if err := os.WriteFile(path, []byte("later source bytes"), 0600); err != nil {
				panic(err)
			}
		}
		for _, path := range paths {
			if path == "-" {
				capture.Files[path] = capture.Stdin
				continue
			}
			data, err := os.ReadFile(path)
			if err != nil {
				panic(err)
			}
			capture.Files[path] = string(data)
			info, err := os.Stat(path)
			if err != nil {
				panic(err)
			}
			capture.Modes[path] = uint32(info.Mode().Perm())
			info, err = os.Stat(filepath.Dir(path))
			if err != nil {
				panic(err)
			}
			capture.DirectoryModes[path] = uint32(info.Mode().Perm())
		}
	}
	data, err := json.Marshal(capture)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(os.Getenv("OCTOPOOL_TEST_DECLARED_CAPTURE"), data, 0600); err != nil {
		panic(err)
	}
	_, _ = io.WriteString(os.Stdout, "child stdout\n")
	_, _ = io.WriteString(os.Stderr, "child stderr\n")
	code, _ := strconv.Atoi(os.Getenv("OCTOPOOL_TEST_DECLARED_EXIT"))
	os.Exit(code)
}
