package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type rewriteCapture struct {
	Args           []string
	Stdin          string
	Files          map[string]string
	FileData       map[string][]byte
	Modes          map[string]uint32
	DirectoryModes map[string]uint32
	Env            map[string]string
}

func TestRewriteCaptureProcess(t *testing.T) {
	capturePath := os.Getenv("OCTOPOOL_TEST_REWRITE_CAPTURE")
	if capturePath == "" {
		return
	}
	args := os.Args
	for i, arg := range args {
		if arg == "--" {
			args = args[i+1:]
			break
		}
	}
	capture := rewriteCapture{Args: args, Files: map[string]string{}, FileData: map[string][]byte{}, Modes: map[string]uint32{}, DirectoryModes: map[string]uint32{}, Env: map[string]string{"GH_HOST": os.Getenv("GH_HOST"), "GH_REPO": os.Getenv("GH_REPO")}}
	input, _ := io.ReadAll(os.Stdin)
	capture.Stdin = string(input)
	if path := os.Getenv("OCTOPOOL_TEST_REWRITE_MUTATE_FILE"); path != "" {
		if err := os.WriteFile(path, []byte("later source bytes"), 0600); err != nil {
			os.Exit(83)
		}
	}
	for index, arg := range args {
		paths := []string{}
		if len(args) > 2 && args[0] == "release" && args[1] == "create" && index > 2 && !strings.HasPrefix(arg, "-") {
			paths = append(paths, arg)
		}
		for _, prefix := range []string{"--body-file=", "--notes-file=", "--input=", "--attach="} {
			if path, ok := strings.CutPrefix(arg, prefix); ok {
				if prefix == "--attach=" {
					path = captureRewriteAttachmentPath(path)
				}
				paths = append(paths, path)
			}
		}
		if field, ok := strings.CutPrefix(arg, "--field="); ok {
			_, value, exists := strings.Cut(field, "=")
			if exists && strings.HasPrefix(value, "@") && value != "@-" {
				paths = append(paths, strings.TrimPrefix(value, "@"))
			}
		}
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if err != nil {
				os.Exit(80)
			}
			capture.Files[path] = string(data)
			capture.FileData[path] = data
			info, _ := os.Stat(path)
			capture.Modes[path] = uint32(info.Mode().Perm())
			dir, _ := os.Stat(filepath.Dir(path))
			capture.DirectoryModes[path] = uint32(dir.Mode().Perm())
		}
	}
	data, _ := json.Marshal(capture)
	if err := os.WriteFile(capturePath, data, 0600); err != nil {
		os.Exit(81)
	}
	if path := os.Getenv("OCTOPOOL_TEST_REWRITE_CALLS"); path != "" {
		file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			os.Exit(84)
		}
		_, err = file.WriteString("child\n")
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			os.Exit(84)
		}
	}
	if os.Getenv("OCTOPOOL_TEST_REWRITE_WAIT") == "1" {
		interrupt := make(chan os.Signal, 1)
		signal.Notify(interrupt, os.Interrupt)
		_, _ = io.WriteString(os.Stdout, "child ready\n")
		<-interrupt
		os.Exit(82)
	}
	_, _ = io.WriteString(os.Stdout, "child stdout\n")
	_, _ = io.WriteString(os.Stderr, "child stderr\n")
	exit, _ := strconv.Atoi(os.Getenv("OCTOPOOL_TEST_REWRITE_EXIT"))
	os.Exit(exit)
}

func captureRewriteAttachmentPath(value string) string {
	if _, err := os.Stat(value); err == nil {
		return value
	}
	for index := strings.LastIndex(value, "#"); index > 0; index = strings.LastIndex(value[:index], "#") {
		if _, err := os.Stat(value[:index]); err == nil {
			return value[:index]
		}
	}
	return value
}

func capturedAttachmentSnapshot(args []string, extension string) string {
	for _, arg := range args {
		spec, ok := strings.CutPrefix(arg, "--attach=")
		if !ok {
			continue
		}
		marker := strings.ToLower(extension) + "#"
		if index := strings.Index(strings.ToLower(spec), marker); index >= 0 {
			return spec[:index+len(extension)]
		}
		if strings.HasSuffix(strings.ToLower(spec), strings.ToLower(extension)) {
			return spec
		}
	}
	return ""
}

func captureRewriteGH(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell process fixture")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fake-gh")
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(executable, "'", "'\\''") + "' -test.run=^TestRewriteCaptureProcess$ -- \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(t.TempDir(), "capture.json")
	t.Setenv("OCTOPOOL_GH_PATH", path)
	t.Setenv("OCTOPOOL_TEST_REWRITE_CAPTURE", capture)
	return capture
}
func readRewriteCapture(t *testing.T, path string) rewriteCapture {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var capture rewriteCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		t.Fatal(err)
	}
	return capture
}

func rewriteCaptureHasContent(capture rewriteCapture, want string) bool {
	for _, content := range capture.Files {
		if content == want {
			return true
		}
	}
	return false
}

func rewriteCaptureHasData(capture rewriteCapture, want []byte) bool {
	for _, data := range capture.FileData {
		if bytes.Equal(data, want) {
			return true
		}
	}
	return false
}

func rewriteTestServer(t *testing.T, policyBody string, relay http.HandlerFunc) (*atomic.Value, *atomic.Int64) {
	t.Helper()
	body := &atomic.Value{}
	body.Store(policyBody)
	calls := rewriteTestServerPolicySequence(t, func(int64) (string, int) {
		return body.Load().(string), http.StatusOK
	}, relay)
	return body, calls
}

func rewriteTestServerPolicySequence(t *testing.T, policy func(int64) (string, int), relay http.HandlerFunc) *atomic.Int64 {
	t.Helper()
	calls := &atomic.Int64{}
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("incorrect caller auth")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/pools/maintainers/string-rewrites" {
			body, code := policy(calls.Add(1))
			if r.Method != "GET" || r.Header.Get("Cache-Control") != "no-cache, no-store" {
				t.Error("incorrect policy method/cache")
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_, _ = io.WriteString(w, body)
			return
		}
		if r.URL.Path != "/v1/github/request" || r.Method != "POST" || relay == nil {
			t.Error("unexpected relay dispatch")
			w.WriteHeader(400)
			return
		}
		relay(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv("OCTOPOOL_URL", server.URL)
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	t.Setenv("OCTOPOOL_POOL", "maintainers")
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
	return calls
}

const rewriteActiveTestPolicy = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"internal-model","replacement":"public"}]}`
const rewriteEmptyTestPolicy = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[]}`

func TestStringRewriteProcessSnapshots(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct {
		name  string
		args  []string
		stdin string
		file  bool
		want  string
	}{
		{"issue inline", []string{"issue", "create", "-tinternal-model", "-binternal-model", "-Racme/repo"}, "unused", false, "public"},
		{"issue create metadata", []string{"issue", "create", "--title=safe", "--body-file=FILE", "--label=bug", "--assignee=steipete", "--repo=acme/repo"}, "unused", true, "public 🦞"},
		{"issue body file", []string{"issue", "edit", "1", "--body-file=FILE", "--repo=acme/repo"}, "unused", true, "public 🦞"},
		{"pr body stdin", []string{"pr", "comment", "1", "-F-", "-Racme/repo"}, "internal-model 🦞", false, "public 🦞"},
		{"review", []string{"pr", "review", "1", "--approve", "--body=internal-model", "-Racme/repo"}, "", false, "public"},
		{"release", []string{"release", "create", "v1", "--verify-tag", "--title=internal-model", "--notes-file=FILE", "-Racme/repo"}, "", true, "public 🦞"},
		{"pr create", []string{"pr", "create", "-tinternal-model", "-binternal-model", "-Hfeature", "-Bmain", "-Racme/repo"}, "", false, "public"},
		{"raw typed file", []string{"api", "repos/acme/repo/issues/1/comments", "-Fbody=@FILE"}, "", true, `{"body":"public 🦞"}`},
		{"raw typed stdin", []string{"api", "repos/acme/repo/issues/1/comments", "-Fbody=@-"}, "internal-model 🦞", false, `{"body":"public 🦞"}`},
		{"raw literal at", []string{"api", "repos/acme/repo/issues/1/comments", "-fbody=@internal-model"}, "", false, `{"body":"@public"}`},
		{"raw literal type", []string{"api", "repos/acme/repo/issues/1/comments", "-fbody=false"}, "", false, `{"body":"false"}`},
		{"raw JSON", []string{"api", "repos/acme/repo/pulls/1/reviews", "--input=-"}, `{"body":"\u0069nternal-model","event":"COMMENT","comments":[{"path":"safe.go","line":1,"body":"internal-model \ud83e\udd9e"}]}`, false, `{"body":"public","comments":[{"body":"public 🦞","line":1,"path":"safe.go"}],"event":"COMMENT"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			file := filepath.Join(t.TempDir(), "original.txt")
			original := []byte("internal-model 🦞")
			if test.file {
				if err := os.WriteFile(file, original, 0644); err != nil {
					t.Fatal(err)
				}
			}
			args := append([]string(nil), test.args...)
			for i, arg := range args {
				args[i] = strings.ReplaceAll(arg, "FILE", file)
			}
			var out, stderr bytes.Buffer
			err := execRealGHWithStdinAndEnv(t.Context(), args, strings.NewReader(test.stdin), &out, &stderr, os.Environ())
			if err != nil {
				t.Fatal(err)
			}
			if out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
				t.Fatalf("streams: %q %q", out.String(), stderr.String())
			}
			capture := readRewriteCapture(t, capturePath)
			if test.name == "issue create metadata" && (!slices.Contains(capture.Args, "--label=bug") || !slices.Contains(capture.Args, "--assignee=steipete")) {
				t.Fatalf("issue metadata was not preserved: %v", capture.Args)
			}
			if capture.Stdin != "" {
				t.Fatal("child retained live stdin")
			}
			if len(capture.Files) != 1 {
				t.Fatalf("files=%v", capture.Files)
			}
			for path, content := range capture.Files {
				if content != test.want {
					t.Fatalf("snapshot=%q want=%q", content, test.want)
				}
				if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
					t.Fatal("snapshot permissions are not private")
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("snapshot leaked")
				}
				if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
					t.Fatal("temporary directory leaked")
				}
			}
			for _, arg := range capture.Args {
				if strings.Contains(arg, "internal-model") || strings.Contains(arg, file) {
					t.Fatalf("unsanitized argv %q", arg)
				}
			}
			if test.file {
				data, err := os.ReadFile(file)
				if err != nil || !bytes.Equal(data, original) {
					t.Fatal("original file changed")
				}
			}
		})
	}
}

func TestStringRewriteAttachments(t *testing.T) {
	for _, resource := range []string{"pr", "issue"} {
		t.Run(resource, func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			directory := t.TempDir()
			body := filepath.Join(directory, "body.md")
			image := filepath.Join(directory, "image#one.png")
			video := filepath.Join(directory, "clip.mp4")
			imageData := []byte{0x89, 'P', 'N', 'G', 0x00, 0xff}
			videoData := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 0xff}
			for path, data := range map[string][]byte{body: []byte("internal-model"), image: imageData, video: videoData} {
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			capturePath := captureRewriteGH(t)
			args := []string{resource, "comment", "1", "--repo", "acme/repo", "--body-file", body, "--attach", image + "#internal-model screenshot", "--attach=" + video}
			if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if capture.Stdin != "" || len(capture.FileData) != 3 {
				t.Fatalf("attachment capture=%+v", capture)
			}
			seenBody, seenImage, seenVideo := false, false, false
			for path, data := range capture.FileData {
				switch {
				case string(data) == "public":
					seenBody = true
				case bytes.Equal(data, imageData):
					seenImage = strings.HasSuffix(path, ".png")
				case bytes.Equal(data, videoData):
					seenVideo = strings.HasSuffix(path, ".mp4")
				default:
					t.Fatalf("unexpected snapshot bytes %x", data)
				}
				if runtime.GOOS != "windows" && (capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700) {
					t.Fatal("attachment snapshot permissions are not private")
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("attachment snapshot leaked")
				}
			}
			if !seenBody || !seenImage || !seenVideo {
				t.Fatalf("missing snapshots body=%v image=%v video=%v", seenBody, seenImage, seenVideo)
			}
			if slices.ContainsFunc(capture.Args, func(arg string) bool {
				return arg == body || strings.Contains(arg, image) || strings.Contains(arg, video) || strings.Contains(arg, "internal-model")
			}) {
				t.Fatalf("original path/text reached child: %v", capture.Args)
			}
			if !slices.ContainsFunc(capture.Args, func(arg string) bool {
				return strings.HasPrefix(arg, "--attach=") && strings.HasSuffix(arg, ".png#public screenshot")
			}) {
				t.Fatalf("rewritten attachment alt missing: %v", capture.Args)
			}
			for path, expected := range map[string][]byte{body: []byte("internal-model"), image: imageData, video: videoData} {
				data, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(data, expected) {
					t.Fatalf("original attachment changed: %s", path)
				}
			}

			alias := filepath.Join(directory, "alias.png")
			if err := os.Symlink(image, alias); err != nil {
				t.Fatal(err)
			}
			aliasCapturePath := captureRewriteGH(t)
			aliasArgs := []string{resource, "comment", "1", "--repo", "acme/repo", "--body", "safe", "--attach", alias}
			if err := execRealGH(t.Context(), aliasArgs, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			aliasCapture := readRewriteCapture(t, aliasCapturePath)
			if !rewriteCaptureHasData(aliasCapture, imageData) || slices.ContainsFunc(aliasCapture.Args, func(arg string) bool { return strings.Contains(arg, alias) }) {
				t.Fatalf("symlink attachment was not privately snapshotted: %+v", aliasCapture)
			}

			createCapturePath := captureRewriteGH(t)
			createArgs := []string{resource, "create", "--repo", "acme/repo", "--title", "safe", "--body", "safe", "--attach", image}
			if resource == "pr" {
				createArgs = append(createArgs, "--head", "feature", "--base", "main")
			}
			if err := execRealGH(t.Context(), createArgs, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			createCapture := readRewriteCapture(t, createCapturePath)
			if !slices.ContainsFunc(createCapture.Args, func(arg string) bool {
				return strings.HasPrefix(arg, "--attach=") && strings.HasSuffix(arg, ".png#image#one")
			}) {
				t.Fatalf("default attachment alt missing: %v", createCapture.Args)
			}

			attachmentOnlyCapturePath := captureRewriteGH(t)
			attachmentOnlyArgs := []string{resource, "comment", "1", "--repo", "acme/repo", "--attach", image}
			if err := execRealGH(t.Context(), attachmentOnlyArgs, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			attachmentOnlyCapture := readRewriteCapture(t, attachmentOnlyCapturePath)
			if len(attachmentOnlyCapture.FileData) != 1 || !slices.ContainsFunc(attachmentOnlyCapture.Args, func(arg string) bool {
				return strings.HasPrefix(arg, "--attach=")
			}) {
				t.Fatalf("attachment-only comment changed shape: %+v", attachmentOnlyCapture)
			}

			editCapturePath := captureRewriteGH(t)
			editArgs := []string{resource, "comment", "1", "--repo", "acme/repo", "--edit-last", "--body", "safe", "--attach", image}
			if err := execRealGH(t.Context(), editArgs, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			editCapture := readRewriteCapture(t, editCapturePath)
			if len(editCapture.FileData) != 2 || !rewriteCaptureHasContent(editCapture, "safe") {
				t.Fatalf("explicit edit-last body changed shape: %+v", editCapture)
			}

			codeCapturePath := captureRewriteGH(t)
			codeBody := "`![example](" + image + ")`"
			codeArgs := []string{resource, "comment", "1", "--repo", "acme/repo", "--body", codeBody, "--attach", image}
			if err := execRealGH(t.Context(), codeArgs, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			codeCapture := readRewriteCapture(t, codeCapturePath)
			if len(codeCapture.FileData) != 2 || !rewriteCaptureHasContent(codeCapture, codeBody) {
				t.Fatalf("code attachment reference was not preserved: %+v", codeCapture)
			}

			workingDirectory, err := os.Getwd()
			if err != nil {
				t.Fatal(err)
			}
			relativeImage, err := filepath.Rel(workingDirectory, image)
			if err != nil {
				t.Fatal(err)
			}
			for _, reference := range []string{image, strings.ReplaceAll(image, "#", "%23"), relativeImage} {
				capturePath := captureRewriteGH(t)
				referenceBody := "![safe](" + reference + ")"
				args := []string{resource, "comment", "1", "--repo", "acme/repo", "--body", referenceBody, "--attach", image}
				if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
					t.Fatal(err)
				}
				capture := readRewriteCapture(t, capturePath)
				snapshot := capturedAttachmentSnapshot(capture.Args, ".png")
				if snapshot == "" {
					t.Fatalf("attachment snapshot missing: %v", capture.Args)
				}
				rewritten := false
				for path, content := range capture.Files {
					if path != snapshot && strings.Contains(content, "![safe]") {
						rewritten = strings.Contains(content, snapshot) && !strings.Contains(content, reference)
					}
				}
				if !rewritten {
					t.Fatalf("inline attachment reference was not rewritten: %+v", capture)
				}
			}

			for _, complexBody := range []string{
				"![<span title=\"](" + image + ")\">x</span>](" + image + ")",
				"[![thumb](https://example.com/thumb.png \" ](" + image + ")\")](" + image + ")",
			} {
				capturePath := captureRewriteGH(t)
				args := []string{resource, "comment", "1", "--repo", "acme/repo", "--body", complexBody, "--attach", image}
				if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
					t.Fatal(err)
				}
				capture := readRewriteCapture(t, capturePath)
				snapshot := capturedAttachmentSnapshot(capture.Args, ".png")
				found := false
				for path, content := range capture.Files {
					if path == snapshot {
						continue
					}
					_, states := rewriteAttachmentLinkStates([]byte(content))
					for _, state := range states {
						found = found || state.destination == snapshot
					}
				}
				if !found {
					t.Fatalf("complex inline destination was not structurally rewritten: %+v", capture)
				}
			}

			literalBodyCapturePath := captureRewriteGH(t)
			literalBody := "--attach=" + image
			literalBodyArgs := []string{resource, "comment", "1", "--repo", "acme/repo", "--body", literalBody}
			if err := execRealGH(t.Context(), literalBodyArgs, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			literalBodyCapture := readRewriteCapture(t, literalBodyCapturePath)
			if len(literalBodyCapture.FileData) != 1 || !rewriteCaptureHasContent(literalBodyCapture, literalBody) || slices.ContainsFunc(literalBodyCapture.Args, func(arg string) bool {
				return strings.HasPrefix(arg, "--attach=")
			}) {
				t.Fatalf("flag value was reinterpreted as an attachment: %+v", literalBodyCapture)
			}
		})
	}
}

func TestStringRewriteIssueAttachments(t *testing.T) {
	for _, action := range []string{"create", "edit", "comment"} {
		t.Run(action, func(t *testing.T) {
			_, policyCalls := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			for _, test := range []struct {
				name     string
				text     string
				multiple bool
				exitCode int
				mutate   bool
			}{
				{"reported shape", "safe", false, 0, false},
				{"rewritten repeated attachments", "internal-model", true, 0, false},
				{"child nonzero exit", "internal-model", true, 7, false},
				{"source mutation after preparation", "internal-model", true, 0, true},
			} {
				t.Run(test.name, func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", strconv.Itoa(test.exitCode))
					directory := t.TempDir()
					body := filepath.Join(directory, "body.md")
					image := filepath.Join(directory, "image.png")
					video := filepath.Join(directory, "clip.mp4")
					content := test.text + " literal \\u0000\n![" + test.text + "](" + image + " \"" + test.text + "\")"
					if test.multiple {
						content += "\n[" + test.text + "](" + video + ")"
					}
					originals := map[string][]byte{
						body:  []byte(content),
						image: {0x89, 'P', 'N', 'G', 0x00, 0xff},
						video: {0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 0xff},
					}
					for path, data := range originals {
						if err := os.WriteFile(path, data, 0600); err != nil {
							t.Fatal(err)
						}
					}
					alt := "alt"
					if test.multiple {
						alt = test.text + " screenshot"
					}
					args := []string{"issue", action}
					if action != "create" {
						args = append(args, "1")
					}
					args = append(args, "--repo", "acme/repo")
					wantPrefix := append([]string(nil), args[:len(args)-2]...)
					wantPrefix = append(wantPrefix, "--repo=acme/repo")
					if action != "comment" {
						args = append(args, "--title", test.text)
						wantPrefix = append(wantPrefix, "--title="+strings.ReplaceAll(test.text, "internal-model", "public"))
					}
					args = append(args, "--body-file", body)
					var metadata []string
					switch action {
					case "create":
						metadata = []string{"--label=bug", "--assignee=steipete"}
					case "edit":
						metadata = []string{"--add-label=bug", "--add-assignee=steipete"}
					}
					args = append(args, metadata...)
					args = append(args, "--attach", image+"#"+alt)
					if test.multiple {
						args = append(args, "--attach="+video)
					}
					if test.mutate {
						t.Setenv("OCTOPOOL_TEST_REWRITE_MUTATE_FILE", image)
					}
					var stdout, stderr bytes.Buffer
					before := policyCalls.Load()
					err := runGH(t.Context(), args, &stdout, &stderr)
					if policyCalls.Load() <= before {
						t.Fatal("native dispatch did not fetch fresh policy")
					}
					if test.exitCode == 0 {
						if err != nil {
							t.Fatal(err)
						}
					} else {
						var exitErr exitCodeError
						if !errors.As(err, &exitErr) || exitErr.Code != test.exitCode {
							t.Fatalf("child exit: got %v, want %d", err, test.exitCode)
						}
					}
					if stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
						t.Fatalf("child streams: %q %q", stdout.String(), stderr.String())
					}
					capture := readRewriteCapture(t, capturePath)
					imageSnapshot := capturedAttachmentSnapshot(capture.Args, ".png")
					bodySnapshot := ""
					for _, arg := range capture.Args {
						if path, ok := strings.CutPrefix(arg, "--body-file="); ok {
							bodySnapshot = path
						}
					}
					wantArgs := append(wantPrefix, "--body-file="+bodySnapshot)
					wantArgs = append(wantArgs, metadata...)
					wantArgs = append(wantArgs, "--attach="+imageSnapshot+"#"+strings.ReplaceAll(alt, "internal-model", "public"))
					wantBody := strings.ReplaceAll(strings.ReplaceAll(content, "internal-model", "public"), image, imageSnapshot)
					wantFiles := map[string][]byte{imageSnapshot: originals[image]}
					if test.multiple {
						videoSnapshot := capturedAttachmentSnapshot(capture.Args, ".mp4")
						wantArgs = append(wantArgs, "--attach="+videoSnapshot)
						wantBody = strings.ReplaceAll(wantBody, video, videoSnapshot)
						wantFiles[videoSnapshot] = originals[video]
					}
					wantFiles[bodySnapshot] = []byte(wantBody)
					if !slices.Equal(capture.Args, wantArgs) || capture.Stdin != "" || len(capture.FileData) != len(wantFiles) {
						t.Fatalf("issue capture=%+v, want argv=%v", capture, wantArgs)
					}
					for path, want := range wantFiles {
						if path == "" || originals[path] != nil || !bytes.Equal(capture.FileData[path], want) {
							t.Fatalf("snapshot %q: got %q, want %q", path, capture.FileData[path], want)
						}
						if runtime.GOOS != "windows" && (capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700) {
							t.Fatal("snapshot permissions are not private")
						}
						for _, removed := range []string{path, filepath.Dir(path)} {
							if _, err := os.Stat(removed); !os.IsNotExist(err) {
								t.Fatalf("snapshot cleanup failed for %s: %v", removed, err)
							}
						}
					}
					for path, want := range originals {
						if test.mutate && path == image {
							want = []byte("later source bytes")
						}
						if data, err := os.ReadFile(path); err != nil || !bytes.Equal(data, want) {
							t.Fatalf("original file changed: %s", path)
						}
					}
				})
			}
		})
	}
}

func TestStringRewriteIssueCreateAttachmentBlocks(t *testing.T) {
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	directory := t.TempDir()
	image := filepath.Join(directory, "image.png")
	protected := filepath.Join(directory, "internal-model.png")
	unsupported := filepath.Join(directory, "artifact.txt")
	for _, path := range []string{image, protected, unsupported} {
		if err := os.WriteFile(path, []byte("synthetic attachment"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	material := `{"pattern":"internal-model","replacement":"synthetic"}`
	emptyPolicy := strings.Replace(rewriteActiveTestPolicy, `"public"`, `""`, 1)
	residualPolicy := strings.Replace(rewriteActiveTestPolicy, `"public"`, `"internal-model"`, 1)
	for _, test := range []struct {
		name   string
		flag   string
		value  string
		policy string
	}{
		{"protected path", "--attach", protected + "#alt", ""},
		{"unsupported type", "--attach", unsupported, ""},
		{"protected repo", "--repo", "acme/internal-model", ""},
		{"alternate host", "--repo", "https://example.com/acme/repo", ""},
		{"protected label", "--label", "internal-model", ""},
		{"malformed label", "--label", ",bug", ""},
		{"protected assignee", "--assignee", "internal-model", ""},
		{"malformed assignee", "--assignee", "@other", ""},
		{"missing title", "--title", "", ""},
		{"missing body", "--body", "", ""},
		{"empty title", "--title", " ", ""},
		{"empty body", "--body", " ", ""},
		{"sanitized empty title", "--title", "internal-model", emptyPolicy},
		{"sanitized empty body", "--body", "internal-model", emptyPolicy},
		{"reference definition", "--body", "![safe][shot]\n\n[shot]: <" + image + ">", ""},
		{"title rule material", "--title", material, ""},
		{"body rule material", "--body", material, ""},
		{"alt rule material", "--attach", image + "#" + material, ""},
		{"residual title", "--title", "internal-model", residualPolicy},
		{"residual body", "--body", "internal-model", residualPolicy},
		{"residual alt", "--attach", image + "#internal-model", residualPolicy},
	} {
		t.Run(test.name, func(t *testing.T) {
			policyBody := test.policy
			if policyBody == "" {
				policyBody = rewriteActiveTestPolicy
			}
			policy.Store(policyBody)
			capturePath := captureRewriteGH(t)
			args := []string{"issue", "create", "--repo", "acme/repo", "--title", "safe", "--body", "safe", "--label", "bug", "--assignee", "steipete", "--attach", image + "#alt"}
			index := slices.Index(args, test.flag)
			if test.value == "" {
				args = slices.Delete(args, index, index+2)
			} else {
				args[index+1] = test.value
			}
			if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("expected strict block, got %v", err)
			}
			if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
				t.Fatal("blocked issue create reached child")
			}
		})
	}
}

func TestStringRewriteEditAttachments(t *testing.T) {
	for _, resource := range []string{"pr", "issue"} {
		t.Run(resource, func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			directory := t.TempDir()
			body := filepath.Join(directory, "body.md")
			emptyBody := filepath.Join(directory, "empty.md")
			image := filepath.Join(directory, "synthetic.png")
			video := filepath.Join(directory, "synthetic.mp4")
			content := "internal-model\n![internal-model](" + image + ")\n[internal-model](" + video + ")"
			for path, data := range map[string][]byte{body: []byte(content), emptyBody: {}, image: {0x89, 'P', 'N', 'G', 0x00, 0xff}, video: {0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p'}} {
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, test := range []struct {
				name string
				args []string
				body string
			}{
				{"explicit literal body", []string{"--body", content}, content},
				{"explicit stdin body", []string{"--body-file", "-"}, content},
				{"explicit body file", []string{"--body-file", body}, content},
				{"explicit empty body", []string{"--body", ""}, ""},
				{"explicit empty body file", []string{"--body-file", emptyBody}, ""},
			} {
				t.Run(test.name, func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					args := append([]string{resource, "edit", "133369", "--repo", "acme/repo"}, test.args...)
					args = append(args, "--add-label", "bug", "--add-assignee", "steipete", "--attach", image+"#internal-model screenshot", "--attach="+video)
					if err := execRealGHWithStdinAndEnv(t.Context(), args, strings.NewReader(content), io.Discard, io.Discard, os.Environ()); err != nil {
						t.Fatal(err)
					}
					capture := readRewriteCapture(t, capturePath)
					imageSnapshot := capturedAttachmentSnapshot(capture.Args, ".png")
					videoSnapshot := capturedAttachmentSnapshot(capture.Args, ".mp4")
					bodySnapshot := ""
					for _, arg := range capture.Args {
						if path, ok := strings.CutPrefix(arg, "--body-file="); ok {
							bodySnapshot = path
						}
					}
					wantArgs := []string{resource, "edit", "133369", "--repo=acme/repo", "--body-file=" + bodySnapshot, "--add-label=bug", "--add-assignee=steipete", "--attach=" + imageSnapshot + "#public screenshot", "--attach=" + videoSnapshot}
					wantBody := strings.NewReplacer("internal-model", "public", image, imageSnapshot, video, videoSnapshot).Replace(test.body)
					gotBody, hasBody := capture.Files[bodySnapshot]
					if !slices.Equal(capture.Args, wantArgs) || capture.Stdin != "" || len(capture.Files) != 3 || imageSnapshot == "" || videoSnapshot == "" || bodySnapshot == body || bodySnapshot == emptyBody || !hasBody || gotBody != wantBody {
						t.Fatalf("edit capture=%+v, want argv=%v body=%q", capture, wantArgs, wantBody)
					}
				})
			}
		})
	}
}

func TestStringRewriteEditAttachmentsRequireBody(t *testing.T) {
	for _, resource := range []string{"pr", "issue"} {
		t.Run(resource, func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			image := filepath.Join(t.TempDir(), "synthetic.png")
			if err := os.WriteFile(image, []byte("synthetic attachment"), 0600); err != nil {
				t.Fatal(err)
			}
			for _, test := range []struct {
				name string
				args []string
			}{
				{"no edit fields", nil},
				{"title only", []string{"--title", "safe"}},
				{"metadata only", []string{"--add-label", "bug", "--add-assignee", "steipete"}},
			} {
				for _, attach := range []bool{false, true} {
					t.Run(test.name+"/attach="+strconv.FormatBool(attach), func(t *testing.T) {
						capturePath := captureRewriteGH(t)
						args := append([]string{resource, "edit", "133369", "--repo", "acme/repo"}, test.args...)
						if attach {
							args = append(args, "--attach", image+"#alt")
						}
						err := runGH(t.Context(), args, io.Discard, io.Discard)
						if attach || len(test.args) == 0 {
							if err != errRewriteBlocked {
								t.Fatalf("expected strict block without body, got %v", err)
							}
							if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
								t.Fatal("blocked edit reached child")
							}
						} else {
							if err != nil {
								t.Fatal(err)
							}
							readRewriteCapture(t, capturePath)
						}
					})
				}
			}
		})
	}
}

func TestStringRewriteCommentAttachmentBodies(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	image := filepath.Join(t.TempDir(), "synthetic.png")
	if err := os.WriteFile(image, []byte("synthetic attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, resource := range []string{"pr", "issue"} {
		for _, test := range []struct {
			name string
			args []string
			edit bool
		}{
			{"new", nil, false},
			{"explicit new", []string{"--edit-last=false"}, false},
			{"edit last", []string{"--edit-last"}, true},
			{"explicit edit last", []string{"--edit-last=true"}, true},
			{"create if none", []string{"--edit-last=true", "--create-if-none"}, true},
		} {
			for _, source := range []string{"absent", "literal", "stdin"} {
				t.Run(resource+"/"+test.name+"/"+source, func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					args := append([]string{resource, "comment", "1", "--repo=acme/repo", "--attach=" + image}, test.args...)
					content := "internal-model\n![internal-model](" + image + ")"
					switch source {
					case "literal":
						args = append(args, "--body", content)
					case "stdin":
						args = append(args, "--body-file=-")
					}
					err := execRealGHWithStdinAndEnv(t.Context(), args, strings.NewReader(content), io.Discard, io.Discard, os.Environ())
					if test.edit && source == "absent" {
						if err != errRewriteBlocked {
							t.Fatalf("edit without complete body: %v", err)
						}
						if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
							t.Fatal("uninspected edit reached child")
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					capture := readRewriteCapture(t, capturePath)
					snapshot := capturedAttachmentSnapshot(capture.Args, ".png")
					wantFiles := 1
					if source != "absent" {
						wantFiles++
						want := strings.NewReplacer("internal-model", "public", image, snapshot).Replace(content)
						if !rewriteCaptureHasContent(capture, want) {
							t.Fatalf("complete body was not rewritten: %+v", capture)
						}
					}
					if capture.Stdin != "" || snapshot == "" || len(capture.FileData) != wantFiles {
						t.Fatalf("comment capture=%+v", capture)
					}
					for _, arg := range test.args {
						if !strings.Contains(arg, "=") {
							arg += "=true"
						}
						if !slices.Contains(capture.Args, arg) {
							t.Fatalf("native comment flag lost: %s", arg)
						}
					}
				})
			}
		}
	}
}

func TestStringRewriteIssueAttachmentStrictBlocks(t *testing.T) {
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	image := filepath.Join(t.TempDir(), "synthetic.png")
	if err := os.WriteFile(image, []byte("synthetic attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	material := `{"pattern":"internal-model","replacement":"synthetic"}`
	residual := strings.Replace(rewriteActiveTestPolicy, `"public"`, `"internal-model"`, 1)
	for _, action := range []string{"edit", "comment"} {
		for _, test := range []struct {
			name   string
			args   []string
			body   string
			policy string
		}{
			{"unknown flag", []string{"1", "--web"}, "safe", ""},
			{"duplicate body alias", []string{"1", "-bsafe"}, "safe", ""},
			{"conflicting body file", []string{"1", "--body-file=-"}, "safe", ""},
			{"duplicate repo alias", []string{"1", "-Racme/repo"}, "safe", ""},
			{"duplicate boolean", []string{"1", "--edit-last", "--edit-last=false"}, "safe", ""},
			{"invalid boolean", []string{"1", "--edit-last=maybe"}, "safe", ""},
			{"multiple selectors", []string{"1", "2"}, "safe", ""},
			{"missing selector", nil, "safe", ""},
			{"URL selector", []string{"https://github.com/acme/repo/issues/1"}, "safe", ""},
			{"nonnumeric selector", []string{"topic"}, "safe", ""},
			{"missing attachment value", []string{"1", "--attach"}, "safe", ""},
			{"empty attachment value", []string{"1", "--attach="}, "safe", ""},
			{"body rule material", []string{"1"}, material, ""},
			{"alt rule material", []string{"1", "--attach=" + image + "#" + material}, "safe", ""},
			{"residual body", []string{"1"}, "internal-model", residual},
			{"residual alt", []string{"1", "--attach=" + image + "#internal-model"}, "safe", residual},
			{"invalid UTF-8 body", []string{"1"}, string([]byte{0xff}), ""},
			{"oversized body", []string{"1"}, strings.Repeat("x", rewriteMaxContent+1), ""},
		} {
			for _, source := range []string{"literal", "file", "stdin"} {
				t.Run(action+"/"+test.name+"/"+source, func(t *testing.T) {
					policyBody := test.policy
					if policyBody == "" {
						policyBody = rewriteActiveTestPolicy
					}
					policy.Store(policyBody)
					capturePath := captureRewriteGH(t)
					staging := t.TempDir()
					args := []string{"issue", action, "--repo=acme/repo"}
					switch source {
					case "literal":
						args = append(args, "--body", test.body)
					case "stdin":
						args = append(args, "--body-file=-")
					case "file":
						body := filepath.Join(t.TempDir(), "body.md")
						if err := os.WriteFile(body, []byte(test.body), 0600); err != nil {
							t.Fatal(err)
						}
						args = append(args, "--body-file", body)
					}
					t.Setenv("TMPDIR", staging)
					if !slices.ContainsFunc(test.args, func(arg string) bool { return strings.HasPrefix(arg, "--attach") }) {
						args = append(args, "--attach", image)
					}
					args = append(args, test.args...)
					if err := execRealGHWithStdinAndEnv(t.Context(), args, strings.NewReader(test.body), io.Discard, io.Discard, os.Environ()); err != errRewriteBlocked {
						t.Fatalf("expected strict block, got %v", err)
					}
					if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
						t.Fatal("blocked input reached child")
					}
					if entries, err := os.ReadDir(staging); err != nil || len(entries) != 0 {
						t.Fatalf("failed preparation leaked staging: %v %v", entries, err)
					}
				})
			}
		}
	}
}

func TestStringRewritePolicyCreatedAttachmentReference(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	directory := t.TempDir()
	source := filepath.Join(directory, "public.png")
	if err := os.WriteFile(source, []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	protectedReference := filepath.Join(directory, "internal-model.png")
	capturePath := captureRewriteGH(t)
	args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "![safe](" + protectedReference + ")", "--attach", source}
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	capture := readRewriteCapture(t, capturePath)
	snapshot := capturedAttachmentSnapshot(capture.Args, ".png")
	found := false
	for path, content := range capture.Files {
		if path == snapshot {
			continue
		}
		_, states := rewriteAttachmentLinkStates([]byte(content))
		for _, state := range states {
			found = found || state.destination == snapshot
		}
	}
	if !found {
		t.Fatalf("policy-created attachment reference was not rewritten: %+v", capture)
	}
}

func TestStringRewriteAttachmentBlocks(t *testing.T) {
	for _, command := range [][]string{{"pr", "comment"}, {"issue", "edit"}, {"issue", "comment"}} {
		t.Run(strings.Join(command, " "), func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			directory := t.TempDir()
			unsupported := filepath.Join(directory, "artifact.txt")
			protected := filepath.Join(directory, "internal-model.png")
			empty := filepath.Join(directory, "empty.png")
			oversizedImage := filepath.Join(directory, "large.png")
			oversizedVideo := filepath.Join(directory, "large.mp4")
			for _, path := range []string{unsupported, protected} {
				if err := os.WriteFile(path, []byte("safe"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for path, size := range map[string]int64{empty: 0, oversizedImage: rewriteMaxImageAttachment + 1, oversizedVideo: rewriteMaxAttachmentBytes + 1} {
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Truncate(path, size); err != nil {
					t.Fatal(err)
				}
			}
			for _, test := range []struct {
				attachment string
				body       string
			}{
				{unsupported, "safe"},
				{protected, "safe"},
				{directory, "safe"},
				{empty, "safe"},
				{oversizedImage, "safe"},
				{oversizedVideo, "safe"},
				{protected + "#safe", "safe"},
				{filepath.Join(directory, "missing.png"), "safe"},
			} {
				capturePath := captureRewriteGH(t)
				args := []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", test.body, "--attach", test.attachment}
				if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
					t.Fatalf("attachment %q error=%v", test.attachment, err)
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("blocked attachment reached child")
				}
			}
			safe := filepath.Join(directory, "safe.png")
			video := filepath.Join(directory, "safe.mp4")
			for _, path := range []string{safe, video} {
				if err := os.WriteFile(path, []byte("safe"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, test := range []struct {
				name string
				args []string
			}{
				{"video alt", []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", "safe", "--attach", video + "#caption"}},
				{"edit last without body", []string{command[0], command[1], "1", "--repo", "acme/repo", "--edit-last", "--attach", safe}},
				{"delete last with attachment", []string{command[0], command[1], "1", "--repo", "acme/repo", "--delete-last", "--attach", safe}},
				{"duplicate file", []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", "safe", "--attach", safe, "--attach", safe}},
				{"malformed inline then shortcut reference", []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", "![shot](" + safe + " garbage)\n\n[shot]: " + safe, "--attach", safe}},
				{"reference definition", []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", "![safe][shot]\n\n[shot]: <" + safe + ">", "--attach", safe}},
				{"multiline reference definition", []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", "![safe][shot]\n\n[shot]:\n  " + safe, "--attach", safe}},
				{"too many inline references", []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", strings.Repeat("![safe]("+safe+")\n", rewriteMaxAttachmentReferences+1), "--attach", safe}},
			} {
				t.Run(test.name, func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					if err := execRealGH(t.Context(), test.args, io.Discard, io.Discard); err != errRewriteBlocked {
						t.Fatalf("error=%v", err)
					}
					if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
						t.Fatal("blocked attachment reached child")
					}
				})
			}
			t.Run("aggregate byte limit", func(t *testing.T) {
				args := []string{command[0], command[1], "1", "--repo=acme/repo", "--body=safe"}
				for _, name := range []string{"first.mp4", "second.mp4"} {
					path := filepath.Join(directory, name)
					if err := os.WriteFile(path, nil, 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Truncate(path, rewriteMaxAttachmentBytes/2+1); err != nil {
						t.Fatal(err)
					}
					args = append(args, "--attach="+path)
				}
				capturePath := captureRewriteGH(t)
				if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
					t.Fatalf("aggregate limit error=%v", err)
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("excess attachment bytes reached child")
				}
			})
			args := []string{command[0], command[1], "1", "--repo", "acme/repo", "--body", "safe"}
			for index := range rewriteMaxAttachments + 1 {
				path := filepath.Join(directory, strconv.Itoa(index)+".png")
				if err := os.WriteFile(path, []byte("synthetic"), 0600); err != nil {
					t.Fatal(err)
				}
				args = append(args, "--attach", path)
			}
			capturePath := captureRewriteGH(t)
			if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("attachment count error=%v", err)
			}
			if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
				t.Fatal("excess attachments reached child")
			}
		})
	}
}

func TestStringRewriteAttachmentAltFallback(t *testing.T) {
	policy := `{"schema_version":1,"revision":1,"updated_at":"2026-08-29T00:00:00Z","rules":[{"pattern":"secret-alt","replacement":""}]}`
	rewriteTestServer(t, policy, nil)
	image := filepath.Join(t.TempDir(), "friendly.png")
	if err := os.WriteFile(image, []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"#secret-alt", "#"} {
		capturePath := captureRewriteGH(t)
		args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--attach", image + suffix}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.ContainsFunc(capture.Args, func(arg string) bool {
			return strings.HasPrefix(arg, "--attach=") && strings.HasSuffix(arg, ".png#friendly")
		}) {
			t.Fatalf("original filename alt fallback missing: %v", capture.Args)
		}
	}
}

func TestRewriteAttachmentPathSemantics(t *testing.T) {
	policy, err := compileStringRewriteRules([]stringRewriteRule{{Pattern: "internal-model", Replacement: "public"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := checkRewriteAttachmentPath(policy, `.\\shot.png`); err != nil {
		t.Fatal("Windows path separators were rejected")
	}
	if rewriteAttachmentDestinationRemote(`C:/work/shot.png`) {
		t.Fatal("Windows volume path was classified as remote")
	}
	if !rewriteAttachmentDestinationRemote(`https://example.com/shot.png`) {
		t.Fatal("HTTPS destination was classified as local")
	}
}

func TestStringRewriteMaintainerCompatibility(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, test := range []struct {
		name      string
		args      []string
		mergeBody bool
	}{
		{"read readiness fields", []string{"pr", "view", "123", "--repo", "acme/repo", "--json", "number,isDraft,mergeable,mergeStateStatus,reviewDecision,reviewRequests", "--jq", ".number"}, false},
		{"read status rollup", []string{"pr", "view", "123", "--repo", "acme/repo", "--json", "number,headRefOid,statusCheckRollup"}, false},
		{"read issue comments", []string{"issue", "view", "123", "--repo", "https://github.com/acme/repo", "--json", "number,comments"}, false},
		{"filter pull head", []string{"pr", "list", "--repo", "https://github.com/acme/repo", "--head", "safe-branch", "--json", "number,headRefName"}, false},
		{"mark ready", []string{"pr", "ready", "123", "--repo", "https://github.com/acme/repo"}, false},
		{"convert draft", []string{"pr", "ready", "123", "--repo", "acme/repo", "--undo"}, false},
		{"pinned squash", []string{"pr", "merge", "123", "--repo", "https://github.com/acme/repo", "--squash", "--match-head-commit", sha}, true},
		{"claim assignee", []string{"pr", "edit", "123", "--repo", "acme/repo", "--add-assignee", "steipete"}, false},
		{"self-assign issue", []string{"issue", "edit", "123", "--repo", "acme/repo", "--add-assignee", "@me"}, false},
		{"add issue labels", []string{"issue", "edit", "123", "--repo", "acme/repo", "--add-label", "bug,help wanted"}, false},
		{"remove pr label", []string{"pr", "edit", "123", "--repo", "acme/repo", "--remove-label", "blocked"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			if err := execRealGH(t.Context(), test.args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if capture.Stdin != "" {
				t.Fatal("metadata command retained live stdin")
			}
			if test.mergeBody {
				if len(capture.Files) != 1 || !slices.Contains(capture.Args, "api") || !slices.Contains(capture.Args, "repos/acme/repo/pulls/123/merge") || !slices.Contains(capture.Args, "--method=PUT") || !slices.Contains(capture.Args, "--silent=true") {
					t.Fatalf("merge was not converted to a fixed REST mutation: %+v", capture)
				}
				for _, content := range capture.Files {
					var payload map[string]string
					if err := json.Unmarshal([]byte(content), &payload); err != nil || payload["sha"] != sha || payload["merge_method"] != "squash" || len(payload) != 2 {
						t.Fatalf("merge snapshot=%q", content)
					}
				}
			} else {
				if len(capture.Files) != 0 {
					t.Fatal("metadata command retained content input")
				}
				if !slices.Contains(capture.Args, "--repo=acme/repo") {
					t.Fatalf("repository was not normalized and pinned: %v", capture.Args)
				}
			}
			for _, arg := range capture.Args {
				if strings.Contains(arg, "internal-model") || strings.Contains(arg, "match-head-commit") || strings.Contains(arg, "https://github.com") {
					t.Fatal("metadata command leaked protected or native merge input")
				}
			}
		})
	}

	repoViewCapturePath := captureRewriteGH(t)
	if err := execRealGH(t.Context(), []string{"repo", "view", "https://github.com/acme/repo", "--json", "nameWithOwner"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	repoViewCapture := readRewriteCapture(t, repoViewCapturePath)
	if !slices.Contains(repoViewCapture.Args, "acme/repo") || slices.ContainsFunc(repoViewCapture.Args, func(arg string) bool { return strings.HasPrefix(arg, "--repo") }) {
		t.Fatalf("repo view target was not kept positional: %v", repoViewCapture.Args)
	}

	repo := t.TempDir()
	if output, err := exec.Command("git", "init", "--quiet", "--initial-branch=safe-ready-branch", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(repo); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	branchCapture := captureRewriteGH(t)
	if err := execRealGH(t.Context(), []string{"pr", "ready", "--repo", "acme/repo"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if captured := readRewriteCapture(t, branchCapture); !slices.Contains(captured.Args, "safe-ready-branch") {
		t.Fatalf("current branch not pinned: %v", captured.Args)
	}
	if output, err := exec.Command("git", "checkout", "--quiet", "-b", "123").CombinedOutput(); err != nil {
		t.Fatalf("numeric branch: %v: %s", err, output)
	}
	numericCapture := captureRewriteGH(t)
	if err := execRealGH(t.Context(), []string{"pr", "ready", "--repo", "acme/repo"}, io.Discard, io.Discard); err != errRewriteBlocked {
		t.Fatalf("numeric current branch error=%v", err)
	}
	if _, err := os.Stat(numericCapture); !os.IsNotExist(err) {
		t.Fatal("numeric current branch reached child")
	}

	capturePath := captureRewriteGH(t)
	args := []string{"api", "repos/acme/repo/issues/123/assignees", "--method", "POST", "-f", "assignees[]=steipete"}
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	capture := readRewriteCapture(t, capturePath)
	if len(capture.Files) != 1 {
		t.Fatalf("files=%v", capture.Files)
	}
	for _, content := range capture.Files {
		if content != `{"assignees":["steipete"]}` {
			t.Fatalf("assignee snapshot=%q", content)
		}
	}

	capturePath = captureRewriteGH(t)
	args = []string{"api", "repos/acme/repo/pulls/123/merge", "--method", "PUT", "-f", "sha=" + sha, "-f", "merge_method=squash", "--silent"}
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	capture = readRewriteCapture(t, capturePath)
	if len(capture.Files) != 1 || !slices.Contains(capture.Args, "--method=PUT") || !slices.Contains(capture.Args, "--silent=true") {
		t.Fatalf("raw merge was not snapshotted: %+v", capture)
	}
	for _, content := range capture.Files {
		var payload map[string]string
		if err := json.Unmarshal([]byte(content), &payload); err != nil || payload["sha"] != sha || payload["merge_method"] != "squash" || len(payload) != 2 {
			t.Fatalf("raw merge snapshot=%q", content)
		}
	}
}

func TestStringRewriteReadFallbackCompatibility(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		writeCLIFallback(t, w, "route_denied")
	})
	sha := strings.Repeat("a", 40)
	for _, test := range []struct {
		name string
		args []string
		want string
	}{
		{"read readiness", []string{"pr", "view", "123", "--repo", "acme/repo", "--json", "number,headRefOid,statusCheckRollup"}, "123"},
		{"read issue comments", []string{"issue", "view", "123", "--repo", "https://github.com/acme/repo", "--json", "number,comments"}, "comments"},
		{"filter pull head", []string{"pr", "list", "--repo", "https://github.com/acme/repo", "--head", "safe-branch", "--json", "number"}, "safe-branch"},
		{"mark ready", []string{"pr", "ready", "123", "--repo", "https://github.com/acme/repo"}, "ready"},
		{"pinned merge", []string{"pr", "merge", "123", "--repo", "https://github.com/acme/repo", "--squash", "--match-head-commit", sha}, "repos/acme/repo/pulls/123/merge"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			if err := runGH(t.Context(), test.args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if test.args[0] == "pr" && test.args[1] == "list" && !slices.Equal(capture.Args, []string{"pr", "list", "--repo=acme/repo", "--head", "safe-branch", "--json", "number"}) {
				t.Fatalf("read fallback changed caller spelling/order: %v", capture.Args)
			}
			if !slices.Contains(capture.Args, "--repo=acme/repo") && !slices.Contains(capture.Args, "repos/acme/repo/pulls/123/merge") {
				t.Fatalf("repository was not structurally pinned: %v", capture.Args)
			}
			if !slices.Contains(capture.Args, test.want) && !slices.ContainsFunc(capture.Args, func(arg string) bool { return strings.Contains(arg, test.want) }) {
				t.Fatalf("guarded command shape missing %q: %v", test.want, capture.Args)
			}
			if slices.ContainsFunc(capture.Args, func(arg string) bool { return strings.Contains(arg, "https://github.com") }) {
				t.Fatalf("original repository URL reached child: %v", capture.Args)
			}
		})
	}
}

func TestStringRewriteBestEffortClone(t *testing.T) {
	policyStore, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	t.Setenv("GH_HOST", "ghe.example")
	t.Setenv("GH_REPO", "ghe.example/other/repo")
	for _, test := range []struct {
		name    string
		args    []string
		want    []string
		blocked bool
		policy  string
	}{
		{name: "dotted destination", args: []string{"https://github.com/openclaw/openclaw", ".artifacts/proof/live-project"}},
		{name: "long help", args: []string{"--help"}},
		{name: "short help", args: []string{"-h"}},
		{name: "help option before source", args: []string{"--help=false", "acme/repo"}},
		{name: "nested destination", args: []string{"acme/repo", "workspace/proof/repo"}},
		{name: "absolute destination", args: []string{"acme/repo", "/tmp/proof/repo"}},
		{name: "current directory", args: []string{"acme/repo", "."}},
		{name: "dot relative destination", args: []string{"acme/repo", "./proof/repo"}},
		{name: "parent relative destination", args: []string{"acme/repo", "../proof/repo"}},
		{name: "git flags without destination", args: []string{"acme/repo", "--", "-c", "core.hooksPath=/dev/null"}},
		{name: "git flags with destination", args: []string{"acme/repo", ".artifacts/proof/repo", "--", "-c", "core.hooksPath=/dev/null"}},
		{name: "destination after delimiter", args: []string{"acme/repo", "--", ".artifacts/proof/repo", "-c", "core.hooksPath=/dev/null"}},
		{name: "source after delimiter", args: []string{"--", "https://github.com/acme/repo", ".artifacts/proof/repo"}},
		{name: "boolean before source", args: []string{"--no-upstream", "acme/repo", ".artifacts/proof/repo"}},
		{name: "boolean equals before source", args: []string{"--no-upstream=false", "acme/repo"}},
		{name: "long value before source", args: []string{"--upstream-remote-name", "ghe.example/acme/upstream", "acme/repo"}},
		{name: "long equals before source", args: []string{"--upstream-remote-name=upstream", "acme/repo"}},
		{name: "short value before source", args: []string{"-u", "upstream", "acme/repo"}},
		{name: "short attached before source", args: []string{"-uupstream", "acme/repo"}},
		{name: "short equals before source", args: []string{"-u=upstream", "acme/repo"}},
		{name: "delimiter as option value", args: []string{"-u", "--", "acme/repo"}},
		{name: "native option after source", args: []string{"acme/repo", "--upstream-remote-name", "ghe.example/acme/upstream", ".artifacts/proof/repo"}},
		{name: "bare repository", args: []string{"myrepo", ".artifacts/proof/repo"}},
		{name: "host qualified github source", args: []string{"github.com/acme/repo", ".artifacts/proof/repo"}},
		{name: "https protocol", args: []string{"https://github.com/acme/repo.git", ".artifacts/proof/repo"}},
		{name: "ssh protocol", args: []string{"ssh://git@github.com/acme/repo.git", ".artifacts/proof/repo"}},
		{name: "scp protocol", args: []string{"git@github.com:acme/repo.git", ".artifacts/proof/repo"}},
		{
			name: "visible destination and git values rewritten",
			args: []string{"acme/repo", ".artifacts/internal-model/repo", "--", "-c", "core.hooksPath=/internal-model/null", "--branch=internal-model"},
			want: []string{"acme/repo", ".artifacts/public/repo", "--", "-c", "core.hooksPath=/public/null", "--branch=public"},
		},
		{
			name: "native option value rewritten",
			args: []string{"-u", "internal-model", "acme/repo"},
			want: []string{"-u", "public", "acme/repo"},
		},
		{name: "enterprise https", args: []string{"https://ghe.example/acme/repo", ".artifacts/proof/repo"}, blocked: true},
		{name: "enterprise host qualified", args: []string{"ghe.example/acme/repo"}, blocked: true},
		{name: "enterprise scp", args: []string{"ghe.example:acme/repo"}, blocked: true},
		{name: "enterprise scp user", args: []string{"alice@ghe.example:acme/repo"}, blocked: true},
		{name: "enterprise ssh", args: []string{"ssh://git@ghe.example/acme/repo.git"}, blocked: true},
		{name: "enterprise ssh without user", args: []string{"ssh://ghe.example/acme/repo.git"}, blocked: true},
		{name: "enterprise deep url", args: []string{"https://ghe.example/acme/repo/tree/main"}, blocked: true},
		{name: "enterprise single label host", args: []string{"enterprise/acme/repo"}, blocked: true},
		{name: "enterprise after delimiter", args: []string{"--", "https://ghe.example/acme/repo"}, blocked: true},
		{name: "enterprise after option value", args: []string{"-u", "acme/safe", "ghe.example/acme/repo"}, blocked: true},
		{name: "enterprise after consumed delimiter", args: []string{"--upstream-remote-name", "--", "ssh://git@ghe.example/acme/repo.git"}, blocked: true},
		{name: "unknown option before source", args: []string{"--future-option", "acme/safe", "ghe.example/acme/repo"}, blocked: true},
		{name: "unknown option with safe source", args: []string{"--future-option", "acme/repo"}, blocked: true},
		{name: "missing option value", args: []string{"-u"}, blocked: true},
		{name: "missing source after delimiter", args: []string{"--"}, blocked: true},
		{name: "matching source", args: []string{"https://github.com/acme/internal-model", ".artifacts/proof/repo"}, blocked: true},
		{name: "matching bare source", args: []string{"internal-model"}, blocked: true},
		{
			name:    "rewritten option exposes enterprise source",
			args:    []string{"--upstream-remote-name", "ghe.example/acme/repo", "acme/safe"},
			blocked: true,
			policy:  `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"--upstream-remote-name","replacement":"--no-upstream"}]}`,
		},
		{
			name:    "rewritten source protocol revalidated",
			args:    []string{"https://github.com/acme/repo"},
			blocked: true,
			policy:  `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^https://github[.]com/","replacement":"ssh://git@ghe.example/"}]}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := test.policy
			if policy == "" {
				policy = rewriteActiveTestPolicy
			}
			policyStore.Store(policy)
			capturePath := captureRewriteGH(t)
			args := append([]string{"repo", "clone"}, test.args...)
			err := runGH(t.Context(), args, io.Discard, io.Discard)
			if test.blocked {
				if err != errRewriteBlocked {
					t.Errorf("clone denial error=%v", err)
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("denied clone reached child")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := args
			if test.want != nil {
				want = append([]string{"repo", "clone"}, test.want...)
			}
			capture := readRewriteCapture(t, capturePath)
			if !slices.Equal(capture.Args, want) {
				t.Fatalf("clone argv=%q, want %q", capture.Args, want)
			}
			if capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" {
				t.Fatalf("clone host was not pinned: %v", capture.Env)
			}
		})
	}
}

func TestStringRewriteBestEffortFallback(t *testing.T) {
	policyStore, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)

	for _, test := range []struct {
		name string
		args []string
		want string
	}{
		{"workflow fields", []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "--ref", "main", "-f", "message=internal-model"}, "message=public"},
		{"run job logs", []string{"run", "view", "123", "--repo", "acme/repo", "--job", "456", "--log"}, "--job"},
		{"config read", []string{"config", "get", "internal-model"}, "public"},
		{"graphql read", []string{"api", "graphql", "-f", "query=query { internal-model }"}, "query=query { public }"},
		{"graphql explicit host", []string{"api", "graphql", "--hostname", "github.com", "-f", "query=query { internal-model }"}, "query=query { public }"},
		{"raw workflow dispatch", []string{"api", "repos/acme/repo/actions/workflows/deploy.yml/dispatches", "--method", "POST", "-f", "ref=main", "-f", "inputs[message]=internal-model"}, "inputs[message]=public"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			if err := runGH(t.Context(), test.args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if !slices.Contains(capture.Args, test.want) {
				t.Fatalf("best-effort argv missing %q: %v", test.want, capture.Args)
			}
			for _, arg := range capture.Args {
				if strings.Contains(arg, "internal-model") {
					t.Fatalf("unfiltered argv: %v", capture.Args)
				}
			}
			if test.name == "workflow fields" && (!slices.Contains(capture.Args, "github.com/acme/repo") || capture.Env["GH_HOST"] != "github.com") {
				t.Fatalf("workflow repository was not pinned: args=%v env=%v", capture.Args, capture.Env)
			}
		})
	}

	for _, test := range []struct {
		name    string
		args    []string
		repoArg string
	}{
		{
			"search issues repository filter",
			[]string{"search", "issues", "internal-model", "--repo", "acme/repo", "--state", "open", "--match", "title,body", "--limit", "10", "--json", "number,title,url,updatedAt"},
			"acme/repo",
		},
		{
			"search prs repository filter",
			[]string{"search", "prs", "internal-model", "--repo=https://github.com/acme/repo", "--state", "open", "--match", "title,body", "--limit", "10", "--json", "number,title,url,updatedAt"},
			"--repo=acme/repo",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			if err := runGH(t.Context(), test.args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if !slices.Contains(capture.Args, test.repoArg) || capture.Env["GH_HOST"] != "github.com" {
				t.Fatalf("search repository filter was not pinned: args=%v env=%v", capture.Args, capture.Env)
			}
			if slices.ContainsFunc(capture.Args, func(arg string) bool {
				return strings.Contains(arg, "github.com/acme/repo") || strings.Contains(arg, "internal-model")
			}) {
				t.Fatalf("search repository or query was rewritten incorrectly: %v", capture.Args)
			}
		})
	}

	t.Run("search enterprise repository blocks", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"search", "issues", "safe", "--repo", "ghe.example/acme/repo", "--match", "title"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("enterprise search repository error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("enterprise search repository reached child")
		}
	})

	for _, value := range []string{"https://ghe.example/acme/repo", "ghe.example/acme/repo", "ghe.example:acme/repo", "alice@ghe.example:acme/repo"} {
		t.Run("positional enterprise repository blocks", func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := []string{"repo", "clone", value}
			if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("positional enterprise repository error=%v", err)
			}
			if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
				t.Fatal("positional enterprise repository reached child")
			}
		})
	}

	t.Run("positional github repository is pinned", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"repo", "clone", "https://github.com/acme/repo"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, "https://github.com/acme/repo") || capture.Env["GH_HOST"] != "github.com" {
			t.Fatalf("positional GitHub repository was not pinned: args=%v env=%v", capture.Args, capture.Env)
		}
	})

	t.Run("positional ssh repository preserves protocol", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"repo", "clone", "ssh://git@github.com/acme/repo.git"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, "ssh://git@github.com/acme/repo.git") {
			t.Fatalf("positional SSH protocol changed: %v", capture.Args)
		}
	})

	t.Run("positional scp repository preserves protocol", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"repo", "clone", "git@github.com:acme/repo.git"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, "git@github.com:acme/repo.git") {
			t.Fatalf("positional SCP protocol changed: %v", capture.Args)
		}
	})

	t.Run("implicit repository ignores enterprise environment", func(t *testing.T) {
		t.Setenv("GH_HOST", "ghe.example")
		t.Setenv("GH_REPO", "ghe.example/other/repo")
		repo := t.TempDir()
		if output, err := exec.Command("git", "init", "--quiet", repo).CombinedOutput(); err != nil {
			t.Fatalf("git init: %v: %s", err, output)
		}
		if output, err := exec.Command("git", "-C", repo, "remote", "add", "origin", "https://github.com/acme/repo").CombinedOutput(); err != nil {
			t.Fatalf("git remote: %v: %s", err, output)
		}
		previous, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chdir(repo); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = os.Chdir(previous) }()
		capturePath := captureRewriteGH(t)
		args := []string{"workflow", "run", "deploy.yml", "-f", "message=safe"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" || !slices.Contains(capture.Args, "--repo=github.com/acme/repo") {
			t.Fatalf("implicit repository was not pinned: args=%v env=%v", capture.Args, capture.Env)
		}
	})

	t.Run("implicit ssh URL repository is pinned", func(t *testing.T) {
		repo := t.TempDir()
		if output, err := exec.Command("git", "init", "--quiet", repo).CombinedOutput(); err != nil {
			t.Fatalf("git init: %v: %s", err, output)
		}
		if output, err := exec.Command("git", "-C", repo, "remote", "add", "origin", "ssh://git@github.com/acme/repo.git").CombinedOutput(); err != nil {
			t.Fatalf("git remote: %v: %s", err, output)
		}
		previous, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chdir(repo); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = os.Chdir(previous) }()
		capturePath := captureRewriteGH(t)
		args := []string{"workflow", "run", "deploy.yml", "-f", "message=safe"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, "--repo=github.com/acme/repo") {
			t.Fatalf("ssh URL repository was not pinned: %v", capture.Args)
		}
	})

	t.Run("bootstrap auth pins github host", func(t *testing.T) {
		t.Setenv("GH_HOST", "ghe.example")
		t.Setenv("GH_REPO", "ghe.example/other/repo")
		capturePath := captureRewriteGH(t)
		args := []string{"auth", "status", "--active", "--hostname", "github.com"}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" {
			t.Fatalf("bootstrap host was not pinned: %v", capture.Env)
		}
	})

	t.Run("top-level alternate repository host blocks", func(t *testing.T) {
		t.Setenv("GH_HOST", "ghe.example")
		capturePath := captureRewriteGH(t)
		args := []string{"workflow", "run", "deploy.yml", "--repo", "ghe.example/acme/repo", "-f", "message=safe"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("alternate repository host error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("alternate repository host reached child")
		}
	})

	t.Run("protected repository does not redirect", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"workflow", "run", "deploy.yml", "--repo", "internal-model/repo", "-f", "message=safe"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("protected repository error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("protected repository reached child")
		}
	})

	t.Run("positional pull URL is pinned", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"pr", "view", "https://github.com/acme/repo/pull/7", "--comments", "--repo", "acme/repo"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, "https://github.com/acme/repo/pull/7") || !slices.Contains(capture.Args, "github.com/acme/repo") || capture.Env["GH_HOST"] != "github.com" {
			t.Fatalf("pull URL was not validated and host-pinned: args=%v env=%v", capture.Args, capture.Env)
		}
	})

	t.Run("positional enterprise pull URL blocks", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"pr", "view", "https://ghe.example/acme/repo/pull/7", "--comments", "--repo", "acme/repo"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("enterprise pull URL error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("enterprise pull URL reached child")
		}
	})

	t.Run("enterprise pull URL cannot hide behind flag URLs", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{
			"pr", "view", "--json", "number",
			"--template", "https://github.com/acme/repo/pull/1",
			"--template", "https://github.com/acme/repo/pull/2",
			"https://ghe.example/acme/repo/pull/7", "--repo", "acme/repo",
		}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("hidden enterprise pull URL error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("hidden enterprise pull URL reached child")
		}
	})

	t.Run("repo list slash-containing jq passes", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"repo", "list", "--json", "nameWithOwner", "--jq", `.[].nameWithOwner | split("/")[0]`}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, `.[].nameWithOwner | split("/")[0]`) {
			t.Fatalf("repo list jq changed: %v", capture.Args)
		}
	})

	t.Run("api pins github host over environment", func(t *testing.T) {
		t.Setenv("GH_HOST", "ghe.example")
		capturePath := captureRewriteGH(t)
		args := []string{"api", "graphql", "-f", "query=query { viewer { login } }"}
		if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if capture.Env["GH_HOST"] != "github.com" || !slices.Contains(capture.Args, "--hostname=github.com") {
			t.Fatalf("API host was not pinned: args=%v env=%v", capture.Args, capture.Env)
		}
	})

	t.Run("field dispatch does not read idle pipe", func(t *testing.T) {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		defer writer.Close()
		policy, err := parseStringRewritePolicy([]byte(rewriteActiveTestPolicy), true)
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			prepared := &rewritePreparation{}
			done <- prepareRewriteBestEffort(policy, []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "-f", "message=safe"}, reader, prepared)
		}()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(250 * time.Millisecond):
			t.Fatal("field dispatch attempted to read idle stdin")
		}
	})

	t.Run("workflow json stdin", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := `{"message":"internal-model","nested":{"value":"internal-model"}}`
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "--ref", "main", "--json"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		var payload map[string]any
		if err := json.Unmarshal([]byte(capture.Stdin), &payload); err != nil {
			t.Fatal(err)
		}
		if payload["message"] != "public" || payload["nested"].(map[string]any)["value"] != "public" {
			t.Fatalf("workflow stdin not rewritten: %s", capture.Stdin)
		}
	})

	t.Run("typed field stdin is snapshotted", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		args := []string{"api", "repos/acme/repo/issues/1/comments", "-Fbody=@-", "--verbose"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("internal-model"), io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if capture.Stdin != "" || len(capture.Files) != 1 {
			t.Fatalf("typed field retained stdin: %+v", capture)
		}
		if !slices.ContainsFunc(capture.Args, func(arg string) bool { return strings.HasPrefix(arg, "--field=body=@") }) {
			t.Fatalf("typed field was not rebound to snapshot: %v", capture.Args)
		}
		for _, content := range capture.Files {
			if content != "public" {
				t.Fatalf("typed field snapshot=%q", content)
			}
		}
	})

	t.Run("typed field key is rewritten", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := filepath.Join(t.TempDir(), "safe.txt")
		if err := os.WriteFile(input, []byte("safe"), 0600); err != nil {
			t.Fatal(err)
		}
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "-F", "internal-model=@" + input}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.ContainsFunc(capture.Args, func(arg string) bool { return strings.HasPrefix(arg, "--field=public=@") }) {
			t.Fatalf("typed field key was not rewritten: %v", capture.Args)
		}
	})

	t.Run("policy material still blocks", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := `{"message":"{\"pattern\":\"internal-model\",\"replacement\":\"public\"}"}`
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "--ref", "main", "--json"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("policy material error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("policy material reached child")
		}
	})

	t.Run("direct policy object still blocks", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := `{"pattern":"internal-model","replacement":"public"}`
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "--ref", "main", "--json"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("direct policy material error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("direct policy object reached child")
		}
	})

	t.Run("api input snapshot", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := filepath.Join(t.TempDir(), "dispatch.json")
		original := []byte(`{"ref":"main","inputs":{"message":"internal-model"}}`)
		if err := os.WriteFile(input, original, 0600); err != nil {
			t.Fatal(err)
		}
		args := []string{"api", "repos/acme/repo/actions/workflows/deploy.yml/dispatches", "--method", "POST", "--input", input}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if len(capture.Files) != 1 {
			t.Fatalf("snapshot files=%v", capture.Files)
		}
		for _, content := range capture.Files {
			if strings.Contains(content, "internal-model") || !strings.Contains(content, "public") {
				t.Fatalf("input snapshot not rewritten: %s", content)
			}
		}
		unchanged, err := os.ReadFile(input)
		if err != nil || !bytes.Equal(unchanged, original) {
			t.Fatal("original dispatch input changed")
		}
	})

	t.Run("typed field preserves exact text", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := filepath.Join(t.TempDir(), "payload.txt")
		original := []byte("{\n  \"z\": 1,\n  \"a\": 2\n}\n")
		if err := os.WriteFile(input, original, 0600); err != nil {
			t.Fatal(err)
		}
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "-F", "payload=@" + input}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if len(capture.Files) != 1 {
			t.Fatalf("typed field files=%v", capture.Files)
		}
		for _, content := range capture.Files {
			if content != string(original) {
				t.Fatalf("typed field bytes changed: %q", content)
			}
		}
	})

	t.Run("source path is frozen before rewriting", func(t *testing.T) {
		dir := t.TempDir()
		intended := filepath.Join(dir, "internal-model.json")
		wrong := filepath.Join(dir, "public.json")
		if err := os.WriteFile(intended, []byte(`{"value":"intended-safe-content"}`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(wrong, []byte(`{"value":"wrong-file-content"}`), 0600); err != nil {
			t.Fatal(err)
		}
		capturePath := captureRewriteGH(t)
		args := []string{"api", "repos/acme/repo/actions/workflows/deploy.yml/dispatches", "--verbose", "--input", intended}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if len(capture.Files) != 1 {
			t.Fatalf("source snapshot files=%v", capture.Files)
		}
		for _, content := range capture.Files {
			if !strings.Contains(content, "intended-safe-content") || strings.Contains(content, "wrong-file-content") {
				t.Fatalf("wrong source file snapshotted: %q", content)
			}
		}
	})

	t.Run("repeated inputs retain aggregate bound", func(t *testing.T) {
		capturePath := captureRewriteGH(t)
		input := filepath.Join(t.TempDir(), "large.json")
		data := []byte(`"` + strings.Repeat("a", 600_000) + `"`)
		if err := os.WriteFile(input, data, 0600); err != nil {
			t.Fatal(err)
		}
		args := []string{"api", "repos/acme/repo/actions/workflows/deploy.yml/dispatches", "--verbose", "--input", input, "--input", input}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("repeated input error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("oversized aggregate input reached child")
		}
	})

	t.Run("rewritten json flag filters stdin", func(t *testing.T) {
		policyJSON, err := json.Marshal(map[string]any{
			"schema_version": 1,
			"revision":       2,
			"updated_at":     "2026-08-29T00:00:00Z",
			"rules": []map[string]string{
				{"pattern": "MAGIC", "replacement": "--json"},
				{"pattern": "internal-model", "replacement": "public"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		policyStore.Store(string(policyJSON))
		capturePath := captureRewriteGH(t)
		input := `{"message":"internal-model"}`
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "MAGIC"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if !slices.Contains(capture.Args, "--json") || strings.Contains(capture.Stdin, "internal-model") || !strings.Contains(capture.Stdin, "public") {
			t.Fatalf("rewritten json flag did not filter stdin: %+v", capture)
		}
	})

	t.Run("rewritten JSON cannot create policy material", func(t *testing.T) {
		policyJSON, err := json.Marshal(map[string]any{
			"schema_version": 1,
			"revision":       2,
			"updated_at":     "2026-08-29T00:00:00Z",
			"rules": []map[string]string{
				{"pattern": "^p$", "replacement": "pattern"},
				{"pattern": `\binternal-model\b`, "replacement": "public"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		policyStore.Store(string(policyJSON))
		capturePath := captureRewriteGH(t)
		input := `{"p":"\\binternal-model\\b","replacement":"public"}`
		args := []string{"workflow", "run", "deploy.yml", "--repo", "acme/repo", "--ref", "main", "--json"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("created policy material error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("rewritten policy material reached child")
		}
	})

	t.Run("rewritten source flag is snapshotted", func(t *testing.T) {
		source := filepath.Join(t.TempDir(), "private.txt")
		if err := os.WriteFile(source, []byte("internal-model"), 0600); err != nil {
			t.Fatal(err)
		}
		policyJSON, err := json.Marshal(map[string]any{
			"schema_version": 1,
			"revision":       2,
			"updated_at":     "2026-08-29T00:00:00Z",
			"rules": []map[string]string{
				{"pattern": "MAGIC", "replacement": "--field=body=@" + source},
				{"pattern": "internal-model", "replacement": "public"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		policyStore.Store(string(policyJSON))
		capturePath := captureRewriteGH(t)
		args := []string{"api", "graphql", "--verbose", "-f", "query=query { viewer { login } }", "MAGIC"}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		capture := readRewriteCapture(t, capturePath)
		if len(capture.Files) != 1 || slices.ContainsFunc(capture.Args, func(arg string) bool { return strings.Contains(arg, source) }) {
			t.Fatalf("rewritten source was not isolated: %+v", capture)
		}
		for _, content := range capture.Files {
			if content != "public" {
				t.Fatalf("rewritten source snapshot=%q", content)
			}
		}
	})

	t.Run("rewritten API host is revalidated", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":2,"updated_at":"2026-08-29T00:00:00Z","rules":[{"pattern":"github\\.com","replacement":"ghe.example"}]}`)
		capturePath := captureRewriteGH(t)
		args := []string{"api", "graphql", "--hostname", "github.com", "-f", "query=query { viewer { login } }"}
		if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("rewritten API host error=%v", err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("rewritten API host reached child")
		}
	})
}

func TestStringRewriteProcessBlocks(t *testing.T) {
	if message := errRewriteBlocked.Error(); message != "string rewrite protection blocked unsafe input" || strings.Contains(message, "internal-model") {
		t.Fatalf("denial is not generic: %q", message)
	}
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, args := range [][]string{
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "-Fbody=b"},
		{"api", "repos/acme/repo/issues/1/comments", "-Fbody=false"},
		{"api", "repos/acme/repo/issues/1/comments", "-Fbody=null"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--input=-"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--hostname=other.example"},
		{"api", "https://example.com/repos/acme/repo", "--hostname", "github.com"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "--header=Authorization: unsafe"},
		{"api", "repos/acme/repo/issues/1/comments", "-Fbody={branch}"},
		{"api", "repos/acme/repo/pulls/1/reviews", "-Fcomments[0][body]=safe"},
		{"api", "repos/acme/repo/issues/1/comments", "-fbody=a", "-funknown=value"},
		{"api", "repos/acme/%69nternal-model"},
		{"api", "repos/acme/repo/issues?q=%2569nternal-model"},
		{"pr", "view", "1", "--repo", "https://example.com/acme/repo", "--json", "number"},
		{"repo", "view", "https://ghe.example/acme/repo", "--json", "nameWithOwner"},
		{"pr", "view", "1", "--json", "number,internal-model", "-Racme/repo"},
		{"pr", "list", "--head", "internal-model", "-Racme/repo"},
		{"pr", "ready", "internal-model", "-Racme/repo"},
		{"pr", "ready", "https://github.com/other/repo/pull/1", "-Racme/repo"},
		{"pr", "ready", "github.com/other/repo/pull/1", "-Racme/repo"},
		{"pr", "merge", "1", "-Racme/repo", "--squash", "--subject", "safe", "-tother", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/repo", "--auto", "--squash", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/repo", "--squash", "--match-head-commit", "short"},
		{"pr", "merge", "topic", "-Racme/repo", "--squash", "--subject=safe", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "https://github.com/acme/repo/pull/1", "-Racme/repo", "--squash", "--subject=safe", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Rhttps://example.com/acme/repo", "--squash", "--subject=safe", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/internal-model", "--squash", "--subject=safe", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/repo", "--subject=safe", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/repo", "--squash", "--subject=safe", "--body=inline", "--match-head-commit", strings.Repeat("a", 40)},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=short", "-f", "merge_method=squash"},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=" + strings.Repeat("a", 40), "-f", "merge_method=merge"},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=" + strings.Repeat("a", 40), "-f", "merge_method=squash", "-F", "commit_title=false"},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=" + strings.Repeat("a", 40), "-f", "merge_method=squash", "-f", "commit_title=safe", "-f", "commit_title=other"},
		{"api", "repos/acme/internal-model/pulls/1/merge", "--method", "PUT", "-f", "sha=" + strings.Repeat("a", 40), "-f", "merge_method=squash"},
		{"pr", "edit", "1", "-Racme/repo", "--add-assignee", "internal-model"},
		{"issue", "create", "-Racme/repo", "--title", "safe", "--body", "safe", "--label", "internal-model"},
		{"issue", "create", "-Racme/repo", "--title", "safe", "--body", "safe", "--label", ",bug"},
		{"issue", "create", "-Racme/repo", "--title", "safe", "--body", "safe", "--label", "bug", "-l", "enhancement"},
		{"issue", "edit", "1", "-Racme/repo", "--add-label", "internal-model"},
		{"issue", "create", "-Racme/repo", "--title", "safe", "--body", "safe", "--assignee", "internal-model"},
		{"issue", "create", "-Racme/repo", "--title", "safe", "--body", "safe", "--assignee", "@other"},
		{"issue", "create", "-Racme/repo", "--title", "safe", "--body", "safe", "--assignee", "steipete", "-a", "@me"},
		{"api", "repos/acme/repo/issues/1/assignees", "--method", "POST", "-f", "assignees[]=internal-model"},
		{"api", "repos/acme/repo/issues/1/assignees", "--method", "POST", "-f", "assignees=alice", "-f", "assignees[]=bob"},
		{"api", "repos/acme/repo/issues/1/assignees", "--method", "POST", "-f", "labels[]=safe"},
	} {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			capture := captureRewriteGH(t)
			err := execRealGHWithStdin(t.Context(), args, strings.NewReader(`{"body":"safe"}`), io.Discard, io.Discard)
			if err != errRewriteBlocked {
				t.Fatalf("expected generic block, got %v for %v", err, args)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("blocked command executed")
			}
		})
	}
	for _, raw := range []string{`{"body":"safe","\u0062ody":"internal-model"}`, `{"body":"\ud800"}`, `{"body":"internal-model","unknown":"x"}`, `{"body":false}`, `{"body":"` + string([]byte{255}) + `"}`, `[]`} {
		capture := captureRewriteGH(t)
		err := execRealGHWithStdin(t.Context(), []string{"api", "repos/acme/repo/issues/1/comments", "--input=-"}, strings.NewReader(raw), io.Discard, io.Discard)
		if err != errRewriteBlocked {
			t.Fatalf("invalid JSON error=%v", err)
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatal("invalid JSON reached child")
		}
	}
	policy.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"a*","replacement":"b"}]}`)
	capture := captureRewriteGH(t)
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); !errors.Is(err, errRewritePolicy) {
		t.Fatalf("invalid policy: %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("invalid policy reached child")
	}
}
func TestStringRewriteFreshLocalMergeAndExit(t *testing.T) {
	policy, calls := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	args := []string{"issue", "edit", "1", "--body=internal-model", "-Racme/repo"}
	capture := captureRewriteGH(t)
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	policy.Store(strings.Replace(rewriteActiveTestPolicy, `"public"`, `"fresh"`, 1))
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	for _, content := range readRewriteCapture(t, capture).Files {
		if content != "fresh" {
			t.Fatal("stale policy")
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("policy calls=%d", calls.Load())
	}
	local := filepath.Join(t.TempDir(), "local.json")
	if err := os.WriteFile(local, []byte(`{"schema_version":1,"rules":[{"pattern":"fresh","replacement":"approved"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", local)
	t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "7")
	var out, stderr bytes.Buffer
	err := execRealGH(t.Context(), args, &out, &stderr)
	var exit exitCodeError
	if !errors.As(err, &exit) || exit.Code != 7 {
		t.Fatalf("exit=%v", err)
	}
	if out.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
		t.Fatal("child streams changed")
	}
	for _, content := range readRewriteCapture(t, capture).Files {
		if content != "approved" {
			t.Fatal("server/local order wrong")
		}
	}
}
func TestStringRewriteEveryFallbackBoundary(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request["path"] != "/repos/acme/repo" {
			t.Error("unexpected normalized read path")
		}
		writeCLIFallback(t, w, "route_denied")
	})
	for _, entry := range []struct {
		name   string
		invoke func(context.Context, []string) error
	}{
		{"exec", func(ctx context.Context, args []string) error { return execRealGH(ctx, args, io.Discard, io.Discard) }},
		{"stdin", func(ctx context.Context, args []string) error {
			return execRealGHWithStdin(ctx, args, strings.NewReader(""), io.Discard, io.Discard)
		}},
		{"environment", func(ctx context.Context, args []string) error {
			return execRealGHWithStdinAndEnv(ctx, args, strings.NewReader(""), io.Discard, io.Discard, os.Environ())
		}},
		{"fallback", func(ctx context.Context, args []string) error {
			return execRealGHAfterLocalFallback(ctx, args, io.Discard, io.Discard, localFallbackError{Reason: "test"})
		}},
		{"runGH", func(ctx context.Context, args []string) error { return runGH(ctx, args, io.Discard, io.Discard) }},
	} {
		t.Run(entry.name, func(t *testing.T) {
			capture := captureRewriteGH(t)
			if err := entry.invoke(t.Context(), []string{"api", "repos/acme/repo"}); err != nil {
				t.Fatal(err)
			}
			readRewriteCapture(t, capture)
			if err := os.Remove(capture); err != nil {
				t.Fatal(err)
			}
			if err := entry.invoke(t.Context(), []string{"api", "repos/acme/internal-model"}); err == nil {
				t.Fatal("unsafe fallback accepted")
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unsafe fallback executed")
			}
		})
	}
}

func TestStringRewriteRawReleaseRequiresExistingTag(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capture := captureRewriteGH(t)
	args := []string{"api", "repos/acme/repo/releases", "-ftag_name=v1", "-fname=internal-model", "-fbody=internal-model", "-Fdraft=true"}
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	got := readRewriteCapture(t, capture)
	for _, body := range got.Files {
		if body != `{"body":"public","draft":true,"name":"public","tag_name":"v1"}` {
			t.Fatalf("release body=%q", body)
		}
	}
	t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "4")
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
		t.Fatalf("missing tag error=%v", err)
	}
	got = readRewriteCapture(t, capture)
	if len(got.Args) < 2 || got.Args[1] != "/repos/acme/repo/git/ref/tags/v1" || len(got.Files) != 0 {
		t.Fatalf("mutation ran after tag probe failed: %v", got.Args)
	}
}

func TestStringRewriteRelayReadAndAuthFailure(t *testing.T) {
	for _, code := range []int{200, 401} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			var relays atomic.Int64
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				relays.Add(1)
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["method"] != "GET" || body["path"] != "/repos/acme/repo" {
					t.Error("incorrect read dispatch")
				}
				if code == 401 {
					w.WriteHeader(401)
					_, _ = io.WriteString(w, `{"error":{"code":"invalid_auth","message":"expired"}}`)
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"name": "repo"})
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), []string{"api", "repos/acme/repo"}, &out, io.Discard)
			if (err != nil) != (code == 401) {
				t.Fatalf("error=%v", err)
			}
			if code == 200 && out.String() != `{"name":"repo"}`+"\n" {
				t.Fatalf("output=%q", out.String())
			}
			if relays.Load() != 1 {
				t.Fatal("read did not use relay")
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("relay auth error/success ran a child")
			}
		})
	}
}

func TestStringRewriteReadOptionOccurrences(t *testing.T) {
	for _, test := range []struct {
		name  string
		args  []string
		want  string
		label any
	}{
		{"control_single_json", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number,title"}, `{"number":7,"title":"synthetic"}`, nil},
		{"regression_repeated_json", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number", "--json=title"}, `{"number":7,"title":"synthetic"}`, nil},
		{"regression_repeated_labels", []string{"issue", "list", "-R", "acme/repo", "--label", `"bug"`, "--label=docs", "--json", "number"}, `[{"number":7}]`, "bug,docs"},
		{"regression_repeated_limit", []string{"pr", "list", "-R", "acme/repo", "--limit=0", "--limit=2", "--json", "number"}, `[{"number":7}]`, nil},
		{"regression_top_last_jq", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number,title", "--jq", "(", "--jq=.number"}, "7", nil},
		{"regression_api_last_jq", []string{"api", "repos/acme/repo", "--jq", "(", "--jq=.number"}, "7", nil},
		{"regression_api_empty_last_jq", []string{"api", "repos/acme/repo", "--jq", "(", "--jq="}, `{"number":7,"title":"synthetic"}`, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			if strings.Contains(test.name, "jq") && !jqAvailable() {
				t.Skip("jq not installed")
			}
			var requests []map[string]any
			_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				req := decodeCLIRequest(t, w, r)
				requests = append(requests, req)
				if test.args[0] == "api" {
					writeCLIEnvelope(t, w, map[string]any{"number": 7, "title": "synthetic"})
					return
				}
				writeCLIEnvelope(t, w, nativeOptionsResponse(t, req))
			})
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), test.args, &out, io.Discard)
			_, childErr := os.Stat(capture)
			if err != nil || strings.TrimSpace(out.String()) != test.want || len(requests) != 1 || policies.Load() != 2 || !os.IsNotExist(childErr) {
				t.Fatalf("err=%v output=%q want=%q data=%d policy=%d child=%v", err, out.String(), test.want, len(requests), policies.Load(), childErr)
			}
			if test.label != nil && requests[0]["query"].(map[string]any)["labels"] != test.label {
				t.Fatalf("labels=%v", requests[0]["query"])
			}
		})
	}
}

func TestStringRewriteRepoViewPositionalPin(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq not installed")
	}
	for _, test := range []struct {
		name     string
		repoArgs []string
		envRepo  string
		gitRepo  bool
		blocked  bool
	}{
		{"positional", []string{"https://github.com/acme/repo"}, "", false, false},
		{"environment", nil, "acme/repo", false, false},
		{"current_fixture", nil, "", true, false},
		{"shim_repo", []string{"--repo", "https://github.com/acme/repo"}, "", false, false},
		{"shim_attached_repo", []string{"-Racme/repo"}, "", false, false},
		{"empty_shim_repo", []string{"--repo="}, "acme/repo", false, false},
		{"conflicting_positional", []string{"--repo=acme/other", "acme/repo"}, "", false, true},
		{"enterprise_repo", []string{"--repo=https://other.example/acme/repo"}, "", false, true},
		{"original_material", []string{"--repo=internal-model/repo", "--repo=acme/repo"}, "", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := 0
			_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				data++
				req := decodeCLIRequest(t, w, r)
				if req["method"] != "GET" || req["path"] != "/repos/acme/repo" {
					t.Errorf("wrong resolved repository: %v", req)
				}
				writeCLIFallback(t, w, "route_denied")
			})
			t.Setenv("GH_REPO", test.envRepo)
			t.Setenv("GH_HOST", "other.example")
			fixture := t.TempDir()
			t.Chdir(fixture)
			if test.gitRepo {
				for _, args := range [][]string{{"init", "--quiet", fixture}, {"-C", fixture, "remote", "add", "origin", "https://github.com/acme/repo"}} {
					if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
						t.Fatalf("synthetic repository setup: %v: %s", err, out)
					}
				}
			}
			capturePath := captureRewriteGH(t)
			options := []string{"--json", `"name"`, "--json=url", "--jq", "(", "--jq=.name"}
			args := append([]string{"repo", "view"}, test.repoArgs...)
			args = append(args, options...)
			var out bytes.Buffer
			err := runGH(t.Context(), args, &out, io.Discard)
			if test.blocked {
				if err != errRewriteBlocked || data != 0 || policies.Load() != 1 || out.Len() != 0 {
					t.Fatalf("strict repo boundary: err=%v data=%d policies=%d output=%q", err, data, policies.Load(), out.String())
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("denied repo view ran native child")
				}
				return
			}
			if err != nil || data != 1 || policies.Load() != 3 || out.String() != "child stdout\n" {
				t.Fatalf("repo handoff: err=%v data=%d policies=%d output=%q", err, data, policies.Load(), out.String())
			}
			capture := readRewriteCapture(t, capturePath)
			want := append([]string{"repo", "view", "acme/repo"}, options...)
			if !slices.Equal(capture.Args, want) || capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" || capture.Stdin != "" {
				t.Fatalf("native repo-view positional pin/raw options: got=%+v want=%q", capture, want)
			}
		})
	}
}

func TestStringRewriteAttachedReadAliases(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq not installed")
	}
	for _, policy := range []struct{ name, body string }{{"active", rewriteActiveTestPolicy}, {"empty", rewriteEmptyTestPolicy}} {
		for _, test := range []struct {
			name, want, limit string
			args              []string
		}{
			{"limit", `[{"number":7}]`, "5", []string{"pr", "list", "-R", "acme/repo", "-L5", "--json=number"}},
			{"jq", "7", "", []string{"pr", "view", "7", "-R", "acme/repo", "--json=number", "-q.number"}},
			{"repo", `{"number":7}`, "", []string{"pr", "view", "7", "-Racme/repo", "--json=number"}},
			{"equals_control", "7", "5", []string{"pr", "list", "-R=acme/repo", "-L=5", "--json=number", "-q=.[0].number"}},
		} {
			t.Run(policy.name+"/"+test.name, func(t *testing.T) {
				var requests []map[string]any
				_, policies := rewriteTestServer(t, policy.body, func(w http.ResponseWriter, r *http.Request) {
					req := decodeCLIRequest(t, w, r)
					requests = append(requests, req)
					writeCLIEnvelope(t, w, nativeOptionsResponse(t, req))
				})
				capture := captureRewriteGH(t)
				var out bytes.Buffer
				err := runGH(t.Context(), test.args, &out, io.Discard)
				_, childErr := os.Stat(capture)
				if err != nil || strings.TrimSpace(out.String()) != test.want || len(requests) != 1 || policies.Load() != 2 || !os.IsNotExist(childErr) {
					t.Fatalf("attached read: err=%v output=%q data=%d policies=%d child=%v", err, out.String(), len(requests), policies.Load(), childErr)
				}
				if test.limit != "" && requests[0]["query"].(map[string]any)["per_page"] != test.limit {
					t.Fatalf("attached limit lost: query=%v", requests[0]["query"])
				}
			})
		}
	}
}

func TestStringRewriteOptionNativeArgv(t *testing.T) {
	for _, test := range []struct {
		name       string
		args       []string
		active     bool
		relay      bool
		noFallback bool
	}{
		{"control_unsupported_field_original", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "bogus", "--json=number"}, true, false, false},
		{"control_active_empty_repo_pin", []string{"pr", "view", "7", "--repo=", "--json=bogus"}, true, false, false},
		{"regression_unrepresentable_label", []string{"issue", "list", "-R", "acme/repo", "--label", `"a,b"`, "--json=number"}, false, false, false},
		{"regression_active_unrepresentable_label", []string{"issue", "list", "-R", "acme/repo", "--label", `"a,b"`, "--json=number"}, true, false, false},
		{"control_active_repeated_unrepresentable_label", []string{"issue", "list", "-R", "acme/repo", "--label", "bug", "--label", `"a,b"`, "--json=number"}, true, false, false},
		{"control_direct_cap_no_fallback", []string{"pr", "list", "-R", "acme/repo", "--limit=101", "--json=number"}, false, false, true},
		{"control_attached_cap_raw_argv", []string{"pr", "list", "-R", "acme/repo", "-L101", "--json=number", "-q.[].number"}, true, false, false},
		{"control_search_issues_label_handoff", []string{"search", "issues", "bug", "-R", "acme/repo", "--json=number", "--label", `"a,b"`}, true, false, false},
		{"control_search_prs_label_handoff", []string{"search", "prs", "bug", "-R", "acme/repo", "--json=number", "--label", `"a,b"`}, true, false, false},
		{"control_issue_label_direct_no_fallback", []string{"issue", "list", "-R", "acme/repo", "--json=number", "--label", `"a,b"`}, false, false, true},
		{"control_typed_no_fallback", []string{"pr", "view", "7", "-R", "acme/repo", "--json=number"}, false, true, true},
		{"regression_api_jq_fallback_original", []string{"api", "repos/acme/repo", "--jq", ".title", "-q", ".number"}, true, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := rewriteEmptyTestPolicy
			t.Setenv("GH_REPO", "acme/repo")
			if test.active {
				policy = rewriteActiveTestPolicy
			}
			data := 0
			_, policies := rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) { data++; writeCLIFallback(t, w, "route_denied") })
			capturePath := captureRewriteGH(t)
			if test.noFallback {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			var out bytes.Buffer
			err := runGH(t.Context(), test.args, &out, io.Discard)
			wantData := 0
			if test.relay {
				wantData = 1
			}
			if test.noFallback && test.relay {
				if err == nil || out.Len() != 0 || data != 1 || policies.Load() != 2 {
					t.Fatalf("typed fallback escaped: err=%v data=%d policy=%d output=%q", err, data, policies.Load(), out.String())
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("typed NO_FALLBACK ran child")
				}
				return
			}
			if err != nil || data != wantData || policies.Load() != int64(2+wantData) {
				t.Fatalf("err=%v data=%d want=%d policy=%d", err, data, wantData, policies.Load())
			}
			capture := readRewriteCapture(t, capturePath)
			// Repository/hostname pins are allowed; every other original occurrence stays in order and spelling.
			stripPins := func(args []string) []string {
				var result []string
				for i := 0; i < len(args); i++ {
					arg := args[i]
					if arg == "-R" || arg == "--repo" || arg == "--hostname" {
						i++
						continue
					}
					if strings.HasPrefix(arg, "--repo=") || strings.HasPrefix(arg, "--hostname=") || arg == "--method=GET" {
						continue
					}
					result = append(result, arg)
				}
				return result
			}
			if !slices.Equal(stripPins(capture.Args), stripPins(test.args)) {
				t.Fatalf("native argv=%q original=%q", capture.Args, test.args)
			}
			if test.active && (capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "") {
				t.Fatalf("unpinned child env=%v", capture.Env)
			}
			if test.active && test.args[0] != "api" && !slices.Contains(capture.Args, "--repo=acme/repo") {
				t.Fatalf("missing explicit repository pin: %v", capture.Args)
			}
		})
	}
}

func TestStringRewriteSearchFilterNoFallback(t *testing.T) {
	for _, kind := range []string{"issues", "prs"} {
		for _, flag := range []string{"--author", "--assignee", "--label"} {
			values := []string{"", "alice"}
			if flag == "--label" {
				values = append(values, `"a,b"`, "a,,b", `""`, "\"a\r\nb\"")
			}
			for _, value := range values {
				t.Run(kind+"/"+flag+"/value="+value, func(t *testing.T) {
					data := 0
					_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) { data++ })
					t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
					capture := captureRewriteGH(t)
					var out bytes.Buffer
					err := runGH(t.Context(), []string{"search", kind, "bug", "-R", "acme/repo", "--json=number", flag, value}, &out, io.Discard)
					if !isLocalFallback(err) || data != 0 || policies.Load() != 1 || out.Len() != 0 {
						t.Fatalf("typed filter fallback changed: err=%v data=%d policies=%d output=%q", err, data, policies.Load(), out.String())
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("NO_FALLBACK filter ran native child")
					}
				})
			}
		}
	}
}

func TestStringRewriteOptionStrictControls(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
	}{
		{"publication_duplicate_label", []string{"issue", "create", "-R", "acme/repo", "--title=safe", "--body=safe", "--label=bug", "--label=docs"}},
		{"api_duplicate_method", []string{"api", "repos/acme/repo", "--method=GET", "-X", "GET"}},
		{"api_duplicate_input", []string{"api", "repos/acme/repo/issues/7/comments", "--input=-", "--input=-"}},
		{"api_duplicate_field", []string{"api", "repos/acme/repo/issues/7/comments", "-fbody=a,b", "-fbody=c"}},
		{"api_credential_header", []string{"api", "repos/acme/repo", "-H", "Authorization: synthetic"}},
		{"original_repo_host", []string{"pr", "view", "7", "--repo", "https://other.example/acme/repo", "--repo", "acme/repo", "--json=number"}},
		{"original_csv_ignored_record", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number\nignored"}},
		{"original_policy_material", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "number\n" + `{"pattern":"internal-model","replacement":"public"}`}},
		{"search_issues_original_label_newline", []string{"search", "issues", "bug", "-R", "acme/repo", "--json=number", "--label", "\"a\r\nb\""}},
		{"search_prs_original_label_newline", []string{"search", "prs", "bug", "-R", "acme/repo", "--json=number", "--label", "\"a\r\nb\""}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capture := captureRewriteGH(t)
			var out bytes.Buffer
			err := runGH(t.Context(), test.args, &out, io.Discard)
			if err != errRewriteBlocked || out.Len() != 0 {
				t.Fatalf("strict boundary: err=%v output=%q", err, out.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("strict denial ran child")
			}
		})
	}
}

func TestStringRewritePRWatchPolicyFloor(t *testing.T) {
	const active = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"watch-policy-canary","replacement":"safe"}]}`
	const residualFive = `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^5$","replacement":"5"}]}`
	const forbiddenThirty = `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^30$","replacement":"5"}]}`
	const material = `{"pattern":"watch-policy-canary","replacement":"safe"}`
	for _, test := range []struct {
		name       string
		flags      []string
		want       []string
		first      string
		final      string
		finalCode  int
		wantErr    error
		noFallback bool
	}{
		{
			name:  "active_nonmatching_floor",
			flags: []string{"--watch", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "30"},
		},
		{
			name: "direct_no_fallback_still_floors", noFallback: true,
			flags: []string{"--watch", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "30"},
		},
		{
			name:  "default_interval",
			flags: []string{"--watch"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "30"},
		},
		{
			name:  "default_before_real_terminator",
			flags: []string{"--watch", "--", "-i5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "30", "--", "-i5"},
		},
		{
			name:  "only_final_interval_changes",
			flags: []string{"--watch", "--interval", "5", "-i6"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "5", "-i30"},
		},
		{
			name:  "native_only_short_web_false",
			flags: []string{"--watch", "-w=false", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "-w=false", "--interval", "30"},
		},
		{
			name: "original_residual_blocks", first: residualFive, final: residualFive, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--interval", "5"},
		},
		{
			name: "fresh_final_residual_blocks", final: residualFive, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--interval", "5"},
		},
		{
			name: "final_policy_unavailable", finalCode: http.StatusServiceUnavailable, wantErr: errRewritePolicy,
			flags: []string{"--watch", "--interval", "5"},
		},
		{
			name: "overwritten_original_residual_blocks", first: residualFive, final: residualFive, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--interval", "5", "-i6"},
		},
		{
			name: "original_owned_rule_material_blocks", wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--interval", "5", "--template", material},
		},
		{
			name: "generated_floor_policy_conflict", final: forbiddenThirty, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--interval", "5"},
		},
		{
			name: "generated_attached_short_floor_policy_conflict", final: forbiddenThirty, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "-i5"},
		},
		{
			name: "generated_attached_long_floor_policy_conflict", final: forbiddenThirty, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--interval=5"},
		},
		{
			name:    "generated_default_flag_policy_conflict",
			final:   `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^--interval$","replacement":"--template"}]}`,
			wantErr: errRewriteBlocked,
			flags:   []string{"--watch"},
		},
		{
			name:  "rewritten_valid_interval_stays_above_floor",
			final: `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^5$","replacement":"40"}]}`,
			flags: []string{"--watch", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "40"},
		},
		{
			name:  "rewritten_interval_option_does_not_gain_default",
			final: `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^--interval$","replacement":"--template"}]}`,
			flags: []string{"--watch", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--template", "5"},
		},
		{
			// Empty P1 reaches ghDelegate; final P2 must still see the original 5.
			name: "lower_handoff_fresh_final_residual", first: rewriteEmptyTestPolicy, final: residualFive, wantErr: errRewriteBlocked,
			flags: []string{"--watch", "--required", "--interval", "5"},
		},
		{
			name: "lower_handoff_nonmatching_control", first: rewriteEmptyTestPolicy,
			flags: []string{"--watch", "--required", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--required", "--interval", "30"},
		},
		{
			name: "empty_policy_control", first: rewriteEmptyTestPolicy, final: rewriteEmptyTestPolicy,
			flags: []string{"--watch", "--required", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "acme/repo", "--watch", "--required", "--interval", "30"},
		},
		{
			name:  "invalid_earlier_integer_not_repaired",
			flags: []string{"--watch", "--interval", "08", "-i5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "08", "-i5"},
		},
		{
			name:  "final_duration_overflow_not_repaired",
			flags: []string{"--watch", "--interval", "9223372037"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "9223372037"},
		},
		{
			name:  "unknown_grammar_not_repaired",
			flags: []string{"--watch", "--future", "-i5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--future", "-i5"},
		},
		{
			name:  "short_cluster_not_repaired",
			flags: []string{"--watch", "-wf", "-i5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "-wf", "-i5"},
		},
		{
			name:  "false_watch_not_repaired",
			flags: []string{"--watch=false", "-i5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch=false", "-i5"},
		},
		{
			name:  "owned_watch_value_not_repaired",
			flags: []string{"--template", "--watch", "--interval", "5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--template", "--watch", "--interval", "5"},
		},
		{
			name:  "terminator_watch_text_not_repaired",
			flags: []string{"--watch=false", "--", "--watch", "-i5"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch=false", "--", "--watch", "-i5"},
		},
		{
			name:  "rewritten_invalid_original_does_not_gain_floor",
			final: `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^08$","replacement":"5"}]}`,
			flags: []string{"--watch", "--interval", "08"},
			want:  []string{"pr", "checks", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "5"},
		},
		{
			name:  "rewritten_command_does_not_gain_floor",
			final: `{"schema_version":1,"revision":2,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"^checks$","replacement":"view"}]}`,
			flags: []string{"--watch", "--interval", "5"},
			want:  []string{"pr", "view", "7", "-R", "github.com/acme/repo", "--watch", "--interval", "5"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			first, final := test.first, test.final
			if first == "" {
				first = active
			}
			if final == "" {
				final = active
			}
			var data atomic.Int64
			policies := rewriteTestServerPolicySequence(t, func(ordinal int64) (string, int) {
				if ordinal == 1 {
					return first, http.StatusOK
				}
				if ordinal != 2 {
					t.Error("unexpected extra policy read")
					return "", http.StatusServiceUnavailable
				}
				if test.finalCode != 0 {
					return "", test.finalCode
				}
				return final, http.StatusOK
			}, func(w http.ResponseWriter, r *http.Request) {
				data.Add(1)
				t.Error("native watch unexpectedly dispatched relay data")
				w.WriteHeader(http.StatusBadRequest)
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if test.noFallback {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "acme/inherited")
			capturePath := captureRewriteGH(t)
			input, err := os.Open(os.DevNull)
			if err != nil {
				t.Fatal(err)
			}
			saved := os.Stdin
			os.Stdin = input
			defer func() { os.Stdin = saved; input.Close() }()
			args := append([]string{"pr", "checks", "7", "-R", "acme/repo"}, test.flags...)
			original := append([]string(nil), args...)
			var stdout, stderr bytes.Buffer
			err = runGH(t.Context(), args, &stdout, &stderr)
			_, childErr := os.Stat(capturePath)
			childCount := strings.Count(stdout.String(), "child stdout\n")
			t.Logf("boundary: policies=%d data=%d child=%d err=%v stdout=%q stderr=%q", policies.Load(), data.Load(), childCount, err, stdout.String(), stderr.String())
			if !slices.Equal(args, original) {
				t.Error("caller argv mutated")
			}
			if policies.Load() != 2 || data.Load() != 0 {
				t.Errorf("policy/data counts=%d/%d, want 2/0", policies.Load(), data.Load())
			}
			if test.wantErr != nil {
				if childErr == nil {
					t.Logf("unexpected child argv=%q", readRewriteCapture(t, capturePath).Args)
				}
				if !errors.Is(err, test.wantErr) || !os.IsNotExist(childErr) || stdout.Len() != 0 || stderr.Len() != 0 {
					t.Errorf("policy must stop native child: want err=%v and no child/output", test.wantErr)
				}
				if strings.Contains(stdout.String()+stderr.String(), material) || (err != nil && strings.Contains(err.Error(), material)) {
					t.Error("rejected policy material echoed")
				}
				return
			}
			if err != nil || childCount != 1 || stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
				t.Fatalf("native child markers/result changed: err=%v", err)
			}
			capture := readRewriteCapture(t, capturePath)
			wantRepo := ""
			if final == rewriteEmptyTestPolicy {
				wantRepo = "acme/inherited"
			}
			if capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != wantRepo || capture.Stdin != "" || len(capture.Files) != 0 || len(capture.FileData) != 0 {
				t.Errorf("native environment/stdin/snapshots changed: %+v", capture)
			}
			if !slices.Equal(capture.Args, test.want) {
				t.Errorf("watch floor/value ownership: native argv=%q, want=%q", capture.Args, test.want)
			}
		})
	}
}

func TestStringRewritePrivateRunWatchFallback(t *testing.T) {
	for _, test := range []struct {
		name, reason string
		noFallback   bool
		inferredRepo bool
	}{
		{name: "private_repo_handoff", reason: "repo_not_public"},
		{name: "typed_no_fallback", reason: "repo_not_public", noFallback: true},
		{name: "other_refusal_stays_on_relay", reason: "pagination_exhausted"},
		{name: "inferred_repo_survives_context_change", reason: "repo_not_public", inferredRepo: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			sleeps := recordWatchSleeps(t)
			relayCalls := 0
			_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				relayCalls++
				request := decodeCLIRequest(t, w, r)
				if request["path"] != "/repos/acme/repo/actions/runs/42" {
					t.Error("unexpected watch path")
				}
				if test.inferredRepo {
					// The initial t.Setenv owns cleanup of this synthetic context.
					if err := os.Setenv("GH_REPO", "acme/changed"); err != nil {
						t.Error(err)
					}
				}
				writeCLIFallback(t, w, test.reason)
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			if test.noFallback {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "acme/inherited")
			capture := captureRewriteGH(t)
			input, err := os.Open(os.DevNull)
			if err != nil {
				t.Fatal(err)
			}
			saved := os.Stdin
			os.Stdin = input
			defer func() { os.Stdin = saved; input.Close() }()
			args := []string{"run", "watch", "42", "-Racme/repo", "-i5", "--exit-status"}
			if test.inferredRepo {
				t.Setenv("GH_REPO", "acme/repo")
				args = []string{"run", "watch", "42", "-i5", "--exit-status"}
			}
			original := append([]string(nil), args...)
			var stdout, stderr bytes.Buffer
			err = runGH(t.Context(), args, &stdout, &stderr)
			t.Logf("boundary: policies=%d data=%d child=%d err=%v stdout=%q stderr=%q", policies.Load(), relayCalls, strings.Count(stdout.String(), "child stdout\n"), err, stdout.String(), stderr.String())
			if relayCalls != 1 || len(*sleeps) != 0 || !slices.Equal(args, original) {
				t.Fatalf("initial lookup ownership changed: data=%d sleeps=%v caller=%q", relayCalls, *sleeps, args)
			}
			if test.noFallback || test.reason != "repo_not_public" {
				_, childErr := os.Stat(capture)
				if err == nil || isLocalFallback(err) != test.noFallback || policies.Load() != 2 || !os.IsNotExist(childErr) || stdout.Len() != 0 || stderr.Len() != 0 {
					t.Fatalf("run-watch refusal ownership changed: err=%v policies=%d child=%v stdout=%q stderr=%q", err, policies.Load(), childErr, stdout.String(), stderr.String())
				}
				return
			}
			if err != nil || policies.Load() != 3 || stdout.String() != "child stdout\n" || stderr.String() != "octopool: octopool requested local gh fallback: repo_not_public; falling back to real gh\nchild stderr\n" {
				t.Fatalf("private watch handoff changed: err=%v policies=%d stdout=%q stderr=%q", err, policies.Load(), stdout.String(), stderr.String())
			}
			want := []string{"run", "watch", "42", "--repo=acme/repo", "-i30", "--exit-status"}
			if test.inferredRepo {
				want = []string{"run", "watch", "42", "-i30", "--exit-status", "--repo=acme/repo"}
				if os.Getenv("GH_REPO") != "acme/changed" {
					t.Error("synthetic repository context did not change")
				}
			}
			got := readRewriteCapture(t, capture)
			if !slices.Equal(got.Args, want) || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" || got.Stdin != "" || len(got.Files) != 0 {
				t.Fatalf("native watch args=%q env=%v stdin=%q files=%v", got.Args, got.Env, got.Stdin, got.Files)
			}
		})
	}
}

func TestStringRewriteRunWatchKeepsRelayOwnership(t *testing.T) {
	recordWatchSleeps(t)
	for _, failAt := range []int{1, 2, 3} {
		t.Run(strconv.Itoa(failAt), func(t *testing.T) {
			calls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
				}
				calls++
				wantPath := "/repos/acme/repo/actions/runs/42"
				if calls == 3 {
					wantPath += "/attempts/2/jobs"
				}
				if request["path"] != wantPath {
					t.Errorf("path=%v want=%s", request["path"], wantPath)
				}
				if calls == failAt {
					writeCLIFallback(t, w, "pagination_exhausted")
					return
				}
				writeCLIEnvelope(t, w, map[string]any{"status": "completed", "conclusion": "success", "run_attempt": 2})
			})
			t.Setenv("OCTOPOOL_GH_PATH", fakeGHExit(t, 0))
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), []string{"run", "watch", "42", "-Racme/repo", "-i120", "--exit-status", "--compact"}, &stdout, &stderr)
			if err == nil || shouldRunRealGH(err) || calls != failAt || strings.Contains(stdout.String(), fakeGHArgvPrefix) {
				t.Fatalf("calls=%d err=%v stdout=%q stderr=%q", calls, err, stdout.String(), stderr.String())
			}
		})
	}
}

func TestStringRewriteActivePRHydrationAndPaginationFallback(t *testing.T) {
	t.Run("hydration", func(t *testing.T) {
		paths := []string{}
		rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			path, _ := request["path"].(string)
			paths = append(paths, path)
			switch path {
			case "/repos/acme/repo/pulls/1":
				writeCLIEnvelope(t, w, map[string]any{"number": 1, "head": map[string]any{"sha": "0123456789abcdef0123456789abcdef01234567"}})
			case "/repos/acme/repo/pulls/1/files":
				writeCLIEnvelope(t, w, []map[string]any{{"filename": "safe.go", "status": "added", "additions": 1, "deletions": 0}})
			default:
				t.Error("unexpected hydration path")
				w.WriteHeader(400)
			}
		})
		capture := captureRewriteGH(t)
		var out bytes.Buffer
		if err := runGH(t.Context(), []string{"pr", "view", "1", "-Racme/repo", "--json=number,files"}, &out, io.Discard); err != nil {
			t.Fatal(err)
		}
		if len(paths) != 3 || !strings.Contains(out.String(), "safe.go") {
			t.Fatalf("hydration paths=%v output=%q", paths, out.String())
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatal("hydration unexpectedly delegated")
		}
	})
	t.Run("pagination", func(t *testing.T) {
		var relays atomic.Int64
		rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
			relays.Add(1)
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if request["path"] != "/repos/acme/repo/issues" {
				t.Error("unexpected page path")
			}
			writeCLIEnvelope(t, w, []int{1})
		})
		capture := captureRewriteGH(t)
		if err := runGH(t.Context(), []string{"api", "repos/acme/repo/issues?per_page=1", "--paginate"}, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		if relays.Load() != maxRelayPages {
			t.Fatalf("page requests=%d", relays.Load())
		}
		got := readRewriteCapture(t, capture)
		if !strings.Contains(strings.Join(got.Args, " "), "--paginate") {
			t.Fatal("pagination fallback lost arguments")
		}
	})
}
