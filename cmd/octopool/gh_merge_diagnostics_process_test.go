package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func mergeDiagnosticArgs() []string {
	return []string{"pr", "merge", "7", "--repo=acme/repo", "--squash", "--match-head-commit=" + strings.Repeat("a", 40)}
}

func mergeDiagnosticLine(t *testing.T, stderr string) string {
	t.Helper()
	var found string
	for _, line := range strings.Split(stderr, "\n") {
		if strings.HasPrefix(line, "octopool: merge_diagnostics ") {
			if found != "" {
				t.Fatal("multiple diagnostics for one child")
			}
			found = line
		}
	}
	if found == "" {
		t.Fatal("missing merge diagnostic")
	}
	allowed := strings.Fields("attempt_utc elapsed_ms child_started outcome route server_policy_revision effective_rule_count exit_code headers http_status request_id resource limit remaining used reset retry_after")
	for _, field := range strings.Fields(found)[2:] {
		key, value, ok := strings.Cut(field, "=")
		if !ok || value == "" || !slices.Contains(allowed, key) {
			t.Fatalf("unexpected diagnostic field %q", field)
		}
		if key == "attempt_utc" {
			if stamp, err := time.Parse(time.RFC3339Nano, value); err != nil || stamp.Location() != time.UTC {
				t.Fatal("attempt timestamp is not UTC")
			}
		}
	}
	return found
}

func assertMergeSnapshot(t *testing.T, capture rewriteCapture, include bool, title, body string) {
	t.Helper()
	if len(capture.Files) != 1 || capture.Stdin != "" || capture.Env["GH_HOST"] != "github.com" || capture.Env["GH_REPO"] != "" {
		t.Fatal("snapshot, stdin, or host pin changed")
	}
	for path, data := range capture.Files {
		want := []string{"api", "repos/acme/repo/pulls/7/merge", "--method=PUT", "--hostname=github.com", "--input=" + path, "--silent=true"}
		if include {
			want = append(want, ghMergeIncludeFlag)
		}
		if !slices.Equal(capture.Args, want) {
			t.Fatalf("unexpected generated argv: %q", capture.Args)
		}
		var payload map[string]string
		if err := json.Unmarshal([]byte(data), &payload); err != nil || len(payload) != 4 || payload["sha"] != strings.Repeat("a", 40) || payload["merge_method"] != "squash" || payload["commit_title"] != title || payload["commit_message"] != body {
			t.Fatal("exact-head squash payload changed")
		}
		if capture.Modes[path] != 0600 || capture.DirectoryModes[path] != 0700 {
			t.Fatal("snapshot privacy changed")
		}
		if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
			t.Fatal("snapshot survived completion")
		}
	}
}

func TestGHMergeDiagnosticsOff(t *testing.T) {
	for _, enabled := range []string{"", "0", "true", "01", "1 ", " 1"} {
		for _, active := range []bool{false, true} {
			t.Run(enabled+"/"+map[bool]string{false: "native", true: "converted"}[active], func(t *testing.T) {
				policy := rewriteEmptyTestPolicy
				if active {
					policy = rewriteActiveTestPolicy
				}
				_, policies := rewriteTestServer(t, policy, nil)
				capturePath := captureRewriteGH(t)
				t.Setenv("OCTOPOOL_DIAGNOSTICS", enabled)
				t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", "17")
				t.Setenv("GH_HOST", "synthetic.example")
				t.Setenv("GH_REPO", "synthetic/repo")
				// Only these explicitly seeded synthetic keys are captured.
				t.Setenv("OCTOPOOL_TEST_SYNTHETIC_AUTH", "1")
				for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"} {
					t.Setenv(key, "synthetic-"+key)
				}
				bodyFile := filepath.Join(t.TempDir(), "body.txt")
				if err := os.WriteFile(bodyFile, []byte("body"), 0600); err != nil {
					t.Fatal(err)
				}
				args := append(mergeDiagnosticArgs(), "--subject=subject", "--body-file="+bodyFile)
				var stdout, stderr bytes.Buffer
				err := execRealGHWithStdin(t.Context(), args, strings.NewReader("body"), &stdout, &stderr)
				var exit exitCodeError
				if !errors.As(err, &exit) || exit.Code != 17 || stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" || policies.Load() != 1 {
					t.Fatal("disabled diagnostics changed streams, exit, or policy reads")
				}
				capture := readRewriteCapture(t, capturePath)
				for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"} {
					if capture.Env[key] != "synthetic-"+key {
						t.Fatal("synthetic child auth changed")
					}
				}
				if active {
					assertMergeSnapshot(t, capture, false, "subject", "body")
				} else if !slices.Equal(args, capture.Args) || capture.Stdin != "body" || capture.Env["GH_HOST"] != "synthetic.example" || capture.Env["GH_REPO"] != "synthetic/repo" {
					t.Fatal("native dispatch changed")
				}
			})
		}
	}
}

func TestGHMergeDiagnosticsFinalPolicy(t *testing.T) {
	active := strings.Replace(rewriteActiveTestPolicy, `"revision":1`, `"revision":22`, 1)
	empty := strings.Replace(rewriteEmptyTestPolicy, `"revision":1`, `"revision":33`, 1)
	for _, test := range []struct {
		name, first, final, want string
		failure                  int
	}{
		{"active_to_empty", active, empty, "route=native server_policy_revision=33 effective_rule_count=0", 0},
		{"empty_to_active", empty, active, "route=rest_put server_policy_revision=22 effective_rule_count=1", 0},
		{"final_load_failure", active, "", "outcome=preparation_failed", 403},
		{"final_structural_denial", empty, strings.Replace(active, "internal-model", "acme", 1), "outcome=preparation_failed", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			policies := rewriteTestServerPolicySequence(t, func(n int64) (string, int) {
				if n == 1 {
					return test.first, 200
				}
				if n != 2 {
					t.Error("unexpected extra policy request")
				}
				if test.failure != 0 {
					return "", test.failure
				}
				return test.final, 200
			}, nil)
			capturePath := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", mergeHeaderFrame(403, 4958))
			var stdout, stderr bytes.Buffer
			args := mergeDiagnosticArgs()
			original := slices.Clone(args)
			err := runGH(t.Context(), args, &stdout, &stderr)
			line := mergeDiagnosticLine(t, stderr.String())
			if !strings.Contains(line, test.want) || policies.Load() != 2 || !slices.Equal(args, original) {
				t.Fatalf("final policy facts/count/argv incorrect: %s", line)
			}
			if strings.Contains(test.name, "failure") || strings.Contains(test.name, "denial") {
				if err == nil || stdout.Len() != 0 || strings.Contains(line, "route=") || !strings.Contains(line, "child_started=false") {
					t.Fatal("failed preparation claimed a dispatched child")
				}
				if test.failure != 0 && strings.Contains(line, "server_policy_revision=") {
					t.Fatal("stale policy attributed on load failure")
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("final failure launched child")
				}
				return
			}
			if err != nil || !strings.HasPrefix(stderr.String(), "child stderr\n") || !strings.Contains(line, "child_started=true outcome=succeeded") {
				t.Fatal("child outcome changed")
			}
			capture := readRewriteCapture(t, capturePath)
			if test.final == empty {
				if !slices.Equal(capture.Args, args) || stdout.String() != mergeHeaderFrame(403, 4958) || strings.Contains(line, "http_status=") {
					t.Fatal("native stream intercepted or guessed HTTP attribution")
				}
			} else if stdout.Len() != 0 || !slices.Contains(capture.Args, ghMergeIncludeFlag) || !strings.Contains(line, "http_status=403") {
				t.Fatal("converted metadata was not captured")
			}
		})
	}
}

type onceMergeReader struct {
	read   bool
	cancel context.CancelFunc
}

func (reader *onceMergeReader) Read(p []byte) (int, error) {
	if reader.read {
		return 0, errors.New("source reread sentinel")
	}
	reader.read = true
	if reader.cancel != nil {
		reader.cancel()
	}
	return copy(p, "body-private-sentinel"), io.EOF
}

type mergeDiagnosticWriter struct {
	buffer           bytes.Buffer
	rejectDiagnostic bool
	rejectNative     bool
}

var errMergeWriter = errors.New("writer-private-sentinel")

func (writer *mergeDiagnosticWriter) Write(p []byte) (int, error) {
	if (writer.rejectDiagnostic && bytes.HasPrefix(p, []byte("octopool: merge_diagnostics"))) ||
		(writer.rejectNative && bytes.Equal(p, []byte("child stderr\n"))) {
		return 0, errMergeWriter
	}
	return writer.buffer.Write(p)
}

func (writer *mergeDiagnosticWriter) String() string { return writer.buffer.String() }

func (writer *mergeDiagnosticWriter) WriteString(s string) (int, error) {
	return writer.Write([]byte(s))
}

func TestGHMergeDiagnosticsConvertedOnce(t *testing.T) {
	for _, test := range []struct {
		name, frame string
		exit        string
		writerError bool
	}{
		{"success", mergeHeaderFrame(200, 4958), "0", false},
		{"forbidden_zero", mergeHeaderFrame(403, 0), "1", false},
		{"forbidden_positive", mergeHeaderFrame(403, 4958), "1", false},
		{"throttled", mergeHeaderFrame(429, 0), "1", false},
		{"malformed", mergeHeaderFrame(403, 0) + "body-private-sentinel", "1", false},
		{"diagnostic_writer_failure_success", mergeHeaderFrame(200, 4958), "0", true},
		{"diagnostic_writer_failure_exit", mergeHeaderFrame(403, 0), "17", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capturePath := captureRewriteGH(t)
			calls := filepath.Join(t.TempDir(), "calls")
			t.Setenv("OCTOPOOL_TEST_REWRITE_CALLS", calls)
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", test.frame)
			t.Setenv("OCTOPOOL_TEST_REWRITE_EXIT", test.exit)
			t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
			t.Setenv("GH_HOST", "host-private-sentinel")
			t.Setenv("GH_REPO", "repo-private-sentinel")
			t.Setenv("OCTOPOOL_TEST_SYNTHETIC_AUTH", "1")
			for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"} {
				t.Setenv(key, "synthetic-"+key)
			}
			reader := &onceMergeReader{}
			var stdout bytes.Buffer
			stderr := &mergeDiagnosticWriter{rejectDiagnostic: test.writerError}
			err := execRealGHWithStdin(t.Context(), append(mergeDiagnosticArgs(), "--subject=title-private-sentinel", "--body-file=-"), reader, &stdout, stderr)
			var exit exitCodeError
			if test.exit == "0" {
				if err != nil {
					t.Fatal("diagnostics altered success")
				}
			} else if !errors.As(err, &exit) || test.exit != strconv.Itoa(exit.Code) {
				t.Fatal("diagnostics altered native exit")
			}
			data, readErr := os.ReadFile(calls)
			if readErr != nil || string(data) != "child\n" || policies.Load() != 1 || stdout.Len() != 0 {
				t.Fatal("extra child/policy/output or retry")
			}
			capture := readRewriteCapture(t, capturePath)
			assertMergeSnapshot(t, capture, true, "title-private-sentinel", "body-private-sentinel")
			for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"} {
				if capture.Env[key] != "synthetic-"+key {
					t.Fatal("diagnostics changed synthetic child auth")
				}
			}
			if !strings.HasPrefix(stderr.String(), "child stderr\n") {
				t.Fatal("native stderr changed")
			}
			if test.writerError {
				if stderr.String() != "child stderr\n" {
					t.Fatal("failed diagnostic writer changed native output")
				}
				return
			}
			line := mergeDiagnosticLine(t, stderr.String())
			for _, sentinel := range []string{"private-sentinel", "acme", "pulls", strings.Repeat("a", 40), "--input", capturePath} {
				if strings.Contains(line, sentinel) {
					t.Fatal("private material reached added diagnostic")
				}
			}
			if test.name == "malformed" {
				if !strings.Contains(line, "headers=unavailable") || strings.Contains(line, "http_status=") {
					t.Fatal("body spoof retained fields")
				}
			} else if !strings.Contains(line, "headers=available") || !strings.Contains(line, "resource=core") {
				t.Fatal("valid metadata missing")
			}
		})
	}
}

func TestGHMergeDiagnosticsIncludeDenial(t *testing.T) {
	for _, pattern := range []string{"^--include$", "^--include=true$", "^true$"} {
		t.Run(pattern, func(t *testing.T) {
			policy := strings.Replace(rewriteActiveTestPolicy, "internal-model", pattern, 1)
			_, policies := rewriteTestServer(t, policy, nil)
			capturePath := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
			var stdout, stderr bytes.Buffer
			err := execRealGHWithStdin(t.Context(), append(mergeDiagnosticArgs(), "--subject=subject", "--body-file=-"), &onceMergeReader{}, &stdout, &stderr)
			if err != nil || policies.Load() != 1 || stdout.String() != "child stdout\n" {
				t.Fatal("optional include denial blocked or altered valid merge")
			}
			assertMergeSnapshot(t, readRewriteCapture(t, capturePath), false, "subject", "body-private-sentinel")
			if !strings.Contains(mergeDiagnosticLine(t, stderr.String()), "headers=unavailable") {
				t.Fatal("denied include claimed headers")
			}
		})
	}
}

func TestGHMergeDiagnosticsLocalRules(t *testing.T) {
	_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	captureRewriteGH(t)
	file := filepath.Join(t.TempDir(), "synthetic-rules.json")
	if err := os.WriteFile(file, []byte(`{"schema_version":1,"rules":[{"pattern":"private-sentinel","replacement":"safe"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", file)
	t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
	var stderr bytes.Buffer
	if err := execRealGHWithStdin(t.Context(), mergeDiagnosticArgs(), strings.NewReader(""), io.Discard, &stderr); err != nil {
		t.Fatal(err)
	}
	line := mergeDiagnosticLine(t, stderr.String())
	if policies.Load() != 1 || !strings.Contains(line, "route=rest_put server_policy_revision=1 effective_rule_count=1") || strings.Contains(line, file) {
		t.Fatal("server revision was conflated with effective rules")
	}
}

func TestGHMergeDiagnosticsFailures(t *testing.T) {
	for _, mode := range []string{"resolve", "start", "cancel", "native_stderr_writer", "native_stdout_writer"} {
		t.Run(mode, func(t *testing.T) {
			policy := rewriteActiveTestPolicy
			if mode == "native_stdout_writer" {
				policy = rewriteEmptyTestPolicy
			}
			_, policies := rewriteTestServer(t, policy, nil)
			capturePath := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
			if mode == "resolve" {
				t.Setenv("OCTOPOOL_GH_PATH", filepath.Join(t.TempDir(), "missing-private-sentinel"))
			}
			if mode == "start" {
				file := filepath.Join(t.TempDir(), "invalid-child")
				if err := os.WriteFile(file, []byte("not an executable format"), 0700); err != nil {
					t.Fatal(err)
				}
				t.Setenv("OCTOPOOL_GH_PATH", file)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var canceled <-chan struct{}
			if mode == "cancel" {
				t.Setenv("OCTOPOOL_TEST_REWRITE_WAIT", "1")
				done := make(chan struct{})
				canceled = done
				go func() {
					defer close(done)
					ticker := time.NewTicker(5 * time.Millisecond)
					defer ticker.Stop()
					for {
						select {
						case <-ctx.Done():
							return
						case <-ticker.C:
							if data, err := os.ReadFile(capturePath); err == nil && json.Valid(data) {
								cancel()
								return
							}
						}
					}
				}()
			}
			stderr := &mergeDiagnosticWriter{rejectNative: mode == "native_stderr_writer"}
			var stdout io.Writer = io.Discard
			if mode == "native_stdout_writer" {
				stdout = mergeFailWriter{}
			}
			snapshotRoot := t.TempDir()
			t.Setenv("TMPDIR", snapshotRoot)
			args := mergeDiagnosticArgs()
			if mode != "native_stdout_writer" {
				args = append(args, "--subject=subject", "--body-file=-")
			}
			err := execRealGHWithStdin(ctx, args, strings.NewReader("body"), stdout, stderr)
			if canceled != nil {
				<-canceled
			}
			if entries, err := os.ReadDir(snapshotRoot); err != nil || len(entries) != 0 {
				t.Fatal("failed dispatch left a snapshot directory")
			}
			if err == nil || policies.Load() != 1 {
				t.Fatal("failure lost or repeated policy request")
			}
			line := mergeDiagnosticLine(t, stderr.String())
			if mode == "resolve" || mode == "start" {
				if !strings.Contains(line, "child_started=false outcome=start_failed") || strings.Contains(line, "exit_code=") {
					t.Fatal("launch failure attributed to executed child")
				}
				if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
					t.Fatal("start failure executed child")
				}
			} else {
				want := "outcome=wait_failed"
				if mode == "cancel" {
					want = "outcome=canceled"
				} else if !errors.Is(err, errMergeWriter) {
					t.Fatal("native writer error changed")
				}
				if !strings.Contains(line, "child_started=true") || !strings.Contains(line, want) {
					t.Fatalf("completion outcome incorrect: %s", line)
				}
				if mode != "native_stdout_writer" {
					assertMergeSnapshot(t, readRewriteCapture(t, capturePath), true, "subject", "body")
				}
			}
			if strings.Contains(line, "private-sentinel") {
				t.Fatal("raw failure leaked into diagnostic")
			}
		})
	}
}

type mergeFailWriter struct{}

func (mergeFailWriter) Write([]byte) (int, error) { return 0, errMergeWriter }

func TestGHMergeDiagnosticsUnrelated(t *testing.T) {
	for _, args := range [][]string{
		{"api", "user", "--include"},
		{"api", "repos/acme/repo/pulls/7/merge", "--method=PUT", "--raw-field=sha=" + strings.Repeat("a", 40), "--raw-field=merge_method=squash", "--silent", "--include"},
		{"api", "repos/acme/repo/issues", "--paginate"},
		{"pr", "merge", "--help"},
		{"pr", "view", "7", "--repo=acme/repo", "--json=number"},
	} {
		t.Run(strings.Join(args[:2], "_"), func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capturePath := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
			frame := mergeHeaderFrame(200, 4958)
			t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", frame)
			var stdout, stderr bytes.Buffer
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader(""), &stdout, &stderr); err != nil {
				t.Fatal(err)
			}
			if stdout.String() != frame || stderr.String() != "child stderr\n" {
				t.Fatal("unrelated/native-owned output intercepted")
			}
			capture := readRewriteCapture(t, capturePath)
			if slices.Contains(args, "--include") != slices.Contains(capture.Args, ghMergeIncludeFlag) {
				t.Fatal("include ownership changed")
			}
		})
	}
}

func TestGHMergeDiagnosticsCanceledPreparation(t *testing.T) {
	policies := rewriteTestServerPolicySequence(t, func(int64) (string, int) { return rewriteActiveTestPolicy, http.StatusOK }, nil)
	capturePath := captureRewriteGH(t)
	t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var stderr bytes.Buffer
	if err := execRealGHWithStdin(ctx, mergeDiagnosticArgs(), strings.NewReader(""), io.Discard, &stderr); err == nil {
		t.Fatal("canceled preparation succeeded")
	}
	line := mergeDiagnosticLine(t, stderr.String())
	if policies.Load() != 0 || !strings.Contains(line, "child_started=false outcome=preparation_failed") {
		t.Fatal("canceled preparation attributed to child")
	}
	if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
		t.Fatal("canceled preparation launched child")
	}
}

func TestGHMergeDiagnosticsCanceledBeforeStart(t *testing.T) {
	_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capturePath := captureRewriteGH(t)
	t.Setenv("OCTOPOOL_DIAGNOSTICS", "1")
	snapshotRoot := t.TempDir()
	t.Setenv("TMPDIR", snapshotRoot)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var stderr bytes.Buffer
	err := execRealGHWithStdin(ctx, append(mergeDiagnosticArgs(), "--body-file=-"), &onceMergeReader{cancel: cancel}, io.Discard, &stderr)
	if !errors.Is(err, context.Canceled) || policies.Load() != 1 {
		t.Fatal("cancellation after preparation lost")
	}
	if !strings.Contains(mergeDiagnosticLine(t, stderr.String()), "child_started=false outcome=canceled_before_start") {
		t.Fatal("pre-start cancellation attributed to executed child")
	}
	if entries, err := os.ReadDir(snapshotRoot); err != nil || len(entries) != 0 {
		t.Fatal("canceled start left a snapshot")
	}
	if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
		t.Fatal("canceled start launched a child")
	}
}
