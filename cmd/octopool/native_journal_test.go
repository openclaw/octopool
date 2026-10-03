package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNativeJournalRedaction(t *testing.T) {
	for _, test := range []struct {
		name, want string
		args       []string
	}{
		{"pr", "gh pr view --jq --json=mergeStateStatus,title --repo", []string{"pr", "view", "952713", "-Rsecret-owner/secret-repo", "--json", "title,mergeStateStatus", "--jq", ".secretFilter"}},
		{"positionals", "gh search issues --json=comments,number --repo", []string{"search", "issues", "secret search query", "1234567", "--repo=secret-owner/secret-repo", "--json=number,comments"}},
		{"write", "gh pr create --body --repo --title", []string{"pr", "create", "--title", "--json=secret", "--body=ghp_SUPERSECRET", "-R", "secret-owner/secret-repo"}},
		{"api", "gh api GET /repos/:owner/:repo/pulls/:number --header --include --jq --method", []string{"api", "--include", "-XGET", "repos/secret-owner/secret-repo/pulls/952713?token=ghp_SUPERSECRET", "-H", "Authorization: Bearer ghp_SUPERSECRET", "--jq", ".secretFilter"}},
		{"api-bundle", "gh api POST /repos/:owner/:repo/issues/:number/comments --field --include", []string{"api", "repos/secret-owner/secret-repo/issues/952713/comments", "-iFbody=ghp_SUPERSECRET"}},
		{"graphql", "gh api POST graphql:PanelQuery --field --raw-field", []string{"api", "graphql", "-f", `query=query PanelQuery($repo:String!){repository(name:$repo,owner:"secret-owner"){id}}`, "-F", "repo=secret-repo", "-f", "token=ghp_SUPERSECRET"}},
		{"anonymous", "gh api POST graphql --raw-field", []string{"api", "graphql", "-fquery={viewer{login}}"}},
		{"file-query", "gh api POST graphql --field", []string{"api", "graphql", "-Fquery=@/secret/path/query.graphql"}},
		{"secret-operation", "gh api POST graphql --raw-field", []string{"api", "graphql", "-fquery=query ghp_SUPERSECRET {viewer{login}}"}},
		{"input", "gh api POST /:segment/:segment --input", []string{"api", "secret-endpoint/952713", "--input=/secret/path/input.json"}},
		{"unknown-fields", "gh pr view --json=:field,number", []string{"pr", "view", "952713", "--json=ghp_SUPERSECRET,/secret/path,952713,number"}},
		{"unknown-flag", "gh pr view --unknown", []string{"pr", "view", "--ghp_SUPERSECRET", "--json=ghp_SUPERSECRET"}},
		{"unknown-command", "gh :command", []string{"ghp_SUPERSECRET", "secret-position", "--json=number"}},
		{"delimiter", "gh pr view", []string{"pr", "view", "--", "--json=ghp_SUPERSECRET", "--repo=secret-owner/secret-repo"}},
		{"url", "gh api GET /repos/:owner/:repo/contents/:segment/:segment", []string{"api", "https://secret-user:ghp_SUPERSECRET@secret-host/repos/secret-owner/secret-repo/contents/secret-path/secret-file?ref=secret-ref#secret-fragment"}},
		{"workflow-json", "gh workflow view --json=name,path", []string{"workflow", "view", "secret-file.yml", "--json=name,path"}},
		{"workflow-stdin", "gh workflow run --json --repo", []string{"workflow", "run", "secret-file.yml", "--json", "-Rsecret-owner/secret-repo"}},
		{"nested-command", "gh repo autolink view --repo", []string{"repo", "autolink", "view", "952713", "-Rsecret-owner/secret-repo"}},
		{"api-delimiter", "gh api GET /repos/:owner/:repo/pulls/:number --include", []string{"api", "--include", "--", "repos/secret-owner/secret-repo/pulls/952713"}},
		{"graphql-comments", "gh api POST graphql:PanelQuery --raw-field", []string{"api", "graphql", "-fquery=# ghp_SUPERSECRET\nquery PanelQuery {viewer{login}}"}},
		{"graphql-url", "gh api POST graphql:PanelQuery --raw-field", []string{"api", "https://secret-host/graphql?token=ghp_SUPERSECRET", "-fquery=query PanelQuery {viewer{login}}"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := append([]string(nil), test.args...)
			shape := describeNativeShape(test.args)
			if shape.text != test.want {
				t.Fatalf("shape = %q, want %q", shape.text, test.want)
			}
			for _, forbidden := range []string{"secret", "952713", "1234567", "ghp_", "https:", "Authorization", "Bearer", "viewer", "repository("} {
				if strings.Contains(strings.ToLower(shape.text), strings.ToLower(forbidden)) {
					t.Fatalf("journal leaked %q: %s", forbidden, shape.text)
				}
			}
			if !reflect.DeepEqual(before, test.args) {
				t.Fatal("observer mutated command arguments")
			}
		})
	}
}

func TestNativeJournalCategories(t *testing.T) {
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"pr", "view", "1", "--json", "mergeStateStatus"}, "native-json-fields"},
		{[]string{"issue", "view", "1", "--json=comments"}, "native-json-fields"},
		{[]string{"api", "graphql", "-fquery=query Panel {viewer{login}}"}, "graphql-delegated"},
		{[]string{"api", "graphql", "-fquery=mutation {addComment(input:{body:\"secret\"}){id}}"}, "write"},
		{[]string{"api", "user", "-i"}, "include"},
		{[]string{"api", "user", "--template", "--include"}, "unsupported-command"},
		{[]string{"api", "user", "-i", "--include=false"}, "unsupported-command"},
		{[]string{"api", "repos/owner/repo/issues/1/comments", "-fbody=secret"}, "write"},
		{[]string{"pr", "merge", "1"}, "write"},
		{[]string{"extension", "exec", "custom"}, "unsupported-command"},
	} {
		shape := describeNativeShape(test.args)
		if got := shape.category(test.args); got != test.want {
			t.Errorf("%v category = %s, want %s", test.args[:2], got, test.want)
		}
	}
	if got := nativeFallbackReason("private repo secret-owner/secret-repo ghp_secret"); got != "other" {
		t.Fatal("untrusted fallback reason leaked")
	}
}

func journalTestPath(t *testing.T) string {
	t.Helper()
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(cache, "octopool", nativeJournalName)
}

func readJournalEntries(t *testing.T, path string) []nativeDelegation {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	entries := []nativeDelegation{}
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		var entry nativeDelegation
		if err := json.Unmarshal(line, &entry); err != nil {
			t.Fatalf("invalid journal line: %v", err)
		}
		entries = append(entries, entry)
	}
	return entries
}

func TestNativeJournalOptOutAndMetadata(t *testing.T) {
	isolateTestConfig(t)
	isolateRelaySlotTemp(t)
	args := []string{"api", "user", "--include", "--jq=.login"}
	journalNativeDelegation(t.Context(), args, []string{"OCTOPOOL_NATIVE_JOURNAL=0"}, "")
	if _, err := os.Stat(journalTestPath(t)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("opt-out wrote journal: %v", err)
	}
	journalNativeDelegation(t.Context(), args, []string{"OCTOPOOL_FRESH="}, "")
	journalNativeDelegation(withNativeFallback(t.Context(), localFallbackError{Reason: "relay_overloaded"}), args, nil, "")
	entries := readJournalEntries(t, journalTestPath(t))
	if len(entries) != 2 || !entries[0].Fresh || entries[1].Fresh || entries[0].Category != "include" || entries[1].Category != "local-fallback:relay_overloaded" {
		t.Fatalf("incorrect records: %+v", entries)
	}
	entry := entries[0]
	if entry.Version != version || entry.PPID != os.Getppid() || time.Since(entry.TS) > 5*time.Second || entry.TS.Location() != time.UTC || entry.GraphQL == nil || *entry.GraphQL {
		t.Fatalf("incorrect metadata: %+v", entry)
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		if entry.Parent == "" || strings.Contains(entry.Parent, "/") {
			t.Fatalf("missing process basename: %+v", entry)
		}
	}
}

func TestNativeJournalRotation(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, nativeJournalName)
	large := bytes.Repeat([]byte{'x'}, nativeJournalLimit+1)
	if err := os.WriteFile(path, large, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".1", []byte("older"), 0600); err != nil {
		t.Fatal(err)
	}
	line := []byte("{\"shape\":\"gh api GET /user\"}\n")
	if err := appendNativeJournal(directory, line); err != nil {
		t.Fatal(err)
	}
	current, _ := os.ReadFile(path)
	previous, _ := os.ReadFile(path + ".1")
	if !bytes.Equal(current, line) || !bytes.Equal(previous, large) {
		t.Fatal("rotation lost the previous generation or new record")
	}
	if err := appendNativeJournal(directory, line); err != nil {
		t.Fatal(err)
	}
	current, _ = os.ReadFile(path)
	if !bytes.Equal(current, append(append([]byte{}, line...), line...)) {
		t.Fatal("append did not preserve line boundaries")
	}
}

func TestNativeJournalConcurrentAppends(t *testing.T) {
	directory := t.TempDir()
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			for range 32 {
				if err := appendNativeJournal(directory, []byte(`{"shape":"gh api GET /user"}`+"\n")); err != nil {
					t.Error(err)
				}
			}
		})
	}
	workers.Wait()
	if entries := readJournalEntries(t, filepath.Join(directory, nativeJournalName)); len(entries) != 512 {
		t.Fatalf("concurrent appends lost records: %d", len(entries))
	}
}

func TestNativeJournalFallbackAndAggregation(t *testing.T) {
	isolateTestConfig(t)
	isolateRelaySlotTemp(t)
	path := journalTestPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	// A directory at the file path deterministically models an unusable cache.
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	journalNativeDelegation(t.Context(), []string{"api", "user", "--include"}, nil, "")
	directory, err := fallbackRelaySlotDirectory()
	if err != nil {
		t.Fatal(err)
	}
	fallbackPath := filepath.Join(directory, nativeJournalName)
	if entries := readJournalEntries(t, fallbackPath); len(entries) != 1 {
		t.Fatal("missing fallback record")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	write := func(path string, entries ...nativeDelegation) {
		t.Helper()
		var data bytes.Buffer
		for _, entry := range entries {
			if err := json.NewEncoder(&data).Encode(entry); err != nil {
				t.Fatal(err)
			}
		}
		data.WriteString("invalid record\n{\"truncated\":")
		if err := os.WriteFile(path, data.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	a := nativeDelegation{TS: now, Parent: "App", Category: "include", Shape: "gh api GET /user --include"}
	b := nativeDelegation{TS: now, Parent: "Shell", Category: "write", Shape: "gh pr merge"}
	old := a
	old.TS = now.Add(-48 * time.Hour)
	write(path, a, b, old)
	write(path+".1", a)
	write(fallbackPath, a)
	write(fallbackPath+".1", b)
	summary := aggregateNativeDelegations([]string{path, fallbackPath, path}, now.Add(-24*time.Hour), 1)
	if summary.Total != 5 || len(summary.Groups) != 1 || summary.Groups[0].Count != 3 || summary.Groups[0].Parent != "App" {
		t.Fatalf("incorrect aggregate: %+v", summary)
	}
	for _, jsonOutput := range []bool{false, true} {
		var output bytes.Buffer
		args := []string{"native-delegations", "--since", "1d", "--top", "1"}
		if jsonOutput {
			args = append(args, "--json")
		}
		if err := run(t.Context(), args, &output, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		if jsonOutput {
			var got nativeDelegationSummary
			if json.Unmarshal(output.Bytes(), &got) != nil || got.Total != 5 || !reflect.DeepEqual(got.Groups, summary.Groups) {
				t.Fatalf("JSON summary: %s", output.String())
			}
		} else if !strings.Contains(output.String(), "5 total") || !strings.Contains(output.String(), "App") || strings.Contains(output.String(), "Shell") {
			t.Fatalf("human summary: %s", output.String())
		}
	}
	for _, args := range [][]string{{"--since=bad"}, {"--since=0"}, {"--since=-1h"}, {"--since=999999999999d"}, {"--top=0"}, {"extra"}} {
		if err := runNativeDelegations(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted invalid flags %v", args)
		}
	}
}

func TestNativeJournalDoesNotChangeDelegation(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		code string
	}{
		{"include", []string{"api", "user", "--include", "--jq", ".login"}, "0"},
		{"graphql", []string{"pr", "view", "721", "-R", "synthetic/repo", "--json", "mergeStateStatus"}, "0"},
		{"write-failure", []string{"pr", "create", "--title=synthetic-title", "--body=synthetic-body"}, "7"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				t.Error("unexpected relay request")
			})
			captureRewriteGH(t)
			t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", test.code)
			t.Setenv("OCTOPOOL_REST_WRITES", "0")
			t.Setenv("GH_HOST", "github.com")
			t.Setenv("GH_REPO", "")
			var baselineOut, baselineErr string
			var baselineResult error
			for _, enabled := range []string{"0", "1"} {
				t.Setenv("OCTOPOOL_NATIVE_JOURNAL", enabled)
				var stdout, stderr bytes.Buffer
				err := runGH(context.Background(), test.args, &stdout, &stderr)
				if enabled == "0" {
					baselineOut, baselineErr, baselineResult = stdout.String(), stderr.String(), err
					continue
				}
				if stdout.String() != baselineOut || stderr.String() != baselineErr || !reflect.DeepEqual(err, baselineResult) {
					t.Fatalf("journal changed native protocol: stdout=%q stderr=%q err=%v (baseline %q %q %v)", stdout.String(), stderr.String(), err, baselineOut, baselineErr, baselineResult)
				}
			}
			entries := readJournalEntries(t, journalTestPath(t))
			entry := entries[len(entries)-1]
			if entry.Shape != describeNativeShape(test.args).text || entry.Category != describeNativeShape(test.args).category(test.args) {
				t.Fatalf("incorrect dispatch record: %+v", entry)
			}
			data, _ := os.ReadFile(journalTestPath(t))
			for _, forbidden := range []string{"synthetic/", "synthetic-title", "synthetic-body", ".login"} {
				if strings.Contains(string(data), forbidden) {
					t.Fatalf("journal leaked argument %q", forbidden)
				}
			}
		})
	}
}

func TestNativeJournalAggregationReadsOverLimitTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), nativeJournalName)
	entry := nativeDelegation{TS: time.Now().UTC(), Parent: "App", Category: "include", Shape: "gh api GET /user --include"}
	line, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	line = append(line, '\n')
	count := nativeJournalLimit/len(line) + 1024
	if err := os.WriteFile(path, bytes.Repeat(line, count), 0600); err != nil {
		t.Fatal(err)
	}
	// Rotation can be deferred by contention; every retained record still counts.
	summary := aggregateNativeDelegations([]string{path}, entry.TS.Add(-time.Hour), 20)
	if summary.Total != count {
		t.Fatalf("oversized journal tail lost: got %d, want %d", summary.Total, count)
	}
}

func TestNativeJournalFallbackBoundary(t *testing.T) {
	rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	captureRewriteGH(t)
	t.Setenv("OCTOPOOL_NATIVE_JOURNAL", "1")
	args := []string{"api", "user"}
	reason := localFallbackError{Reason: "local_credentials_required"}
	t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
	if err := execRealGHAfterLocalFallback(t.Context(), args, &bytes.Buffer{}, &bytes.Buffer{}, reason); !reflect.DeepEqual(err, reason) {
		t.Fatalf("fallback refusal changed: %v", err)
	}
	if _, err := os.Stat(journalTestPath(t)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("refused handoff was journaled")
	}
	t.Setenv("OCTOPOOL_NO_FALLBACK", "")
	if err := execRealGHAfterLocalFallback(t.Context(), args, &bytes.Buffer{}, &bytes.Buffer{}, reason); err != nil {
		t.Fatal(err)
	}
	if entries := readJournalEntries(t, journalTestPath(t)); len(entries) != 1 || entries[0].Category != "local-fallback:local_credentials_required" {
		t.Fatalf("fallback reason lost: %+v", entries)
	}
}

// Compiled shim -> synthetic native child, with no live GitHub credentials or writes.
func TestNativeJournalCLIProof(t *testing.T) {
	binary := buildCLIBinary(t)
	rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		t.Error("delegation unexpectedly reached relay")
	})
	isolateRelaySlotTemp(t)
	captureRewriteGH(t)
	t.Setenv("OCTOPOOL_NATIVE_JOURNAL", "1")
	t.Setenv("GH_HOST", "github.com")
	t.Setenv("GH_REPO", "")
	for _, args := range [][]string{
		{"gh", "api", "--include", "user", "--jq", ".login"},
		{"gh", "pr", "view", "721", "-R", "synthetic/repository", "--json", "title,mergeStateStatus"},
	} {
		cmd := exec.CommandContext(t.Context(), binary, args...)
		cmd.Env = os.Environ()
		cmd.Stderr = &bytes.Buffer{}
		if output, err := cmd.Output(); err != nil || string(output) != "child stdout\n" {
			t.Fatalf("compiled dispatch: %s %v", output, err)
		}
	}
	entries := readJournalEntries(t, journalTestPath(t))
	if len(entries) != 3 || entries[0].Category != "include" || entries[1].Category != "quota-probe" || entries[2].Category != "native-json-fields" {
		t.Fatalf("unexpected native executions: %+v", entries)
	}
	data, _ := os.ReadFile(journalTestPath(t))
	t.Logf("compiled shim journal (synthetic inputs, native stderr discarded):\n%s", data)
	for _, flags := range [][]string{{"native-delegations"}, {"native-delegations", "--json"}} {
		cmd := exec.CommandContext(t.Context(), binary, flags...)
		cmd.Env = os.Environ()
		output, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s:\n%s", strings.Join(flags, " "), output)
	}
}

func BenchmarkNativeJournalAppend(b *testing.B) {
	directory := b.TempDir()
	line := []byte(`{"ts":"2026-10-03T00:00:00Z","version":"dev","ppid":1,"parent":"App","grandparent":"launchd","shape":"gh api GET /user --include","category":"include","graphql":false,"fresh":false}` + "\n")
	b.ResetTimer()
	for b.Loop() {
		if err := appendNativeJournal(directory, line); err != nil {
			b.Fatal(err)
		}
	}
}
