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

const asyncMergeTestPath = "repos/acme/repo/pulls/123/merge-async"
const asyncMergeTestUUID = "12345678-abcd-4321-9876-123456789abc"

func TestStringRewriteAPIMergeLocalFormatting(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, endpoint := range []string{"repos/acme/repo/pulls/123/merge", asyncMergeTestPath, asyncMergeTestPath + "/" + asyncMergeTestUUID} {
		for _, format := range [][]string{{"--template", "{{.status}} internal-model"}, {"--template={{.status}}"}, {"-t", "{{.status}}"}, {"-t{{.status}}"}, {"-t={{.status}}"}, {"-t="}} {
			t.Run(endpoint+strings.Join(format, " "), func(t *testing.T) {
				capture := captureRewriteGH(t)
				args := []string{"api", endpoint}
				poll := strings.HasSuffix(endpoint, asyncMergeTestUUID)
				if !poll {
					args = append(args, "--method=PUT", "--input=-")
				}
				args = append(args, format...)
				input := `{"sha":"` + strings.Repeat("a", 40) + `","merge_method":"squash","commit_message":"internal-model body"}`
				if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); err != nil {
					t.Fatal(err)
				}
				got := readRewriteCapture(t, capture)
				if got.Stdin != "" || !slices.Equal(got.Args[len(got.Args)-len(format):], format) {
					t.Fatalf("formatter spelling changed: %+v", got)
				}
				if poll && len(got.Files) != 0 || !poll && len(got.Files) != 1 {
					t.Fatalf("unexpected snapshots: %+v", got)
				}
				for _, content := range got.Files {
					var payload map[string]string
					if err := json.Unmarshal([]byte(content), &payload); err != nil || payload["merge_method"] != "squash" || payload["sha"] != strings.Repeat("a", 40) || payload["commit_message"] != "public body" {
						t.Fatalf("formatter changed authority or snapshot: %q, %v", content, err)
					}
				}
			})
		}
	}
}

func TestStringRewriteAPIAsyncMergeSnapshot(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, test := range []struct {
		method, action string
		bypass         bool
	}{
		{"squash", "direct_merge", false}, {"merge", "merge_queue", true}, {"rebase", "default", false}, {"", "", false},
	} {
		for _, source := range []string{"file", "stdin", "fields"} {
			t.Run(test.method+"/"+source, func(t *testing.T) {
				capturePath := captureRewriteGH(t)
				calls := filepath.Join(t.TempDir(), "calls")
				t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", calls)
				t.Setenv("GH_HOST", "ghe.example")
				t.Setenv("GH_REPO", "ghe.example/other/repo")
				payload := map[string]any{"sha": sha, "commit_title": "internal-model title", "commit_message": "internal-model body"}
				args := []string{"api", "-H", "X-Octopool-Require: merge-async-v1", asyncMergeTestPath, "--method=PUT", "--include", "-H", "X-GitHub-Api-Version: 2026-03-10"}
				if test.method != "" {
					payload["merge_method"], payload["merge_action"], payload["bypass_rules"] = test.method, test.action, test.bypass
				}
				encoded, _ := json.Marshal(payload)
				if source == "fields" {
					for key, value := range payload {
						if text, ok := value.(string); ok {
							args = append(args, "-f", key+"="+text)
						} else if value == true {
							args = append(args, "-F", key+"=true")
						} else {
							args = append(args, "-F", key+"=false")
						}
					}
				} else {
					path := "-"
					if source == "file" {
						path = filepath.Join(t.TempDir(), "request.json")
						if err := os.WriteFile(path, encoded, 0600); err != nil {
							t.Fatal(err)
						}
					}
					args = append(args, "--input", path)
				}
				if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(string(encoded)), io.Discard, io.Discard); err != nil {
					t.Fatal(err)
				}
				capture := readRewriteCapture(t, capturePath)
				if capture.Stdin != "" || len(capture.Files) != 1 || capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" || !slices.Contains(capture.Args, asyncMergeTestPath) || !slices.Contains(capture.Args, "--header=x-github-api-version: 2026-03-10") {
					t.Fatalf("unexpected dispatch: %+v", capture)
				}
				payload["commit_title"], payload["commit_message"] = "public title", "public body"
				want, _ := json.Marshal(payload)
				for path, content := range capture.Files {
					if content != string(want) || capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
						t.Fatalf("unexpected snapshot: %q", content)
					}
					if _, err := os.Stat(path); !os.IsNotExist(err) {
						t.Fatal("snapshot was not removed")
					}
				}
				if data, err := os.ReadFile(calls); err != nil || string(data) != "child\n" {
					t.Fatalf("expected one PUT: %q, %v", data, err)
				}
			})
		}
	}
}

func TestStringRewriteAPIAsyncMergeStructuralRules(t *testing.T) {
	sha := strings.Repeat("a", 40)
	for _, pattern := range []string{"^" + sha + "$", "^squash$", "^direct_merge$", "^merge_method$", "^bypass_rules$"} {
		t.Run(pattern, func(t *testing.T) {
			rewriteTestServer(t, strings.Replace(prReadPolicy(pattern), `"replacement":"public"`, `"replacement":"rebase"`, 1), nil)
			capture := captureRewriteGH(t)
			payload := `{"sha":"` + sha + `","merge_method":"squash","merge_action":"direct_merge","bypass_rules":false}`
			args := []string{"api", asyncMergeTestPath, "-X", "PUT", "--input=-"}
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(payload), io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
				t.Fatalf("structural rule must block: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("structural rejection reached child gh")
			}
		})
	}
}

func TestStringRewriteAPIMergeUnsupportedCannotRewrite(t *testing.T) {
	for _, endpoint := range []string{asyncMergeTestPath, "repos/acme/repo/pulls/123/merge", "repos/acme/repo/pulls/123/merge%2Dasync", asyncMergeTestPath + "/" + asyncMergeTestUUID} {
		for _, flags := range [][]string{{"-X", "POST"}, {"-X", "PUT", "--paginate"}, {"-X", "PUT", "-H", "Content-Type: application/json"}, {"-X", "PUT", "--cache=10s"}} {
			t.Run(endpoint+strings.Join(flags, " "), func(t *testing.T) {
				rewriteTestServer(t, prReadPolicy("^squash$"), nil)
				capture := captureRewriteGH(t)
				args := append([]string{"api", endpoint, "--input=-"}, flags...)
				if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(`{"merge_method":"squash"}`), io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
					t.Fatalf("unsupported merge must block: %v", err)
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("unsupported merge reached child gh")
				}
			})
		}
	}
}

func TestStringRewriteAPIMergeStatusNative(t *testing.T) {
	for _, endpoint := range []string{asyncMergeTestPath + "/" + asyncMergeTestUUID, "repos/acme/repo/pulls/123/merge"} {
		t.Run(endpoint, func(t *testing.T) {
			policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capture := captureRewriteGH(t)
			t.Setenv("GH_HOST", "ghe.example")
			args := []string{"api", endpoint}
			if err := runGH(t.Context(), args, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			got := readRewriteCapture(t, capture)
			if !slices.Equal(got.Args, []string{"api", endpoint, "--method=GET", "--hostname=github.com"}) || got.Stdin != "" || got.Env["GH_HOST"] != "github.com" {
				t.Fatalf("unexpected native poll: %+v", got)
			}
			if err := os.Remove(capture); err != nil {
				t.Fatal(err)
			}
			policy.Store(prReadPolicy("123"))
			if err := runGH(t.Context(), args, io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
				t.Fatalf("poll target must block: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("rejected poll reached child gh")
			}
		})
	}
}

func TestStringRewriteAPIAsyncMergeInvalidPayload(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, input := range []string{
		`{"sha":"short"}`, `{"sha":42}`, `{"merge_method":"other"}`, `{"merge_action":"other"}`,
		`{"merge_action":true}`, `{"bypass_rules":"false"}`, `{"bypass_rules":null}`,
		`{"unknown":"value"}`, `{"merge_method":"squash","merge_method":"rebase"}`,
	} {
		t.Run(input, func(t *testing.T) {
			capture := captureRewriteGH(t)
			if err := execRealGHWithStdin(t.Context(), []string{"api", asyncMergeTestPath, "-X", "PUT", "--input=-"}, strings.NewReader(input), io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
				t.Fatalf("invalid merge must block: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("invalid payload reached head preflight or PUT")
			}
		})
	}
}

func TestStringRewriteAPIMergeFallbackTargets(t *testing.T) {
	for _, endpoint := range []string{asyncMergeTestPath, asyncMergeTestPath + "?test=1"} {
		for _, delimiter := range []bool{false, true} {
			t.Run(endpoint, func(t *testing.T) {
				rewriteTestServer(t, rewriteActiveTestPolicy, nil)
				capture := captureRewriteGH(t)
				args := []string{"api", "-X", "PUT", "--input=-"}
				if delimiter {
					args = append(args, "--")
				}
				args = append(args, endpoint)
				// A structural match must be rejected before the omitted-SHA GET.
				input := `{"merge_method":"internal-model"}`
				if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
					t.Fatalf("unmodeled merge must block: %v", err)
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("unmodeled merge reached child gh")
				}
			})
		}
	}
	t.Run("rewritten endpoint", func(t *testing.T) {
		rewriteTestServer(t, strings.Replace(prReadPolicy("change-route"), `"replacement":"public"`, `"replacement":"merge-async"`, 1), nil)
		capture := captureRewriteGH(t)
		args := []string{"api", "repos/acme/repo/pulls/123/change-route", "-X", "PUT", "--input=-"}
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(`{"merge_method":"squash"}`), io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
			t.Fatalf("rewritten merge route must block: %v", err)
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatal("rewritten endpoint reached child gh")
		}
	})
}

func TestStringRewriteAPIMergeGuardMarker(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, args := range [][]string{
		{"api", "-H", "X-Octopool-Require: other", asyncMergeTestPath, "-X", "PUT"},
		{"api", "-H", "X-Octopool-Require: merge-async-v1", "-H", "X-Octopool-Require: merge-async-v1", asyncMergeTestPath, "-X", "PUT"},
		{"api", "-H", "X-Octopool-Require: merge-async-v1", "repos/acme/repo/issues"},
		{"api", "--cache=1s", "-H", "X-Octopool-Require: merge-async-v1", "repos/acme/repo/issues"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			capture := captureRewriteGH(t)
			if err := runGH(t.Context(), args, io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
				t.Fatalf("unsupported guard must block: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unsupported guard reached child gh")
			}
		})
	}
}
