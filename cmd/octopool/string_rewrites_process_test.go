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
	for _, arg := range args {
		paths := []string{}
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
	calls := &atomic.Int64{}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("incorrect caller auth")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/pools/maintainers/string-rewrites" {
			calls.Add(1)
			if r.Method != "GET" || r.Header.Get("Cache-Control") != "no-cache, no-store" {
				t.Error("incorrect policy method/cache")
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, body.Load().(string))
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
	return body, calls
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
	args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body-file", body, "--attach", image + "#internal-model screenshot", "--attach=" + video}
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
	aliasArgs := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "safe", "--attach", alias}
	if err := execRealGH(t.Context(), aliasArgs, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	aliasCapture := readRewriteCapture(t, aliasCapturePath)
	if !rewriteCaptureHasData(aliasCapture, imageData) || slices.ContainsFunc(aliasCapture.Args, func(arg string) bool { return strings.Contains(arg, alias) }) {
		t.Fatalf("symlink attachment was not privately snapshotted: %+v", aliasCapture)
	}

	createCapturePath := captureRewriteGH(t)
	createArgs := []string{"pr", "create", "--repo", "acme/repo", "--title", "safe", "--body", "safe", "--head", "feature", "--base", "main", "--attach", image}
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
	attachmentOnlyArgs := []string{"pr", "comment", "1", "--repo", "acme/repo", "--attach", image}
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
	editArgs := []string{"pr", "comment", "1", "--repo", "acme/repo", "--edit-last", "--body", "safe", "--attach", image}
	if err := execRealGH(t.Context(), editArgs, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	editCapture := readRewriteCapture(t, editCapturePath)
	if len(editCapture.FileData) != 2 || !rewriteCaptureHasContent(editCapture, "safe") {
		t.Fatalf("explicit edit-last body changed shape: %+v", editCapture)
	}

	codeCapturePath := captureRewriteGH(t)
	codeBody := "`![example](" + image + ")`"
	codeArgs := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", codeBody, "--attach", image}
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
		args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", referenceBody, "--attach", image}
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
		args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", complexBody, "--attach", image}
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
	literalBodyArgs := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", literalBody}
	if err := execRealGH(t.Context(), literalBodyArgs, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	literalBodyCapture := readRewriteCapture(t, literalBodyCapturePath)
	if len(literalBodyCapture.FileData) != 1 || !rewriteCaptureHasContent(literalBodyCapture, literalBody) || slices.ContainsFunc(literalBodyCapture.Args, func(arg string) bool {
		return strings.HasPrefix(arg, "--attach=")
	}) {
		t.Fatalf("flag value was reinterpreted as an attachment: %+v", literalBodyCapture)
	}
}

func TestStringRewriteIssueCreateAttachments(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct {
		name     string
		text     string
		multiple bool
		exitCode int
	}{
		{"reported shape", "safe", false, 0},
		{"rewritten repeated attachments", "internal-model", true, 0},
		{"child nonzero exit", "internal-model", true, 7},
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
			args := []string{"issue", "create", "--repo", "acme/repo", "--title", test.text, "--body-file", body, "--label", "bug", "--assignee", "steipete", "--attach", image + "#" + alt}
			if test.multiple {
				args = append(args, "--attach="+video)
			}
			var stdout, stderr bytes.Buffer
			err := runGH(t.Context(), args, &stdout, &stderr)
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
			wantArgs := []string{"issue", "create", "--repo=acme/repo", "--title=" + strings.ReplaceAll(test.text, "internal-model", "public"), "--body-file=" + bodySnapshot, "--label=bug", "--assignee=steipete", "--attach=" + imageSnapshot + "#" + strings.ReplaceAll(alt, "internal-model", "public")}
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
				t.Fatalf("issue create capture=%+v, want argv=%v", capture, wantArgs)
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
				if data, err := os.ReadFile(path); err != nil || !bytes.Equal(data, want) {
					t.Fatalf("original file changed: %s", path)
				}
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

func TestStringRewritePREditAttachments(t *testing.T) {
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
		{"explicit body file", []string{"--body-file", body}, content},
		{"explicit empty body", []string{"--body", ""}, ""},
		{"explicit empty body file", []string{"--body-file", emptyBody}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := append([]string{"pr", "edit", "133369", "--repo", "acme/repo"}, test.args...)
			args = append(args, "--add-label", "bug", "--add-assignee", "steipete", "--attach", image+"#internal-model screenshot", "--attach="+video)
			if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
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
			wantArgs := []string{"pr", "edit", "133369", "--repo=acme/repo", "--body-file=" + bodySnapshot, "--add-label=bug", "--add-assignee=steipete", "--attach=" + imageSnapshot + "#public screenshot", "--attach=" + videoSnapshot}
			wantBody := strings.NewReplacer("internal-model", "public", image, imageSnapshot, video, videoSnapshot).Replace(test.body)
			gotBody, hasBody := capture.Files[bodySnapshot]
			if !slices.Equal(capture.Args, wantArgs) || capture.Stdin != "" || len(capture.Files) != 3 || imageSnapshot == "" || videoSnapshot == "" || bodySnapshot == body || bodySnapshot == emptyBody || !hasBody || gotBody != wantBody {
				t.Fatalf("PR edit capture=%+v, want argv=%v body=%q", capture, wantArgs, wantBody)
			}
		})
	}
}

func TestStringRewritePREditAttachmentsRequireBody(t *testing.T) {
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
				args := append([]string{"pr", "edit", "133369", "--repo", "acme/repo"}, test.args...)
				if attach {
					args = append(args, "--attach", image+"#alt")
				}
				err := runGH(t.Context(), args, io.Discard, io.Discard)
				if attach || len(test.args) == 0 {
					if err != errRewriteBlocked {
						t.Fatalf("expected strict block without body, got %v", err)
					}
					if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
						t.Fatal("blocked PR edit reached child")
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
		args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", test.body, "--attach", test.attachment}
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
		{"video alt", []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "safe", "--attach", video + "#caption"}},
		{"edit last without body", []string{"pr", "comment", "1", "--repo", "acme/repo", "--edit-last", "--attach", safe}},
		{"delete last with attachment", []string{"pr", "comment", "1", "--repo", "acme/repo", "--delete-last", "--attach", safe}},
		{"duplicate file", []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "safe", "--attach", safe, "--attach", safe}},
		{"malformed inline then shortcut reference", []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "![shot](" + safe + " garbage)\n\n[shot]: " + safe, "--attach", safe}},
		{"reference definition", []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "![safe][shot]\n\n[shot]: <" + safe + ">", "--attach", safe}},
		{"multiline reference definition", []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "![safe][shot]\n\n[shot]:\n  " + safe, "--attach", safe}},
		{"too many inline references", []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", strings.Repeat("![safe]("+safe+")\n", rewriteMaxAttachmentReferences+1), "--attach", safe}},
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
	args := []string{"pr", "comment", "1", "--repo", "acme/repo", "--body", "safe"}
	for range rewriteMaxAttachments + 1 {
		args = append(args, "--attach", safe)
	}
	capturePath := captureRewriteGH(t)
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
		t.Fatalf("attachment count error=%v", err)
	}
	if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
		t.Fatal("excess attachments reached child")
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
		{"filter pull head", []string{"pr", "list", "--repo", "https://github.com/acme/repo", "--head", "safe-branch", "--json", "number"}, "--head=safe-branch"},
		{"mark ready", []string{"pr", "ready", "123", "--repo", "https://github.com/acme/repo"}, "ready"},
		{"pinned merge", []string{"pr", "merge", "123", "--repo", "https://github.com/acme/repo", "--squash", "--match-head-commit", sha}, "repos/acme/repo/pulls/123/merge"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			if err := runGH(t.Context(), test.args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
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
		{"pr", "merge", "1", "-Racme/repo", "--squash", "--subject", "unsafe", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/repo", "--auto", "--squash", "--match-head-commit", strings.Repeat("a", 40)},
		{"pr", "merge", "1", "-Racme/repo", "--squash", "--match-head-commit", "short"},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=short", "-f", "merge_method=squash"},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=" + strings.Repeat("a", 40), "-f", "merge_method=merge"},
		{"api", "repos/acme/repo/pulls/1/merge", "--method", "PUT", "-f", "sha=" + strings.Repeat("a", 40), "-f", "merge_method=squash", "-f", "commit_title=user text"},
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
	if err := execRealGH(t.Context(), []string{"alias", "list"}, io.Discard, io.Discard); err != errRewritePolicy {
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

func TestStringRewriteTopLevelWatchFallbackIsBestEffort(t *testing.T) {
	recordWatchSleeps(t)
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request["path"] != "/repos/acme/repo/actions/runs/42" {
			t.Error("unexpected watch path")
		}
		writeCLIFallback(t, w, "route_denied")
	})
	capture := captureRewriteGH(t)
	args := []string{"run", "watch", "42", "-Racme/repo", "-i5", "--exit-status"}
	if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatalf("native watch best-effort fallback failed: %v", err)
	}
	want := []string{"run", "watch", "42", "--repo=github.com/acme/repo", "-i5", "--exit-status"}
	if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, want) || got.Env["GH_HOST"] != "github.com" {
		t.Fatalf("native watch args=%v env=%v", got.Args, got.Env)
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
