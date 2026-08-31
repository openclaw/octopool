package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestStringRewritePinnedMergeBody(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	body := "Reviewed internal-model fix\n\nCo-authored-by: Contributor <contributor@example.com>\n"
	file := filepath.Join(t.TempDir(), "body.md")
	if err := os.WriteFile(file, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		flags []string
	}{
		{"long file", []string{"--body-file", file}},
		{"long equals", []string{"--body-file=" + file}},
		{"short file", []string{"-F", file}},
		{"short attached", []string{"-F" + file}},
		{"stdin", []string{"--body-file=-"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, exit := range []string{"0", "19"} {
				t.Run("child exit "+exit, func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", exit)
					args := []string{"pr", "merge", "123", "--repo", "https://github.com/acme/repo", "--squash", "--match-head-commit", sha}
					args = append(args, test.flags...)
					err := execRealGHWithStdin(t.Context(), args, strings.NewReader(body), io.Discard, io.Discard)
					if exit == "0" && err != nil {
						t.Fatal(err)
					}
					if exit != "0" {
						var exitErr exitCodeError
						if !errors.As(err, &exitErr) || exitErr.Code != 19 {
							t.Fatalf("child exit was not preserved: %v", err)
						}
					}
					capture := readRewriteCapture(t, capturePath)
					if capture.Stdin != "" || len(capture.Files) != 1 || !slices.Contains(capture.Args, "repos/acme/repo/pulls/123/merge") || !slices.Contains(capture.Args, "--method=PUT") {
						t.Fatalf("merge was not an immediate snapshotted REST request: %+v", capture)
					}
					for path, content := range capture.Files {
						var payload map[string]string
						if err := json.Unmarshal([]byte(content), &payload); err != nil || len(payload) != 3 || payload["sha"] != sha || payload["merge_method"] != "squash" || payload["commit_message"] != strings.ReplaceAll(body, "internal-model", "public") {
							t.Fatalf("unexpected protected merge payload: %q", content)
						}
						if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
							t.Fatal("snapshot permissions are not private")
						}
						if _, err := os.Stat(path); !os.IsNotExist(err) {
							t.Fatal("snapshot survived child completion")
						}
					}
					got, err := os.ReadFile(file)
					if err != nil || string(got) != body {
						t.Fatal("source body file was modified")
					}
				})
			}
		})
	}
}

func TestStringRewritePinnedMergeBodyRejectsUnsafeRequests(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	file := filepath.Join(t.TempDir(), "body.md")
	if err := os.WriteFile(file, []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		sha   string
		flags []string
	}{
		{"short head", "short", nil},
		{"missing head", "", nil},
		{"auto", sha, []string{"--auto"}},
		{"admin", sha, []string{"--admin"}},
		{"merge method", sha, []string{"--merge"}},
		{"rebase method", sha, []string{"--rebase"}},
		{"subject", sha, []string{"--subject", "safe"}},
		{"inline body", sha, []string{"--body", "safe"}},
		{"duplicate body aliases", sha, []string{"-F", file}},
		{"conflicting squash", sha, []string{"--squash=false"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := []string{"pr", "merge", "123", "--repo", "acme/repo", "--squash", "--body-file", file}
			if test.sha != "" {
				args = append(args, "--match-head-commit", test.sha)
			}
			args = append(args, test.flags...)
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("unused"), io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("request was not rejected: %v", err)
			}
			if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
				t.Fatal("rejected request spawned a child")
			}
		})
	}
	for _, test := range []struct {
		name    string
		content []byte
	}{
		{"invalid UTF-8", []byte{255}},
		{"oversized", []byte(strings.Repeat("a", rewriteMaxContent+1))},
		{"active policy material", []byte(`{"pattern":"internal-model","replacement":"public"}`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			badFile := filepath.Join(t.TempDir(), "body.md")
			if err := os.WriteFile(badFile, test.content, 0600); err != nil {
				t.Fatal(err)
			}
			args := []string{"pr", "merge", "123", "--repo", "acme/repo", "--squash", "--match-head-commit", sha, "--body-file", badFile}
			if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != errRewriteBlocked {
				t.Fatalf("invalid body was not rejected: %v", err)
			}
			if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
				t.Fatal("invalid body spawned a child")
			}
		})
	}
}

func TestStringRewriteMergeMessageAPI(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, test := range []struct {
		name    string
		message any
		want    string
		blocked bool
	}{
		{"text", "reviewed internal-model fix", "reviewed public fix", false},
		{"wrong type", false, "", true},
		{"policy material", `{"pattern":"internal-model","replacement":"public"}`, "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			input, err := json.Marshal(map[string]any{"sha": sha, "merge_method": "squash", "commit_message": test.message})
			if err != nil {
				t.Fatal(err)
			}
			err = execRealGHWithStdin(t.Context(), []string{"api", "repos/acme/repo/pulls/123/merge", "--method=PUT", "--input=-"}, strings.NewReader(string(input)), io.Discard, io.Discard)
			if test.blocked {
				if err != errRewriteBlocked {
					t.Fatalf("invalid merge message was not rejected: %v", err)
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("invalid merge message reached the child")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if len(capture.Files) != 1 || capture.Stdin != "" {
				t.Fatal("merge message did not use a snapshot")
			}
			for _, content := range capture.Files {
				var payload map[string]string
				if err := json.Unmarshal([]byte(content), &payload); err != nil || payload["commit_message"] != test.want || payload["sha"] != sha || payload["merge_method"] != "squash" || len(payload) != 3 {
					t.Fatalf("unexpected merge payload: %q", content)
				}
			}
		})
	}
}
