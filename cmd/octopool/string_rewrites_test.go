package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func testRewritePolicy(t *testing.T, rules ...stringRewriteRule) stringRewritePolicy {
	t.Helper()
	policy, err := compileStringRewriteRules(rules)
	if err != nil {
		t.Fatal(err)
	}
	return policy
}
func TestStringRewriteSharedFixtures(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "test", "fixtures", "string-rewrites.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct {
			Name   string
			Rules  json.RawMessage
			Input  string
			Output string
			Error  bool
		}
		InvalidPolicies []struct {
			Name  string
			Rules json.RawMessage
		} `json:"invalid_policies"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, test := range fixtures.Cases {
		t.Run(test.Name, func(t *testing.T) {
			policy, err := parseStringRewritePolicy(append(append([]byte(`{"schema_version":1,"rules":`), test.Rules...), '}'), false)
			if err != nil {
				t.Fatal(err)
			}
			output, err := policy.rewrite(test.Input)
			if test.Error {
				if err == nil {
					t.Fatalf("expected rejection, got %q", output)
				}
				return
			}
			if err != nil || output != test.Output {
				t.Fatalf("output=%q err=%v want=%q", output, err, test.Output)
			}
		})
	}
	for _, test := range fixtures.InvalidPolicies {
		t.Run(test.Name, func(t *testing.T) {
			if _, err := parseStringRewritePolicy(append(append([]byte(`{"schema_version":1,"rules":`), test.Rules...), '}'), false); err == nil {
				t.Fatal("invalid policy accepted")
			}
		})
	}
}
func TestStringRewriteStrictDocuments(t *testing.T) {
	valid := `{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"public"}]}`
	for _, data := range []string{
		`{}`, `null`, `{"schema_version":1,"rules":null}`, `{"schema_version":1.0,"rules":[]}`,
		`{"schema_version":1,"rules":[],"extra":false}`, `{"schema_version":1,"rules":[],"rules":[]}`,
		`{"schema_version":1,"rules":[{"pattern":"a","replacement":"b","\u0072eplacement":"c"}]}`,
		valid + `{}`, strings.Replace(valid, "public", string([]byte{0xff}), 1), strings.Replace(valid, "public", `\ud800`, 1),
		strings.Replace(valid, "public", `\udfff`, 1), strings.Replace(valid, "public", `\ud800\u0061`, 1),
		strings.Repeat(" ", rewriteMaxDocument) + valid,
	} {
		if _, err := parseStringRewritePolicy([]byte(data), false); err != errRewritePolicy {
			t.Fatalf("expected generic rejection, got %v", err)
		}
	}
	for _, text := range []string{`\ud83e\udd9e`, `literal \\ud800`, `😀`} {
		if _, err := parseStringRewritePolicy([]byte(strings.Replace(valid, "public", text, 1)), false); err != nil {
			t.Fatalf("valid JSON Unicode rejected: %v", err)
		}
	}
	for _, data := range []string{
		`{"schema_version":1,"rules":[],"revision":0,"updated_at":"2026-08-28T00:00:00Z"}`,
		`{"schema_version":1,"rules":[],"revision":1,"updated_at":"not-time"}`,
		`{"schema_version":1,"rules":[],"revision":9007199254740992,"updated_at":"2026-08-28T00:00:00Z"}`,
		valid,
	} {
		if _, err := parseStringRewritePolicy([]byte(data), true); err == nil {
			t.Fatal("invalid server policy accepted")
		}
	}
}
func TestStringRewriteBoundsAndMerge(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	for _, text := range []string{strings.Repeat("x", rewriteMaxContent+1), string([]byte{0xff})} {
		if _, err := policy.rewrite(text); err == nil {
			t.Fatal("invalid content accepted")
		}
	}
	expand := testRewritePolicy(t, stringRewriteRule{"x", strings.Repeat("y", rewriteMaxReplacement)})
	if _, err := expand.rewrite(strings.Repeat("x", 2048)); err == nil {
		t.Fatal("intermediate expansion accepted")
	}
	for _, rule := range []stringRewriteRule{{strings.Repeat("a", 257), "b"}, {"a", strings.Repeat("b", 1025)}} {
		if _, err := compileStringRewriteRules([]stringRewriteRule{rule}); err == nil {
			t.Fatal("oversized rule accepted")
		}
	}
	same, err := mergeStringRewritePolicies(policy, policy)
	if err != nil || len(same.Rules) != 1 {
		t.Fatal("identical merge failed")
	}
	different := testRewritePolicy(t, stringRewriteRule{"internal-model", "other"})
	if _, err := mergeStringRewritePolicies(policy, different); err == nil {
		t.Fatal("conflicting override accepted")
	}
	local := testRewritePolicy(t, stringRewriteRule{"public", "approved"})
	merged, err := mergeStringRewritePolicies(policy, local)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := merged.rewrite("internal-model"); err != nil || got != "approved" {
		t.Fatalf("merge order: %q %v", got, err)
	}
	badLocal := testRewritePolicy(t, stringRewriteRule{"private", "internal-model"})
	merged, err = mergeStringRewritePolicies(policy, badLocal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := merged.rewrite("private"); err == nil {
		t.Fatal("local policy weakened server policy")
	}
	rules := []stringRewriteRule{}
	for i := 0; i < rewriteMaxRules; i++ {
		rules = append(rules, stringRewriteRule{strings.Repeat("a", i+1), "b"})
	}
	full := testRewritePolicy(t, rules...)
	if _, err := mergeStringRewritePolicies(full, policy); err == nil {
		t.Fatal("combined limit not enforced")
	}
}
func TestStringRewriteStructuralDecoding(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	for _, value := range []string{"internal-model", "%69nternal-model", "%2569nternal-model", `\u0069nternal-model`, "%ff", "%2525252561"} {
		if err := policy.checkStructural(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	for _, request := range []ghAPIRequest{
		{method: "GET", path: "/repos/acme/internal-model"},
		{method: "GET", path: "/repos/acme/safe", query: map[string]any{"q": "%69nternal-model"}},
		{method: "GET", path: "/repos/acme/safe", query: map[string]any{"internal-model": "safe"}},
		{method: "GET", path: "/repos/acme/safe", headers: map[string]string{"accept": "internal-model"}},
		{method: "GET", path: "/repos/acme/safe", headers: map[string]string{"authorization": "safe"}},
		{method: "GET", path: "/repos/acme/%252e%252e"},
	} {
		if err := policy.guardRequest(request); err == nil {
			t.Fatal("unsafe request accepted")
		}
	}
}
func TestStringRewriteFileReadBounded(t *testing.T) {
	if _, err := boundedRewriteRead(strings.NewReader(strings.Repeat("x", 20)), 10); err == nil {
		t.Fatal("read exceeded bound")
	}
	if _, err := readRewriteFile(t.TempDir(), nil, 20); err == nil {
		t.Fatal("directory accepted")
	}
	if _, err := readRewriteFile("-", nil, 20); err == nil {
		t.Fatal("nil stdin accepted")
	}
}
func TestStringRewritePreparationRejectsUnknownShapes(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	tests := [][]string{
		{"pr", "create", "--title", "safe", "--body", "safe", "--repo", "acme/repo", "--head", "main", "--base", "bad base"},
		{"pr", "create", "--title", "safe", "--body", "safe", "--repo", "acme/repo", "--head", "main", "--base", "main", "--fill"},
		{"issue", "create", "--title", "safe", "--body", "safe", "--template", "x", "--repo", "acme/repo"},
		{"pr", "edit", "--body", "safe", "--repo", "acme/repo"},
		{"pr", "edit", "1", "--body", "safe", "--body-file", "-", "--repo", "acme/repo"},
		{"pr", "comment", "1", "--body", "safe", "--editor", "--repo", "acme/repo"},
		{"pr", "review", "1", "--body", "safe", "--repo", "acme/repo"},
		{"pr", "review", "1", "--approve", "--comment", "--body", "safe", "--repo", "acme/repo"},
		// Asset-bearing creation requires an explicit draft, even with verify-tag.
		{"release", "create", "v1", "asset.zip", "--notes", "safe", "--title", "safe", "--verify-tag", "--repo", "acme/repo"},
		{"release", "create", "v1", "--notes", "safe", "--title", "safe", "--repo", "acme/repo"},
		{"release", "create", "v1", "--notes", "safe", "--title", "safe", "--verify-tag=false", "--repo", "acme/repo"},
		{"release", "create", "v1", "--notes", "safe", "--title", "safe", "--generate-notes", "--verify-tag", "--repo", "acme/repo"},
		{"issue", "edit", "1", "-bfoo", "--body=bar", "--repo", "acme/repo"},
		{"issue", "edit", "--body", "safe", "--repo", "acme/repo", "--", "1"},
		{"pr", "edit", "https://github.com/acme/repo/pull/1", "--body", "safe", "--repo", "acme/repo"},
	}
	for _, args := range tests {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			p := &rewritePreparation{}
			defer p.cleanup()
			if err := prepareRewriteContent(policy, args, strings.NewReader("safe"), p); err == nil {
				t.Fatalf("accepted %v", args)
			}
		})
	}
}
func TestStringRewritePRCreateDerivesCurrentBranchHead(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init", "--quiet", "--initial-branch", "feature/derive-head", repo},
		{"-C", repo, "remote", "add", "origin", "https://github.com/acme/repo"},
	} {
		if out, err := exec.CommandContext(t.Context(), "git", args...).CombinedOutput(); err != nil {
			t.Fatalf("synthetic repo: %v %s", err, out)
		}
	}
	t.Chdir(repo)
	body := filepath.Join(repo, "body.md")
	if err := os.WriteFile(body, []byte("hello world\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &rewritePreparation{}
	defer p.cleanup()
	args := []string{"pr", "create", "--dry-run", "--draft", "--title", "t", "--body-file", body, "--repo", "acme/repo"}
	if err := prepareRewriteContent(policy, args, nil, p); err != nil {
		t.Fatalf("standard pr create blocked: %v", err)
	}
	if !slices.Contains(p.args, "--head=feature/derive-head") {
		t.Fatalf("derived head missing: %v", p.args)
	}
	if !slices.Contains(p.args, "--dry-run=true") || !slices.Contains(p.args, "--draft=true") {
		t.Fatalf("boolean flags dropped: %v", p.args)
	}
}

func TestStringRewritePRCreateWithoutBranchBlocked(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "public"})
	t.Chdir(t.TempDir()) // not a git repository, so no branch can pin --head
	p := &rewritePreparation{}
	defer p.cleanup()
	args := []string{"pr", "create", "--title", "safe", "--body", "safe", "--repo", "acme/repo"}
	if err := prepareRewriteContent(policy, args, nil, p); err == nil {
		t.Fatal("accepted pr create without a derivable head")
	}
}

func TestStringRewriteLiteralReplacementAndFlags(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"internal-model", "--web=$1"})
	p := &rewritePreparation{}
	defer p.cleanup()
	err := prepareRewriteContent(policy, []string{"issue", "create", "-tinternal-model", "-b=internal-model", "-Racme/repo"}, nil, p)
	if err != nil {
		t.Fatal(err)
	}
	if p.args[3] != "--title=--web=$1" {
		t.Fatalf("args=%q", p.args)
	}
	var content []byte
	for _, arg := range p.args {
		if path, ok := strings.CutPrefix(arg, "--body-file="); ok {
			content, err = os.ReadFile(path)
		}
	}
	if err != nil || !bytes.Equal(content, []byte("--web=$1")) {
		t.Fatalf("content=%q err=%v", content, err)
	}
}

func TestStringRewriteSkippedAdjacentZeroWidth(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{`x|\b`, ""})
	if _, err := policy.rewrite("x"); err != errRewriteBlocked {
		t.Fatal("Go suppressed an adjacent zero-width match", err)
	}
}
