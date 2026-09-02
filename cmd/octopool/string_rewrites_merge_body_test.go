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
		name    string
		flags   []string
		subject string
	}{
		{"long file", []string{"--body-file", file}, ""},
		{"long equals", []string{"--body-file=" + file}, ""},
		{"short file", []string{"-F", file}, ""},
		{"short attached", []string{"-F" + file}, ""},
		{"stdin", []string{"--body-file=-"}, ""},
		{"subject and file", []string{"--body-file", file, "--subject", "fix(cli): protect internal-model (#123)"}, "fix(cli): protect public (#123)"},
		{"short subject and stdin", []string{"-F-", "-tfix(cli): protect internal-model (#123)"}, "fix(cli): protect public (#123)"},
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
						fields := 3
						if test.subject != "" {
							fields++
						}
						if err := json.Unmarshal([]byte(content), &payload); err != nil || len(payload) != fields || payload["commit_title"] != test.subject || payload["sha"] != sha || payload["merge_method"] != "squash" || payload["commit_message"] != strings.ReplaceAll(body, "internal-model", "public") {
							t.Fatalf("unexpected protected merge payload: %q", content)
						}
						if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
							t.Fatal("snapshot permissions are not private")
						}
						if _, err := os.Stat(path); !os.IsNotExist(err) {
							t.Fatal("snapshot survived child completion")
						}
					}
					for _, arg := range capture.Args {
						if strings.Contains(arg, "internal-model") || strings.Contains(arg, "commit_title") || strings.Contains(arg, file) {
							t.Fatal("original publication input reached child arguments")
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

func TestStringRewritePinnedMergeSubject(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	title := "fix(cli): protect merge subjects (#123)"
	file := filepath.Join(t.TempDir(), "not-a-title.txt")
	if err := os.WriteFile(file, []byte("must not be read"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		flags []string
		want  string
	}{
		{"long separate", []string{"--subject", title}, title},
		{"long equals", []string{"--subject=" + title}, title},
		{"short separate", []string{"-t", title}, title},
		{"short equals", []string{"-t=" + title}, title},
		{"short attached", []string{"-t" + title}, title},
		{"rewrite", []string{"--subject=fix(cli): internal-model (#123)"}, "fix(cli): public (#123)"},
		{"literal file", []string{"--subject", "@" + file}, "@" + file},
		{"literal stdin", []string{"-t@-"}, "@-"},
		{"literal syntax", []string{"--subject", "$(internal-model) `internal-model` ${branch} = #123"}, "$(public) `public` ${branch} = #123"},
		{"flag-like value", []string{"--subject", "--admin"}, "--admin"},
		{"boolean-like value", []string{"-ttrue"}, "true"},
		{"numeric value", []string{"-t123"}, "123"},
		{"explicit empty", []string{"--subject="}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := append([]string{"pr", "merge", "123", "-Racme/repo", "--squash", "--match-head-commit=" + sha}, test.flags...)
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("unused stdin"), io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if capture.Stdin != "" || len(capture.Files) != 1 {
				t.Fatal("subject did not use an isolated snapshot")
			}
			for path, content := range capture.Files {
				wantArgs := []string{"api", "repos/acme/repo/pulls/123/merge", "--method=PUT", "--hostname=github.com", "--input=" + path, "--silent=true"}
				if !slices.Equal(capture.Args, wantArgs) {
					t.Fatalf("unexpected child arguments: %v", capture.Args)
				}
				var payload map[string]string
				if err := json.Unmarshal([]byte(content), &payload); err != nil || len(payload) != 3 || payload["sha"] != sha || payload["merge_method"] != "squash" {
					t.Fatalf("unexpected merge payload: %q", content)
				}
				if got, ok := payload["commit_title"]; !ok || got != test.want {
					t.Fatalf("commit_title=%q present=%v want=%q", got, ok, test.want)
				}
				if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
					t.Fatal("snapshot permissions are not private")
				}
				if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
					t.Fatal("snapshot directory survived child completion")
				}
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
		{"nonhex head", strings.Repeat("g", 40), nil},
		{"missing head", "", nil},
		{"auto", sha, []string{"--auto"}},
		{"admin", sha, []string{"--admin"}},
		{"merge method", sha, []string{"--merge"}},
		{"rebase method", sha, []string{"--rebase"}},
		{"duplicate subject", sha, []string{"--subject", "safe", "--subject=other"}},
		{"duplicate subject aliases", sha, []string{"--subject", "safe", "-tother"}},
		{"duplicate short subject", sha, []string{"-tsafe", "-t=other"}},
		{"missing subject value", sha, []string{"--subject"}},
		{"missing short subject value", sha, []string{"-t"}},
		{"unknown title alias", sha, []string{"--title", "safe"}},
		{"unknown subject abbreviation", sha, []string{"--subj=safe"}},
		{"unknown flag with subject", sha, []string{"--subject=safe", "--delete-branch"}},
		{"inline body", sha, []string{"--body", "safe"}},
		{"duplicate body aliases", sha, []string{"-F", file}},
		{"conflicting squash", sha, []string{"--squash=false"}},
		{"auto with subject", sha, []string{"--subject=safe", "--auto"}},
		{"admin with subject", sha, []string{"-tsafe", "--admin"}},
		{"other method with subject", sha, []string{"-tsafe", "--rebase"}},
		{"duplicate repo with subject", sha, []string{"-tsafe", "-Rother/repo"}},
		{"duplicate head with subject", sha, []string{"-tsafe", "--match-head-commit=" + sha}},
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

func TestStringRewriteMergeSubjectValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		subject string
		body    string
		rules   []stringRewriteRule
	}{
		{name: "invalid UTF-8", subject: string([]byte{255})},
		{name: "oversized", subject: strings.Repeat("x", rewriteMaxContent+1)},
		{name: "combined title and body budget", subject: strings.Repeat("x", rewriteMaxContent/2), body: strings.Repeat("y", rewriteMaxContent/2)},
		{name: "policy material", subject: `{"pattern":"internal-model","replacement":"public"}`},
		{name: "expanded title", subject: strings.Repeat("x", 2048), rules: []stringRewriteRule{{"x", strings.Repeat("y", rewriteMaxReplacement)}}},
		{name: "residual match", subject: "seed", rules: []stringRewriteRule{{"forbidden", "safe"}, {"seed", "forbidden"}}},
		{name: "structural head", subject: "safe", rules: []stringRewriteRule{{"a{40}", "b"}}},
		{name: "structural repo", subject: "safe", rules: []stringRewriteRule{{"acme", "other"}}},
		{name: "structural selector", subject: "safe", rules: []stringRewriteRule{{"123", "456"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rules := test.rules
			if rules == nil {
				rules = []stringRewriteRule{{"internal-model", "public"}}
			}
			policy := testRewritePolicy(t, rules...)
			prepared := &rewritePreparation{ctx: t.Context()}
			defer prepared.cleanup()
			args := []string{"pr", "merge", "123", "--repo=acme/repo", "--squash", "--match-head-commit=" + strings.Repeat("a", 40), "--subject=" + test.subject}
			if test.body != "" {
				args = append(args, "--body-file=-")
			}
			if err := prepareRewritePRLifecycle(policy, args, strings.NewReader(test.body), prepared); err != errRewriteBlocked {
				t.Fatalf("unsafe subject merge was not blocked: %v", err)
			}
			if len(prepared.args) != 0 || prepared.directory != "" {
				t.Fatal("unsafe subject merge produced a dispatch snapshot")
			}
		})
	}
}

func TestStringRewriteMergeTitleAPIFields(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, test := range []struct {
		name  string
		field string
		want  string
	}{
		{"raw text", "-fcommit_title=fix(cli): internal-model (#123)", "fix(cli): public (#123)"},
		{"typed text", "-Fcommit_title=internal-model", "public"},
		{"raw literal", "--raw-field=commit_title=@internal-model", "@public"},
		{"typed stdin", "--field=commit_title=@-", "public"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := []string{"api", "repos/acme/repo/pulls/123/merge", "--method=PUT", "-fsha=" + sha, "-fmerge_method=squash", "-fcommit_message=reviewed internal-model fix", test.field}
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("internal-model"), io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if len(capture.Files) != 1 || capture.Stdin != "" {
				t.Fatal("merge fields did not use a snapshot")
			}
			for path, content := range capture.Files {
				if !slices.Equal(capture.Args, []string{"api", "repos/acme/repo/pulls/123/merge", "--method=PUT", "--hostname=github.com", "--input=" + path}) {
					t.Fatalf("raw publication fields reached child: %v", capture.Args)
				}
				var payload map[string]string
				if err := json.Unmarshal([]byte(content), &payload); err != nil || len(payload) != 4 || payload["commit_title"] != test.want || payload["commit_message"] != "reviewed public fix" || payload["sha"] != sha || payload["merge_method"] != "squash" {
					t.Fatalf("unexpected merge payload: %q", content)
				}
			}
		})
	}
}

func TestStringRewriteMergeTextAPI(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	sha := strings.Repeat("a", 40)
	for _, field := range []string{"commit_message", "commit_title"} {
		t.Run(field, func(t *testing.T) {
			for _, test := range []struct {
				name    string
				text    any
				want    string
				blocked bool
			}{
				{"text", "reviewed internal-model fix", "reviewed public fix", false},
				{"literal at", "@internal-model", "@public", false},
				{"empty", "", "", false},
				{"wrong type", false, "", true},
				{"number", 123, "", true},
				{"null", nil, "", true},
				{"object", map[string]any{"text": "safe"}, "", true},
				{"array", []string{"safe"}, "", true},
				{"oversized", strings.Repeat("x", rewriteMaxContent+1), "", true},
				{"policy material", `{"pattern":"internal-model","replacement":"public"}`, "", true},
			} {
				t.Run(test.name, func(t *testing.T) {
					capturePath := captureRewriteGH(t)
					input, err := json.Marshal(map[string]any{"sha": sha, "merge_method": "squash", field: test.text})
					if err != nil {
						t.Fatal(err)
					}
					err = execRealGHWithStdin(t.Context(), []string{"api", "repos/acme/repo/pulls/123/merge", "--method=PUT", "--input=-"}, strings.NewReader(string(input)), io.Discard, io.Discard)
					if test.blocked {
						if err != errRewriteBlocked {
							t.Fatalf("invalid merge text was not rejected: %v", err)
						}
						if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
							t.Fatal("invalid merge text reached the child")
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					capture := readRewriteCapture(t, capturePath)
					if len(capture.Files) != 1 || capture.Stdin != "" {
						t.Fatal("merge text did not use a snapshot")
					}
					for _, content := range capture.Files {
						var payload map[string]string
						if err := json.Unmarshal([]byte(content), &payload); err != nil || payload[field] != test.want || payload["sha"] != sha || payload["merge_method"] != "squash" || len(payload) != 3 {
							t.Fatalf("unexpected merge payload: %q", content)
						}
					}
				})
			}
		})
	}
}
