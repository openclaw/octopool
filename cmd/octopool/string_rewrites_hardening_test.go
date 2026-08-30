package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRewriteEndpointNoChild(t *testing.T) {
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		writeCLIFallback(t, w, "route_denied")
	})
	for _, endpoint := range []string{
		"repos/acme/demo/contents/README.md?ref={branch}",
		"repos/acme/demo/contents/README.md?{owner}=safe",
		"repos/acme/demo/contents/README.md?ref=prefix:repo",
		"repos/acme/demo/contents/README.md?prefix:branch=safe",
		"repos/acme/demo/contents/prefix:branch.md",
		"repos/prefix:owner/demo", "repos/acme/prefix:repo",
		"repos/{owner}/{repo}", "repos/acme/demo?ref={unknown}",
	} {
		for _, flag := range []string{"", "--include", "-i"} {
			for _, boundary := range []string{"initial", "final", "fallback"} {
				t.Run(endpoint+flag+boundary, func(t *testing.T) {
					capture := captureRewriteGH(t)
					args := []string{"api", endpoint}
					if flag != "" {
						args = append(args, flag)
					}
					var out, stderr bytes.Buffer
					var err error
					switch boundary {
					case "initial":
						err = runGH(t.Context(), args, &out, &stderr)
					case "final":
						err = execRealGH(t.Context(), args, &out, &stderr)
					case "fallback":
						err = execRealGHAfterLocalFallback(t.Context(), args, &out, &stderr, localFallbackError{Reason: "test"})
					}
					if err != errRewriteBlocked {
						t.Fatalf("expected generic denial, got %v", err)
					}
					if out.Len() != 0 || strings.Contains(stderr.String(), endpoint) {
						t.Fatal("denial echoed input")
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatal("unsafe endpoint executed child")
					}
				})
			}
		}
	}
	for _, endpoint := range []string{"repos/acme/demo/contents/main.md?ref=main", "repos/acme/demo/contents/prefix:branching.md"} {
		capture := captureRewriteGH(t)
		if err := runGH(t.Context(), []string{"api", endpoint, "--include"}, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		readRewriteCapture(t, capture)
	}
	policy.Store(rewriteEmptyTestPolicy)
	capture := captureRewriteGH(t)
	if err := runGH(t.Context(), []string{"api", "repos/{owner}/{repo}?ref={branch}", "-i"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	readRewriteCapture(t, capture)
}

func TestRewritePolicyMaterialNoChild(t *testing.T) {
	const raw = `{"schema_version":1,"rules":[{"pattern":"\\bcobalt-mint\\b","replacement":"public"}]}`
	const active = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"\\bcobalt-mint\\b","replacement":"public"}]}`
	rewriteTestServer(t, active, nil)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(raw), "", "  "); err != nil {
		t.Fatal(err)
	}
	contents := []string{raw, pretty.String(), strings.ReplaceAll(raw, "cobalt", `\u0063obalt`), "Policy:\n```json\n" + pretty.String() + "\n```\nEnd.", `{"pattern":"\\bcobalt-mint\\b","replacement":"other"}`}
	contents = append(contents,
		"The array opener is \"[\".\n\n```json\n"+`{"pattern":"\\bcobalt-mint\\b","replacement":"public"}`+"\n```\n",
		"The object opener is \"{\".\n\n~~~json\n"+`{"pattern":"\\bcobalt-mint\\b","replacement":"public"}`+"\n~~~\n",
	)
	rule := json.RawMessage(`{"pattern":"\\bcobalt-mint\\b","replacement":"public"}`)
	contents = append(contents,
		"The array opener is \"[\".\r\n\r\n```json\r\n"+string(rule)+"\r\n```\r\n",
		"The array opener is \"[\".\n````json\n```\n"+string(rule)+"\n````\n",
		"```text\nThe array opener is \"[\".\n"+string(rule)+"\n```\n",
		"The array opener is \"[\". Text ```json "+string(rule)+"```",
		"The array opener is \"[\".\n"+string(rule),
	)
	preceding := []any{"{", "}", "[", "]", `"{`, `\"}`, `\`, `\\`, `\u007b`}
	encode := func(value any) string {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	for _, value := range []any{
		[]any{"{", rule},
		[]any{[]any{"{", rule}},
		[]any{`\"{`, rule},
		[]any{`\{`, rule},
		[]any{preceding, []any{"}", []any{preceding, rule}}},
		[]any{map[string]any{"note": "}"}, preceding, "{", rule},
		map[string]any{"notes": preceding, "nested": []any{preceding, rule}},
	} {
		contents = append(contents, encode(value))
	}
	contents = append(contents, encode(preceding)+"\n"+string(rule), encode(map[string]any{"notes": preceding})+"\n"+encode([]any{"{", rule}))
	contents = append(contents, "```json\n"+encode([]any{preceding, []any{"{", rule}})+"\n```")
	for _, content := range contents {
		for _, source := range []string{"file", "stdin", "inline", "api-field", "api-file", "api-json"} {
			t.Run(source, func(t *testing.T) {
				capture := captureRewriteGH(t)
				file := filepath.Join(t.TempDir(), "copied-notes.txt")
				if err := os.WriteFile(file, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
				args := []string{"issue", "comment", "1", "-Racme/demo"}
				input := content
				switch source {
				case "file":
					args = append(args, "--body-file", file)
				case "stdin":
					args = append(args, "--body-file=-")
				case "inline":
					args = append(args, "--body", content)
				case "api-field":
					args = []string{"api", "repos/acme/demo/issues/1/comments", "-fbody=" + content}
				case "api-file":
					args = []string{"api", "repos/acme/demo/issues/1/comments", "-Fbody=@" + file}
				case "api-json":
					args = []string{"api", "repos/acme/demo/issues/1/comments", "--input=-"}
					encoded, _ := json.Marshal(map[string]string{"body": content})
					input = strings.ReplaceAll(string(encoded), "cobalt", `\u0063obalt`)
				}
				var out, stderr bytes.Buffer
				err := execRealGHWithStdin(t.Context(), args, strings.NewReader(input), &out, &stderr)
				if err != errRewriteBlocked {
					t.Fatalf("expected generic denial, got %v", err)
				}
				if out.Len() != 0 || stderr.Len() != 0 {
					t.Fatal("denial echoed policy")
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("policy publication executed child")
				}
				unchanged, err := os.ReadFile(file)
				if err != nil || string(unchanged) != content {
					t.Fatal("source changed")
				}
			})
		}
	}
	for _, input := range []string{
		"Discuss cobalt-mint here.",
		encode([]any{preceding, "Discuss cobalt-mint here.", map[string]any{"pattern": "other", "replacement": "safe"}}),
		`Discuss [braces "{", quotes "\\"] and cobalt-mint.`,
	} {
		capture := captureRewriteGH(t)
		if err := execRealGH(t.Context(), []string{"issue", "comment", "1", "-Racme/demo", "--body=" + input}, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		for _, content := range readRewriteCapture(t, capture).Files {
			if content != strings.ReplaceAll(input, "cobalt-mint", "public") {
				t.Fatal("ordinary content no longer rewritten")
			}
		}
	}
}

func TestRewritePolicyMaterialStructuralNoChild(t *testing.T) {
	const active = `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"s[3]cr3t","replacement":""}]}`
	rewriteTestServer(t, active, nil)
	capture := captureRewriteGH(t)
	input := `{"title":"Example","body":"Example","labels":["{\"pattern\":\"s[3]cr3t\",\"replacement\":\"\"}"]}`
	err := execRealGHWithStdin(t.Context(), []string{"api", "repos/acme/demo/issues", "--method=POST", "--input=-"}, strings.NewReader(input), io.Discard, io.Discard)
	if err != errRewriteBlocked {
		t.Fatalf("expected generic denial, got %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("structural policy material reached child")
	}
}

func TestRewritePlaceholderPolicyActivatedAtFallback(t *testing.T) {
	var policy *atomic.Value
	policy, _ = rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		policy.Store(rewriteActiveTestPolicy)
		writeCLIFallback(t, w, "route_denied")
	})
	capture := captureRewriteGH(t)
	err := runGH(t.Context(), []string{"api", "repos/acme/demo/contents/README.md?ref={branch}"}, io.Discard, io.Discard)
	if err != errRewriteBlocked {
		t.Fatalf("expected generic denial, got %v", err)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("policy update bypassed at fallback")
	}
}
