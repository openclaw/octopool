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

func TestRewritePreflightOutputBoundedCopy(t *testing.T) {
	var output rewritePreflightOutput
	// Hide the source's WriterTo to exercise io.Copy's destination fast paths.
	_, err := io.Copy(&output, io.LimitReader(strings.NewReader(strings.Repeat("x", rewriteMaxContent+1)), rewriteMaxContent+1))
	if !errors.Is(err, errRewriteBlocked) || output.data.Len() > rewriteMaxContent {
		t.Fatalf("preflight output exceeded its limit: bytes=%d err=%v", output.data.Len(), err)
	}
}

func TestStringRewriteAPIMergeMethods(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, method := range []string{"squash", "merge", "rebase", ""} {
		t.Run("method="+method, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			calls := filepath.Join(t.TempDir(), "calls")
			t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", calls)
			args := []string{"api", "repos/acme/repo/pulls/123/merge", "-X", "PUT", "-f", "sha=" + sha, "-f", "commit_title=internal-model title", "-f", "commit_message=internal-model body"}
			if method != "" {
				args = append(args, "-f", "merge_method="+method)
			}
			if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if len(capture.Files) != 1 {
				t.Fatalf("expected one snapshot: %+v", capture)
			}
			for _, content := range capture.Files {
				var payload map[string]string
				if err := json.Unmarshal([]byte(content), &payload); err != nil {
					t.Fatal(err)
				}
				_, hasMethod := payload["merge_method"]
				if payload["sha"] != sha || payload["merge_method"] != method || hasMethod != (method != "") || payload["commit_title"] != "public title" || payload["commit_message"] != "public body" {
					t.Fatalf("merge snapshot=%q", content)
				}
			}
			if data, err := os.ReadFile(calls); err != nil || string(data) != "child\n" {
				t.Fatalf("supplied SHA should skip preflight: %q, %v", data, err)
			}
		})
	}
}

func TestStringRewriteAPIMergeResolvesHead(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("b", 40)
	for _, input := range []string{`{}`, `{"merge_method":"merge","commit_title":"internal-model title","commit_message":"internal-model body"}`} {
		t.Run(input, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			preflightPath := filepath.Join(t.TempDir(), "preflight.json")
			calls := filepath.Join(t.TempDir(), "calls")
			source := filepath.Join(t.TempDir(), "merge.json")
			if err := os.WriteFile(source, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("OCTOPOOL_TEST_REWRITE_PREFLIGHT_CAPTURE", preflightPath)
			t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", calls)
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", `{"head":{"sha":"`+sha+`"}}`)
			t.Setenv("OCTOPOOL_TEST_REWRITE_MUTATE_FILE", source)
			t.Setenv("GH_HOST", "ghe.example")
			t.Setenv("GH_REPO", "ghe.example/other/repo")
			args := []string{"api", "repos/acme/repo/pulls/123/merge", "-X", "PUT", "--input", source}
			if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			preflight := readRewriteCapture(t, preflightPath)
			want := []string{"api", "/repos/acme/repo/pulls/123", "--method=GET", "--hostname=github.com"}
			if !slices.Equal(preflight.Args, want) || preflight.Stdin != "" || preflight.Env["GH_HOST"] != "github.com" || preflight.Env["GH_REPO"] != "" {
				t.Fatalf("unprotected preflight: %+v", preflight)
			}
			capture := readRewriteCapture(t, capturePath)
			if len(capture.Files) != 1 || !slices.Contains(capture.Args, "--method=PUT") || capture.Stdin != "" {
				t.Fatalf("merge not snapshotted: %+v", capture)
			}
			var expected map[string]string
			if err := json.Unmarshal([]byte(strings.ReplaceAll(input, "internal-model", "public")), &expected); err != nil {
				t.Fatal(err)
			}
			expected["sha"] = sha
			wantJSON, _ := json.Marshal(expected)
			for path, content := range capture.Files {
				if content != string(wantJSON) {
					t.Fatalf("merge snapshot=%q, want %q", content, wantJSON)
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("snapshot was not cleaned up")
				}
			}
			if data, err := os.ReadFile(calls); err != nil || string(data) != "child\nchild\n" {
				t.Fatalf("expected GET then PUT: %q, %v", data, err)
			}
		})
	}
}

func TestStringRewriteAPIMergePreflightBlocks(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct{ name, response, exit string }{
		{"failed GET", `{"head":{"sha":"` + strings.Repeat("a", 40) + `"}}`, "1"},
		{"malformed JSON", `{`, "0"},
		{"missing head", `{}`, "0"},
		{"missing SHA", `{"head":{}}`, "0"},
		{"invalid SHA", `{"head":{"sha":"short"}}`, "0"},
		{"wrong type", `{"head":{"sha":123}}`, "0"},
		{"duplicate SHA", `{"head":{"sha":"a","sha":"b"}}`, "0"},
		{"oversized response", strings.Repeat("x", rewriteMaxContent+1), "0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			calls := filepath.Join(t.TempDir(), "calls")
			t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", calls)
			// Use a file for large output to stay below process environment limits.
			response := filepath.Join(t.TempDir(), "response")
			if err := os.WriteFile(response, []byte(test.response), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT_FILE", response)
			t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", test.exit)
			args := []string{"api", "repos/acme/repo/pulls/123/merge", "-X", "PUT"}
			if err := execRealGH(t.Context(), args, io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
				t.Fatalf("expected blocked preflight: %v", err)
			}
			if capture := readRewriteCapture(t, capturePath); !slices.Contains(capture.Args, "--method=GET") {
				t.Fatalf("failed preflight dispatched a mutation: %+v", capture)
			}
			if data, err := os.ReadFile(calls); err != nil || string(data) != "child\n" {
				t.Fatalf("failed preflight should only call GET: %q, %v", data, err)
			}
		})
	}
}
