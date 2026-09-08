package main

import (
	"encoding/json"
	"io"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestStringRewritePRBaseEditCLI(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct {
		name  string
		flags []string
		base  string
	}{
		{"long", []string{"--base", "main"}, "main"},
		{"equals", []string{"--base=release/0.6"}, "release/0.6"},
		{"short", []string{"-B", "123"}, "123"},
		{"attached", []string{"-Bmain"}, "main"},
		{"short equals", []string{"-B=main"}, "main"},
		{"with content", []string{"--base=main", "--body=internal-model"}, "main"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := append([]string{"pr", "edit", "3486", "--repo=acme/repo"}, test.flags...)
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("unrequested input"), io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if !slices.Contains(capture.Args, "--base="+test.base) || !slices.Contains(capture.Args, "--repo=acme/repo") {
				t.Fatalf("base/repository not preserved: %v", capture.Args)
			}
			if capture.Stdin != "" || capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" {
				t.Fatalf("unexpected child input or host context: %+v", capture)
			}
			if test.name == "with content" {
				if !rewriteCaptureHasContent(capture, "public") {
					t.Fatalf("body was not rewritten: %+v", capture)
				}
			} else if len(capture.Files) != 0 {
				t.Fatalf("base-only edit manufactured content: %+v", capture)
			}
		})
	}
}

func TestStringRewritePRBaseEditAPI(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct {
		name  string
		flags []string
		input string
		base  string
	}{
		{"raw field", []string{"-fbase=main"}, "", "main"},
		{"typed field", []string{"-Fbase=release/0.6"}, "", "release/0.6"},
		{"JSON", []string{"--input=-"}, `{"base":"123","body":"internal-model"}`, "123"},
	} {
		t.Run(test.name, func(t *testing.T) {
			capturePath := captureRewriteGH(t)
			args := append([]string{"api", "repos/acme/repo/pulls/3486", "--method=PATCH"}, test.flags...)
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(test.input), io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			capture := readRewriteCapture(t, capturePath)
			if len(capture.Files) != 1 || capture.Stdin != "" {
				t.Fatalf("expected one immutable JSON input: %+v", capture)
			}
			for _, content := range capture.Files {
				var payload map[string]any
				if err := json.Unmarshal([]byte(content), &payload); err != nil {
					t.Fatal(err)
				}
				if payload["base"] != test.base {
					t.Fatalf("base changed: %v", payload)
				}
				if test.name == "JSON" && payload["body"] != "public" {
					t.Fatalf("body was not rewritten: %v", payload)
				}
				if test.name != "JSON" && len(payload) != 1 {
					t.Fatalf("base-only edit manufactured fields: %v", payload)
				}
			}
		})
	}
}

func TestStringRewritePRBaseEditRejectsUnsafeRefs(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, base := range []string{"", "bad base", "../main", "topic..main", "topic.lock", "owner:main", "@{-1}", "-main", "topic//main", "internal-model", "release/internal-model"} {
		for _, transport := range []string{"cli", "api"} {
			t.Run(transport+"/"+base, func(t *testing.T) {
				capturePath := captureRewriteGH(t)
				args := []string{"pr", "edit", "3486", "--repo=acme/repo", "--base=" + base}
				if transport == "api" {
					args = []string{"api", "repos/acme/repo/pulls/3486", "--method=PATCH", "--raw-field=base=" + base}
				}
				if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(""), io.Discard, io.Discard); err != errRewriteBlocked {
					t.Fatalf("expected protected rejection, got %v", err)
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("rejected base reached native gh")
				}
			})
		}
	}
}

func TestStringRewritePRBaseEditRejectsAmbiguousInputs(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, args := range [][]string{
		{"pr", "edit", "3486", "--repo=acme/repo", "--base=main", "-Bother"},
		{"pr", "edit", "3486", "--repo=acme/repo", "--base=main", "--editor"},
		{"api", "repos/acme/repo/pulls/3486", "--method=PATCH", "--field=base=true"},
		{"api", "repos/acme/repo/pulls/3486", "--method=PATCH", "--field=base=null"},
		{"api", "repos/acme/repo/pulls/3486", "--method=PATCH", "--field=base=123"},
		{"api", "repos/acme/repo/pulls/3486", "--method=PATCH", "--raw-field=base=main", "--field=maintainer_can_modify=true"},
	} {
		capturePath := captureRewriteGH(t)
		if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(""), io.Discard, io.Discard); err != errRewriteBlocked {
			t.Fatalf("ambiguous edit accepted: %v: %v", args, err)
		}
		if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
			t.Fatal("ambiguous edit reached native gh")
		}
	}
}

func TestStringRewritePRBasePreparationPortable(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	for _, base := range []string{"main", "release/0.6", "123"} {
		t.Run(base, func(t *testing.T) {
			prepared := &rewritePreparation{}
			defer prepared.cleanup()
			args := []string{"pr", "edit", "3486", "--repo=acme/repo", "--base=" + base}
			if err := prepareRewriteContent(policy, args, strings.NewReader(""), prepared); err != nil {
				t.Fatal(err)
			}
			if !slices.Contains(prepared.args, "--base="+base) {
				t.Fatalf("base not preserved: %v", prepared.args)
			}
			payload := map[string]any{"base": base, "body": "internal-model"}
			if err := rewriteAPIPayload(policy, prepared, payload, "pull-edit"); err != nil {
				t.Fatal(err)
			}
			if payload["base"] != base || payload["body"] != "public" {
				t.Fatalf("unexpected rewritten payload: %v", payload)
			}
		})
	}
	for _, base := range []any{nil, 123, true, "", "bad base", "topic..main", "internal-model"} {
		prepared := &rewritePreparation{}
		payload := map[string]any{"base": base}
		if err := rewriteAPIPayload(policy, prepared, payload, "pull-edit"); err != errRewriteBlocked {
			t.Fatalf("invalid base accepted: %v", err)
		}
	}
}
