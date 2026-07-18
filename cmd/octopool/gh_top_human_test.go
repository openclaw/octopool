package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestHumanPRViewExactOutputAndLatestReviewWins(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/25":
			return map[string]any{
				"number": 25,
				"title":  "feat: authoritative Link-header pagination for relay-backed gh api",
				"state":  "closed",
				"user":   map[string]any{"login": "steipete", "name": "Peter Steinberger"},
				"labels": []map[string]any{{"name": "enhancement"}, {"name": "relay"}},
				"assignees": []map[string]any{
					{"login": "octocat"},
				},
				"milestone": map[string]any{"title": "0.4.8"},
				"requested_reviewers": []map[string]any{
					{"login": "alice"},
				},
				"requested_teams": []map[string]any{
					{"slug": "octopool-maintainers"},
				},
				"merged_at":  "2026-07-17T21:15:50Z",
				"html_url":   "https://github.com/openclaw/octopool/pull/25",
				"additions":  453,
				"deletions":  8,
				"auto_merge": nil,
				"body":       "First paragraph.\n\nSecond paragraph.",
			}
		case "/repos/openclaw/octopool/pulls/25/reviews":
			return []map[string]any{
				{"user": map[string]any{"login": "chatgpt-codex-connector"}, "state": "COMMENTED"},
				{"user": map[string]any{"login": "steipete"}, "state": "COMMENTED"},
				{"user": map[string]any{"login": "bob"}, "state": "PENDING"},
				{"user": map[string]any{"login": "alice"}, "state": "COMMENTED"},
				{"user": map[string]any{"login": "alice"}, "state": "CHANGES_REQUESTED"},
			}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"view", "25", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	want := "title:\tfeat: authoritative Link-header pagination for relay-backed gh api\n" +
		"state:\tMERGED\n" +
		"author:\tsteipete\n" +
		"labels:\tenhancement, relay\n" +
		"assignees:\toctocat\n" +
		"reviewers:\tchatgpt-codex-connector (Commented), alice (Requested), octopool-maintainers (Requested)\n" +
		"projects:\t\n" +
		"milestone:\t0.4.8\n" +
		"number:\t25\n" +
		"url:\thttps://github.com/openclaw/octopool/pull/25\n" +
		"additions:\t453\n" +
		"deletions:\t8\n" +
		"auto-merge:\tdisabled\n" +
		"--\n" +
		"First paragraph.\n\nSecond paragraph.\n"
	if got := out.String(); got != want {
		t.Fatalf("output:\n%q\nwant:\n%q", got, want)
	}
}

func TestHumanPRListExactOutput(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return []map[string]any{{
			"number": 25, "title": "feat: authoritative Link-header pagination for relay-backed gh api",
			"head": map[string]any{"ref": "feat/link-pagination"}, "state": "closed",
			"merged_at": "2026-07-17T21:15:50Z", "updated_at": "2026-07-17T23:35:50+01:00",
			"created_at": "2026-07-17T22:15:50+01:00",
		}}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool", "--state", "all"}, &out)
	assertGHComplete(t, result)
	want := "25\tfeat: authoritative Link-header pagination for relay-backed gh api\tfeat/link-pagination\tMERGED\t2026-07-17T21:15:50Z\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestHumanPRListMarksDrafts(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return []map[string]any{{
			"number": 30, "title": "wip", "draft": true,
			"head": map[string]any{"ref": "wip-branch"}, "state": "open",
			"updated_at": "2026-07-17T22:15:50Z", "created_at": "2026-07-17T22:15:50Z",
		}}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	if want := "30\twip\twip-branch\tDRAFT\t2026-07-17T22:15:50Z\n"; out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}

func TestHumanIssueViewDelegatesForPullRequests(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return map[string]any{
			"number": 25, "title": "actually a PR", "state": "open",
			"pull_request": map[string]any{"url": "https://example.test/pulls/25"},
		}
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
	var out bytes.Buffer
	var stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"issue", "view", "25", "-R", "openclaw/octopool"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "real-gh:") || !strings.Contains(stderr.String(), "issue_number_is_pull_request") {
		t.Fatalf("PR numbers must delegate to real gh: out=%q stderr=%q", out.String(), stderr.String())
	}
}

func TestHumanPRChecksExactOutputAndSanitizesName(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/25":
			return map[string]any{"head": map[string]any{"sha": "abc123"}}
		case "/repos/openclaw/octopool/commits/abc123/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{
				"name": "Check\x1b[31m", "status": "completed", "conclusion": "success",
				"started_at": "2026-07-17T21:00:00Z", "completed_at": "2026-07-17T21:03:12Z",
				"details_url": "https://github.com/openclaw/octopool/actions/runs/29614118703/job/87995297404",
			}}}
		case "/repos/openclaw/octopool/commits/abc123/status":
			return map[string]any{"total_count": 0, "statuses": []map[string]any{}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "25", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	want := "Check[31m\tpass\t3m12s\thttps://github.com/openclaw/octopool/actions/runs/29614118703/job/87995297404\t\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestHumanRunListExactOutput(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return map[string]any{"workflow_runs": []map[string]any{{
			"status": "completed", "conclusion": "success",
			"display_title": "chore: open 0.4.8 development", "name": "CI", "head_branch": "main",
			"event": "push", "id": 29614557506,
			"run_started_at": "2026-07-17T21:23:36Z", "updated_at": "2026-07-17T21:26:55Z",
			"created_at": "2026-07-17T22:23:36+01:00",
		}}}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"list", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	want := "completed\tsuccess\tchore: open 0.4.8 development\tCI\tmain\tpush\t29614557506\t3m19s\t2026-07-17T21:23:36Z\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestHumanRunViewExactOutput(t *testing.T) {
	setHumanTestSeams(t, time.Date(2026, 7, 18, 4, 21, 25, 0, time.UTC))
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/actions/runs/29614434370":
			return map[string]any{
				"id": 29614434370, "display_title": "chore(release): 0.4.7", "name": "release", "head_branch": "v0.4.7",
				"event": "push", "status": "completed", "conclusion": "success",
				"created_at": "2026-07-17T21:21:25Z", "updated_at": "2026-07-17T21:22:52Z",
				"html_url": "https://github.com/openclaw/octopool/actions/runs/29614434370",
			}
		case "/repos/openclaw/octopool/actions/runs/29614434370/jobs":
			return map[string]any{"total_count": 1, "jobs": []map[string]any{{
				"id": 87996300812, "name": "goreleaser", "status": "completed", "conclusion": "success",
				"started_at": "2026-07-17T21:21:27Z", "completed_at": "2026-07-17T21:22:51Z",
				"html_url": "https://github.com/openclaw/octopool/actions/runs/29614434370/job/87996300812",
			}}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"view", "29614434370", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	want := "\n✓ v0.4.7 release · 29614434370\n" +
		"Triggered via push about 7 hours ago\n\n" +
		"JOBS\n" +
		"✓ goreleaser in 1m24s (ID 87996300812)\n\n" +
		"For more information about the job, try: gh run view --job=87996300812\n" +
		"View this run on GitHub: https://github.com/openclaw/octopool/actions/runs/29614434370\n"
	if got := out.String(); got != want {
		t.Fatalf("output:\n%q\nwant:\n%q", got, want)
	}
}

func TestHumanIssueViewExactOutput(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return map[string]any{
			"number": 110411, "title": "cron.update: converting a recurring job", "state": "open",
			"user": map[string]any{"login": "maintainer"}, "labels": []map[string]any{{"name": "maintainer"}, {"name": "P2"}},
			"comments": 1, "assignees": []map[string]any{}, "milestone": nil,
			"body": "Reproduction\n\tstep one\x1b",
		}
	})
	var out bytes.Buffer
	result := handleGHIssue(t.Context(), []string{"view", "110411", "-R", "openclaw/openclaw"}, &out)
	assertGHComplete(t, result)
	want := "title:\tcron.update: converting a recurring job\n" +
		"state:\tOPEN\n" +
		"author:\tmaintainer\n" +
		"labels:\tmaintainer, P2\n" +
		"comments:\t1\n" +
		"assignees:\t\n" +
		"projects:\t\n" +
		"milestone:\t\n" +
		"issue-type:\t\n" +
		"parent:\t\n" +
		"sub-issues:\t\n" +
		"sub-issues-completed:\t\n" +
		"blocked-by:\t\n" +
		"blocking:\t\n" +
		"number:\t110411\n" +
		"--\n" +
		"Reproduction\n\tstep one\n"
	if got := out.String(); got != want {
		t.Fatalf("output:\n%q\nwant:\n%q", got, want)
	}
}

func TestHumanIssueListExactOutput(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return []map[string]any{{
			"number": 110411, "state": "open", "title": "cron.update: converting a recurring job...",
			"labels":     []map[string]any{{"name": "maintainer"}, {"name": "P2"}, {"name": "bug"}},
			"updated_at": "2026-07-18T04:46:30Z",
		}}
	})
	var out bytes.Buffer
	result := handleGHIssue(t.Context(), []string{"list", "-R", "openclaw/openclaw"}, &out)
	assertGHComplete(t, result)
	want := "110411\tOPEN\tcron.update: converting a recurring job...\tmaintainer, P2, bug\t2026-07-18T04:46:30Z\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestHumanReadsDelegateWhenStdoutIsTTY(t *testing.T) {
	old := stdoutIsTTY
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdoutIsTTY = old })
	relayTestServer(t, func(body map[string]any) any {
		t.Fatalf("TTY read contacted relay: %#v", body)
		return nil
	})
	tests := []struct {
		name string
		run  func(*bytes.Buffer) ghResult
	}{
		{"pr view", func(out *bytes.Buffer) ghResult {
			return handleGHPR(t.Context(), []string{"view", "25", "-R", "openclaw/octopool"}, out)
		}},
		{"pr checks", func(out *bytes.Buffer) ghResult {
			return handleGHPR(t.Context(), []string{"checks", "25", "-R", "openclaw/octopool"}, out)
		}},
		{"pr list", func(out *bytes.Buffer) ghResult {
			return handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool"}, out)
		}},
		{"run view", func(out *bytes.Buffer) ghResult {
			return handleGHRun(t.Context(), []string{"view", "29614434370", "-R", "openclaw/octopool"}, out)
		}},
		{"run list", func(out *bytes.Buffer) ghResult {
			return handleGHRun(t.Context(), []string{"list", "-R", "openclaw/octopool"}, out)
		}},
		{"issue view", func(out *bytes.Buffer) ghResult {
			return handleGHIssue(t.Context(), []string{"view", "110411", "-R", "openclaw/openclaw"}, out)
		}},
		{"issue list", func(out *bytes.Buffer) ghResult {
			return handleGHIssue(t.Context(), []string{"list", "-R", "openclaw/openclaw"}, out)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			result := test.run(&out)
			if result.action != ghDelegate || result.err != nil || out.Len() != 0 {
				t.Fatalf("action=%v err=%v out=%q", result.action, result.err, out.String())
			}
		})
	}
}

func TestHumanReadsDelegateUnsupportedFlags(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	tests := []struct {
		name string
		run  func(*bytes.Buffer) ghResult
	}{
		{"pr view", func(out *bytes.Buffer) ghResult {
			return handleGHPR(t.Context(), []string{"view", "25", "-R", "openclaw/octopool", "--template", "{{.}}"}, out)
		}},
		{"pr checks", func(out *bytes.Buffer) ghResult {
			return handleGHPR(t.Context(), []string{"checks", "25", "-R", "openclaw/octopool", "--template", "{{.}}"}, out)
		}},
		{"pr list", func(out *bytes.Buffer) ghResult {
			return handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool", "--template", "{{.}}"}, out)
		}},
		{"run view", func(out *bytes.Buffer) ghResult {
			return handleGHRun(t.Context(), []string{"view", "29614434370", "-R", "openclaw/octopool", "--template", "{{.}}"}, out)
		}},
		{"run list", func(out *bytes.Buffer) ghResult {
			return handleGHRun(t.Context(), []string{"list", "-R", "openclaw/octopool", "--template", "{{.}}"}, out)
		}},
		{"issue view", func(out *bytes.Buffer) ghResult {
			return handleGHIssue(t.Context(), []string{"view", "110411", "-R", "openclaw/openclaw", "--template", "{{.}}"}, out)
		}},
		{"issue list", func(out *bytes.Buffer) ghResult {
			return handleGHIssue(t.Context(), []string{"list", "-R", "openclaw/openclaw", "--template", "{{.}}"}, out)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			result := test.run(&out)
			if result.action != ghDelegate || result.err != nil || out.Len() != 0 {
				t.Fatalf("action=%v err=%v out=%q", result.action, result.err, out.String())
			}
		})
	}
}

func TestHumanPRChecksPendingExitsEight(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/25":
			return map[string]any{"head": map[string]any{"sha": "abc123"}}
		case "/repos/openclaw/octopool/commits/abc123/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{
				"name": "Check", "status": "in_progress", "started_at": "2026-07-17T21:00:00Z",
			}}}
		case "/repos/openclaw/octopool/commits/abc123/status":
			return map[string]any{"total_count": 0, "statuses": []map[string]any{}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "25", "-R", "openclaw/octopool"}, &out)
	var exitErr exitCodeError
	if result.action != ghFail || !errors.As(result.err, &exitErr) || exitErr.Code != 8 {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got, want := out.String(), "Check\tpending\t\t\t\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestHumanRunViewActiveJobOmitsDuration(t *testing.T) {
	setHumanTestSeams(t, time.Date(2026, 7, 17, 22, 0, 0, 0, time.UTC))
	relayTestServer(t, func(body map[string]any) any {
		if strings.HasSuffix(body["path"].(string), "/jobs") {
			return map[string]any{"total_count": 1, "jobs": []map[string]any{{
				"id": 9, "name": "build", "status": "in_progress",
				"started_at": "2026-07-17T21:59:00Z",
			}}}
		}
		return map[string]any{
			"id": 42, "status": "in_progress", "head_branch": "main", "name": "CI",
			"event": "push", "created_at": "2026-07-17T21:58:00Z",
			"html_url": "https://github.com/openclaw/octopool/actions/runs/42",
		}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"view", "42", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	if !strings.Contains(out.String(), "* build (ID 9)\n") || strings.Contains(out.String(), "in  (") {
		t.Fatalf("active job must omit the duration phrase, got %q", out.String())
	}
	if got := statusGlyph("completed", "startup_failure"); got != "X" {
		t.Fatalf("startup_failure glyph = %q, want X", got)
	}
}

func TestHumanListWebFlagDelegates(t *testing.T) {
	// --web hits the option parser's fallback before any handler runs; the
	// native renderer must never see it even with non-TTY stdout.
	setHumanTestSeams(t, time.Time{})
	var out bytes.Buffer
	for _, args := range [][]string{
		{"list", "-R", "openclaw/octopool", "--web"},
		{"view", "25", "-R", "openclaw/octopool", "--web"},
	} {
		if result := handleGHPR(t.Context(), args, &out); result.action != ghDelegate {
			t.Fatalf("pr %v must delegate, got %v", args, result.action)
		}
		if result := handleGHIssue(t.Context(), args, &out); result.action != ghDelegate {
			t.Fatalf("issue %v must delegate, got %v", args, result.action)
		}
	}
	if out.Len() != 0 {
		t.Fatalf("delegation must not print, got %q", out.String())
	}
}

func TestHumanRunViewRendersFailedSteps(t *testing.T) {
	setHumanTestSeams(t, time.Date(2026, 7, 18, 4, 21, 25, 0, time.UTC))
	relayTestServer(t, func(body map[string]any) any {
		if strings.HasSuffix(body["path"].(string), "/jobs") {
			return map[string]any{"total_count": 1, "jobs": []map[string]any{{
				"id": 9, "name": "test", "status": "completed", "conclusion": "failure",
				"started_at": "2026-07-17T21:00:00Z", "completed_at": "2026-07-17T21:02:00Z",
				"steps": []map[string]any{
					{"name": "Build", "status": "completed", "conclusion": "success"},
					{"name": "Unit tests", "status": "completed", "conclusion": "failure"},
				},
			}}}
		}
		return map[string]any{
			"id": 42, "status": "completed", "conclusion": "failure", "head_branch": "main",
			"name": "CI", "event": "push", "created_at": "2026-07-17T20:59:00Z",
			"html_url": "https://github.com/openclaw/octopool/actions/runs/42",
		}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"view", "42", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	if !strings.Contains(out.String(), "  X Unit tests\n") || strings.Contains(out.String(), "Build") {
		t.Fatalf("failed steps only must render, got %q", out.String())
	}
}

func TestHumanRunViewZeroJobFailureDiagnostic(t *testing.T) {
	setHumanTestSeams(t, time.Date(2026, 7, 18, 4, 21, 25, 0, time.UTC))
	relayTestServer(t, func(body map[string]any) any {
		if strings.HasSuffix(body["path"].(string), "/jobs") {
			return map[string]any{"total_count": 0, "jobs": []any{}}
		}
		return map[string]any{
			"id": 42, "status": "completed", "conclusion": "startup_failure", "head_branch": "main",
			"name": "CI", "event": "push", "created_at": "2026-07-18T04:00:00Z",
			"html_url": "https://github.com/openclaw/octopool/actions/runs/42",
		}
	})
	var out bytes.Buffer
	result := handleGHRun(t.Context(), []string{"view", "42", "-R", "openclaw/octopool"}, &out)
	assertGHComplete(t, result)
	if !strings.Contains(out.String(), "workflow file issue") || strings.Contains(out.String(), "JOBS") {
		t.Fatalf("zero-job failure must show the workflow-file diagnostic, got %q", out.String())
	}
}

func TestHumanBodyNewlineParity(t *testing.T) {
	var empty bytes.Buffer
	if err := writeHumanBody(&empty, ""); err != nil {
		t.Fatal(err)
	}
	if empty.String() != "--\n\n" {
		t.Fatalf("empty body = %q, want gh's unconditional trailing newline", empty.String())
	}
	var trailing bytes.Buffer
	if err := writeHumanBody(&trailing, "text\n"); err != nil {
		t.Fatal(err)
	}
	if trailing.String() != "--\ntext\n\n" {
		t.Fatalf("trailing-newline body = %q", trailing.String())
	}
}

func TestHumanDurationFormatting(t *testing.T) {
	tests := []struct {
		start string
		end   string
		want  string
	}{
		{"2026-07-18T00:00:00Z", "2026-07-18T00:00:12Z", "12s"},
		{"2026-07-18T00:00:00Z", "2026-07-18T00:03:12Z", "3m12s"},
		{"2026-07-18T00:00:00Z", "2026-07-18T01:02:03Z", "1h2m3s"},
		{"2026-07-18T00:00:00Z", "", ""},
	}
	for _, test := range tests {
		if got := humanDuration(test.start, test.end); got != test.want {
			t.Errorf("humanDuration(%q, %q) = %q, want %q", test.start, test.end, got, test.want)
		}
	}
}

func TestHumanReadLeavesJSONBehaviorUnchanged(t *testing.T) {
	setHumanTestSeams(t, time.Time{})
	relayTestServer(t, func(body map[string]any) any {
		return []map[string]any{{"number": 25, "title": "JSON remains JSON"}}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"list", "-R", "openclaw/octopool", "--json", "number,title"}, &out)
	assertGHComplete(t, result)
	if got, want := out.String(), "[{\"number\":25,\"title\":\"JSON remains JSON\"}]\n"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func setHumanTestSeams(t *testing.T, now time.Time) {
	t.Helper()
	oldTTY, oldNow := stdoutIsTTY, humanNow
	stdoutIsTTY = func() bool { return false }
	if !now.IsZero() {
		humanNow = func() time.Time { return now }
	}
	t.Cleanup(func() {
		stdoutIsTTY = oldTTY
		humanNow = oldNow
	})
}

func assertGHComplete(t *testing.T, result ghResult) {
	t.Helper()
	if result.action != ghComplete || result.err != nil {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}
