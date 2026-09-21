package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

func TestRewriteAPIPayloadErrors(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	for _, test := range []struct {
		name, schema, input, want string
	}{
		{"issue missing", "issue-create", `{}`, `is missing required field "title"`},
		{"pull missing", "pull-create", `{"title":"safe","body":"safe","base":"main"}`, `is missing required field "head"`},
		{"release missing", "release-create", `{"name":"safe","body":"safe"}`, `is missing required field "tag_name"`},
		{"comment missing", "comment", `{}`, `is missing required field "body"`},
		{"review missing", "review", `{"body":"safe"}`, `is missing required field "event"`},
		{"assignees missing", "assignees", `{}`, `is missing required field "assignees"`},
		{"empty edit", "issue-edit", `{}`, `must contain at least one supported field`},
		{"unsupported", "comment", `{"body":"safe","unknown":"internal-model"}`, `field "unknown" is unsupported`},
		{"text type", "comment", `{"body":false}`, `field "body" must be a string`},
		{"empty text", "issue-create", `{"title":" ","body":"safe"}`, `field "title" must be non-empty after rewriting`},
		{"SHA value", "pull-merge", `{"sha":"internal-model"}`, `field "sha" must be a 40-hex head commit`},
		{"SHA type", "pull-merge", `{"sha":123}`, `field "sha" must be a 40-hex head commit`},
		{"SHA empty", "pull-merge", `{"sha":""}`, `field "sha" must be a 40-hex head commit`},
		{"SHA nonhex", "pull-merge", `{"sha":"gggggggggggggggggggggggggggggggggggggggg"}`, `field "sha" must be a 40-hex head commit`},
		{"method value", "pull-merge", `{"merge_method":"internal-model"}`, `field "merge_method" must be one of squash, merge, rebase`},
		{"method type", "pull-merge", `{"merge_method":true}`, `field "merge_method" must be one of squash, merge, rebase`},
		{"title type", "pull-merge", `{"commit_title":false}`, `field "commit_title" must be a string`},
		{"body type", "pull-merge", `{"commit_message":null}`, `field "commit_message" must be a string`},
		{"string type", "pull-create", `{"title":"safe","body":"safe","head":false,"base":"main"}`, `field "head" must be a non-empty string`},
		{"branch value", "pull-edit", `{"base":"bad branch"}`, `field "base" must be a valid branch name`},
		{"array type", "assignees", `{"assignees":"someone"}`, `field "assignees" must be an array of strings`},
		{"array element type", "assignees", `{"assignees":[false]}`, `field "assignees" must be an array of strings`},
		{"login value", "assignees", `{"assignees":["not a login"]}`, `field "assignees" must contain valid GitHub logins`},
		{"integer type", "issue-create", `{"title":"safe","body":"safe","milestone":false}`, `field "milestone" must be an integer`},
		{"bool type", "release-edit", `{"draft":"false"}`, `field "draft" must be a boolean`},
		{"event value", "review", `{"body":"safe","event":"internal-model"}`, `field "event" must be one of APPROVE, COMMENT, REQUEST_CHANGES`},
		{"comments type", "review", `{"body":"safe","event":"COMMENT","comments":false}`, `field "comments" must be an array of comment objects`},
		{"comment type", "review", `{"body":"safe","event":"COMMENT","comments":[false]}`, `field "comments" must be an array of comment objects`},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, err := strictRewriteJSON([]byte(test.input), rewriteMaxContent)
			if err != nil {
				t.Fatal(err)
			}
			err = rewriteAPIPayload(policy, &rewritePreparation{}, value.(map[string]any), test.schema)
			want := errRewriteBlocked.Error() + ": " + test.schema + " payload " + test.want
			if !errors.Is(err, errRewriteBlocked) || err.Error() != want {
				t.Fatalf("error=%v, want %q wrapping errRewriteBlocked", err, want)
			}
			if strings.Contains(err.Error(), "internal-model") {
				t.Fatalf("error exposed rule text: %v", err)
			}
		})
	}
	for _, schema := range []string{"issue-create", "pull-create", "release-create", "comment", "review", "assignees", "review-comment"} {
		t.Run(schema+" unsupported", func(t *testing.T) {
			payload := map[string]any{"unknown": "safe"}
			switch schema {
			case "issue-create":
				payload["title"], payload["body"] = "safe", "safe"
			case "pull-create":
				payload["title"], payload["body"], payload["head"], payload["base"] = "safe", "safe", "topic", "main"
			case "release-create":
				payload["name"], payload["body"], payload["tag_name"] = "safe", "safe", "v1"
			case "comment":
				payload["body"] = "safe"
			case "review":
				payload["body"], payload["event"] = "safe", "COMMENT"
			case "assignees":
				payload["assignees"] = []any{"someone"}
			case "review-comment":
				payload["body"], payload["path"] = "safe", "README.md"
			}
			err := rewriteAPIPayload(policy, &rewritePreparation{}, payload, schema)
			if !errors.Is(err, errRewriteBlocked) || !strings.Contains(err.Error(), schema+` payload field "unknown" is unsupported`) {
				t.Fatalf("unsupported field error=%v", err)
			}
		})
	}
}

func TestRewriteAPIPayloadErrorsHideRuleMaterial(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"s[3]cr3t", "public"})
	for _, key := range []string{"s3cr3t", "s[3]cr3t", `{"pattern":"s[3]cr3t","replacement":"public"}`} {
		err := rewriteAPIPayload(policy, &rewritePreparation{}, map[string]any{"body": "safe", key: "value"}, "comment")
		if err != errRewriteBlocked {
			t.Fatalf("policy material received a detailed error: %v", err)
		}
	}
	payload := map[string]any{"body": "safe", "event": "COMMENT", "comments": []any{map[string]any{"path": "README.md"}}}
	err := rewriteAPIPayload(policy, &rewritePreparation{}, payload, "review")
	if !errors.Is(err, errRewriteBlocked) || !strings.Contains(err.Error(), `review-comment payload is missing required field "body"`) {
		t.Fatalf("nested schema error=%v", err)
	}
}

func TestStringRewriteAPISchemaErrorPropagation(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	for _, test := range []struct{ endpoint, method, input, want string }{
		{"pulls/123/merge", "PUT", `{"sha":"short"}`, `pull-merge payload field "sha" must be a 40-hex head commit`},
		{"pulls/123/merge", "PUT", `{"merge_method":"internal-model"}`, `pull-merge payload field "merge_method" must be one of squash, merge, rebase`},
		{"issues", "POST", `{"title":"safe"}`, `issue-create payload is missing required field "body"`},
		{"issues/123/comments", "POST", `{"body":"safe","unknown":"internal-model"}`, `comment payload field "unknown" is unsupported`},
	} {
		t.Run(test.want, func(t *testing.T) {
			capture := captureRewriteGH(t)
			args := []string{"api", "repos/acme/repo/" + test.endpoint, "-X", test.method, "--input=-"}
			err := execRealGHWithStdin(t.Context(), args, strings.NewReader(test.input), io.Discard, io.Discard)
			if !errors.Is(err, errRewriteBlocked) || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "internal-model") {
				t.Fatalf("detailed error was lost or exposed rule text: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("invalid payload reached native gh")
			}
		})
	}
}

func TestRewriteAPIPayloadSanitizedEmptyError(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", ""})
	payload := map[string]any{"title": "internal-model", "body": "safe"}
	err := rewriteAPIPayload(policy, &rewritePreparation{}, payload, "issue-create")
	if !errors.Is(err, errRewriteBlocked) || !strings.Contains(err.Error(), `field "title" must be non-empty after rewriting`) || strings.Contains(err.Error(), "internal-model") {
		t.Fatalf("sanitized empty error=%v", err)
	}
}

func TestRewriteAPIMergeResolvedSHAChecksPolicy(t *testing.T) {
	sha := strings.Repeat("a", 40)
	policy := testRewritePolicy(t, stringRewriteRule{sha, "public"})
	prepared := &rewritePreparation{}
	defer prepared.cleanup()
	if err := prepareRewriteAPI(policy, []string{"api", "repos/acme/repo/pulls/123/merge", "-X", "PUT"}, strings.NewReader(""), prepared); err != nil {
		t.Fatal(err)
	}
	response, _ := json.Marshal(map[string]any{"head": map[string]string{"sha": sha}})
	if prepared.afterPreflight == nil {
		t.Fatal("omitted SHA did not request a preflight")
	}
	if err := prepared.afterPreflight(response); !errors.Is(err, errRewriteBlocked) || strings.Contains(err.Error(), sha) {
		t.Fatalf("resolved SHA escaped policy or leaked: %v", err)
	}
	if len(prepared.snapshots) != 0 {
		t.Fatal("blocked SHA created a publication snapshot")
	}
}
