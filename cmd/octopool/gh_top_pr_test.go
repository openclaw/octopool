package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestRunGHPRViewHydratesFiles(t *testing.T) {
	prCalls, fileCalls := 0, 0
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			prCalls++
			if prCalls == 1 && fileCalls != 0 || prCalls == 2 && fileCalls != 1 {
				t.Fatalf("head read order: PR calls=%d file calls=%d", prCalls, fileCalls)
			}
			headers := body["headers"].(map[string]any)
			if headers["x-octopool-public-shape"] != "pr-summary-v1" || headers["cache-control"] != "max-age=0" {
				t.Fatalf("PR headers = %#v", headers)
			}
			return map[string]any{
				"number":   7,
				"title":    "hydrate pr",
				"html_url": "https://github.com/openclaw/octopool/pull/7",
				"head":     map[string]any{"sha": "0123456789abcdef0123456789abcdef01234567"},
			}
		case "/repos/openclaw/octopool/pulls/7/files":
			fileCalls++
			if prCalls != 1 {
				t.Fatalf("files read before initial head or after final head: PR calls=%d", prCalls)
			}
			headers := body["headers"].(map[string]any)
			if headers["x-octopool-public-shape"] != "pr-files-v1" {
				t.Fatalf("files headers = %#v", headers)
			}
			hint := body["route_hint"].(map[string]any)
			if hint["pr_head_sha"] != "0123456789abcdef0123456789abcdef01234567" {
				t.Fatalf("route hint = %#v", hint)
			}
			return []map[string]any{{"filename": "cmd/octopool/gh.go", "status": "modified", "additions": 2, "deletions": 1}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"view",
		"7",
		"-R", "openclaw/octopool",
		"--json", "number,files",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if prCalls != 2 || fileCalls != 1 {
		t.Fatalf("PR calls=%d file calls=%d, want initial head, files, final head", prCalls, fileCalls)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"number": float64(7),
		"files": []any{map[string]any{
			"path": "cmd/octopool/gh.go", "additions": float64(2), "deletions": float64(1), "changeType": "MODIFIED",
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("file projection = %#v, want %#v", got, want)
	}
}

func TestPRChecksNativeStatesAndPrecedence(t *testing.T) {
	t.Run("native-expected-bucket", func(t *testing.T) {
		// EXPECTED is a native GraphQL state, not a REST status fixture.
		if got := ghCheckBucket("EXPECTED"); got != "pending" {
			t.Fatalf("native EXPECTED bucket=%q, want pending", got)
		}
	})
	for _, row := range []struct{ status, conclusion, bucket string }{
		{"completed", "success", "pass"}, {"completed", "neutral", "skipping"},
		{"completed", "skipped", "skipping"}, {"completed", "cancelled", "cancel"},
		{"completed", "failure", "fail"}, {"completed", "error", "fail"},
		{"completed", "timed_out", "fail"}, {"completed", "action_required", "fail"},
		{"queued", "", "pending"}, {"in_progress", "", "pending"}, {"pending", "", "pending"},
		{"requested", "", "pending"}, {"waiting", "", "pending"},
		{"completed", "stale", "pending"}, {"completed", "startup_failure", "pending"},
	} {
		t.Run(row.status+"/"+row.conclusion, func(t *testing.T) {
			f := newPRChecksFixture()
			f.checks = []any{prChecksCheck(1, "unit", row.status, row.conclusion)}
			if row.conclusion == "error" {
				f.checks = []any{}
				f.statuses = []any{map[string]any{"id": 1, "context": "unit", "state": "error", "target_url": "https://example.test/status", "created_at": "2026-09-01T00:00:00Z", "description": "legacy"}}
			}
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			var out bytes.Buffer
			err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{json: []string{"state", "bucket"}})
			var got []map[string]any
			if e := json.Unmarshal(out.Bytes(), &got); e != nil {
				t.Fatal(e)
			}
			state := row.conclusion
			if row.status != "completed" {
				state = row.status
			}
			want := []map[string]any{{"state": strings.ToUpper(state), "bucket": row.bucket}}
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("native state/export: err=%v got=%v want=%v", err, got, want)
			}
		})
	}
	for _, row := range []struct {
		name        string
		conclusions []string
		exit        int
	}{
		{"failure-before-pending", []string{"failure", "stale"}, 1},
		{"failure-after-pending", []string{"stale", "failure"}, 1},
		{"cancel-and-pending", []string{"cancelled", "stale"}, 8},
		{"cancel-and-skipping", []string{"cancelled", "neutral", "skipped"}, 0},
	} {
		t.Run(row.name, func(t *testing.T) {
			f := newPRChecksFixture()
			f.checks = []any{}
			for i, conclusion := range row.conclusions {
				f.checks = append(f.checks, prChecksCheck(int64(i+1), conclusion, "completed", conclusion))
			}
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			var out bytes.Buffer
			err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{})
			if row.exit == 0 {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				assertExitCode(t, err, row.exit)
			}
		})
	}
}

func TestPRChecksNativeTypedFields(t *testing.T) {
	f := newPRChecksFixture()
	check := prChecksCheck(1, "unit", "completed", "success")
	check["app"] = map[string]any{"id": 999, "slug": "third-party"}
	check["started_at"], check["completed_at"] = nil, nil
	check["output"] = map[string]any{"title": "job", "summary": "must not become a description"}
	f.checks = []any{check}
	f.statuses = []any{map[string]any{"id": 2, "context": "external", "state": "success", "description": "external result", "target_url": "https://example.test/status", "created_at": "2026-08-31T01:00:00Z", "updated_at": "2026-09-01T02:00:00Z"}}
	for _, mode := range []string{"all-fields", "subset", "jq", "raw-control"} {
		t.Run(mode, func(t *testing.T) {
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			var out bytes.Buffer
			fields := "name,state,bucket,startedAt,completedAt,description,link,event,workflow"
			args := []string{"pr", "checks", "7", "-R", "acme/repo", "--json", fields}
			if mode == "subset" {
				args[6] = "name,description,startedAt"
			}
			if mode == "jq" {
				args = append(args, "--jq", `map(.description) | join("|")`)
			}
			if mode == "raw-control" {
				args = []string{"api", "repos/acme/repo/commits/" + metadataHead + "/check-runs?per_page=100&page=1"}
			}
			err := runGH(t.Context(), args, &out, io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "raw-control" {
				if !strings.Contains(out.String(), "must not become a description") || !strings.Contains(out.String(), `"started_at":null`) {
					t.Fatalf("raw API changed: %s", out.String())
				}
				return
			}
			if mode == "jq" {
				if out.String() != "|external result\n" {
					t.Fatalf("descriptions=%q", out.String())
				}
				return
			}
			var got []map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := []map[string]any{
				{"name": "unit", "state": "SUCCESS", "bucket": "pass", "startedAt": "0001-01-01T00:00:00Z", "completedAt": "0001-01-01T00:00:00Z", "description": "", "link": check["details_url"], "event": "", "workflow": ""},
				{"name": "external", "state": "SUCCESS", "bucket": "pass", "startedAt": "0001-01-01T00:00:00Z", "completedAt": "0001-01-01T00:00:00Z", "description": "external result", "link": "https://example.test/status", "event": "", "workflow": ""},
			}
			if mode == "subset" {
				for _, item := range want {
					for key := range item {
						if key != "name" && key != "description" && key != "startedAt" {
							delete(item, key)
						}
					}
				}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("typed check/status fields: got=%s want=%v", out.String(), want)
			}
		})
	}
	for _, row := range []struct {
		name               string
		start, end         any
		wantStart, wantEnd string
	}{
		{"offset-fraction", "2026-09-01T01:00:00.1200+02:30", "2026-09-01T01:00:01.6200+02:30", "2026-09-01T01:00:00.12+02:30", "2026-09-01T01:00:01.62+02:30"},
		{"null-strings", nil, nil, "0001-01-01T00:00:00Z", "0001-01-01T00:00:00Z"},
	} {
		t.Run(row.name, func(t *testing.T) {
			f := newPRChecksFixture()
			c := f.checks[0].(map[string]any)
			c["app"] = map[string]any{"id": 999, "slug": "third-party"}
			c["started_at"], c["completed_at"] = row.start, row.end
			c["details_url"] = nil
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			var out bytes.Buffer
			if err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{json: []string{"startedAt", "completedAt", "description", "link", "event", "workflow"}}); err != nil {
				t.Fatal(err)
			}
			var got []map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := []map[string]any{{"startedAt": row.wantStart, "completedAt": row.wantEnd, "description": "", "link": "", "event": "", "workflow": ""}}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("typed times/null strings got=%s want=%v", out.String(), want)
			}
		})
	}
}

type prChecksBrokenWriter struct{ err error }

func (w prChecksBrokenWriter) Write([]byte) (int, error) { return 0, w.err }

func TestPRChecksOutputWriteFailure(t *testing.T) {
	f := newPRChecksFixture()
	relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
	want := errors.New("synthetic output closed")
	for _, fields := range [][]string{nil, {"name"}} {
		if err := relayPRChecks(t.Context(), prChecksBrokenWriter{want}, "acme/repo", "7", ghTopOptions{json: fields}); !errors.Is(err, want) {
			t.Fatalf("write failure=%v", err)
		}
	}
}

func TestRunGHPRViewFilesFallsBackWhenHeadMoves(t *testing.T) {
	prCalls := 0
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			prCalls++
			sha := "0123456789abcdef0123456789abcdef01234567"
			if prCalls == 2 {
				sha = "fedcba9876543210fedcba9876543210fedcba98"
			}
			return map[string]any{"number": 7, "head": map[string]any{"sha": sha}}
		case "/repos/openclaw/octopool/pulls/7/files":
			return []map[string]any{{"filename": "moving.ts", "status": "modified", "additions": 2, "deletions": 1}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})

	result := handleGHPR(t.Context(), []string{
		"view", "7", "-R", "openclaw/octopool", "--json", "number,files",
	}, &bytes.Buffer{})
	if result.action != ghFail || !isLocalFallback(result.err) {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHPRChecksUsesCacheableRequests(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["path"] != "/repos/openclaw/octopool/pulls/7" {
			if _, ok := body["headers"]; ok {
				t.Fatalf("unexpected cache-bypass headers: %#v", body["headers"])
			}
		}
		if body["path"] == "/repos/openclaw/octopool/pulls/7" {
			headers, _ := body["headers"].(map[string]any)
			if headers["cache-control"] != "max-age=60" {
				t.Fatalf("expected bounded-freshness PR lookup header, got %#v", body["headers"])
			}
			if _, ok := headers["if-none-match"]; ok {
				t.Fatalf("unexpected cache-bypass header: %#v", headers)
			}
			if headers["x-octopool-public-shape"] != "pr-summary-v1" {
				t.Fatalf("expected public PR summary shape, got %#v", headers)
			}
		}
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": 1, "check_runs": []map[string]any{{"id": 1, "head_sha": "abc1234", "app": map[string]any{"id": 999, "slug": "third-party"}, "check_suite": map[string]any{"id": 201}, "name": "CI", "status": "completed", "conclusion": "success"}}}
		case "/repos/openclaw/octopool/commits/abc1234/status":
			return map[string]any{"total_count": 0, "statuses": []map[string]any{}}
		default:
			t.Fatalf("path = %v", body["path"])
			return nil
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"checks",
		"7",
		"-R", "openclaw/octopool",
		"--json", "name,state",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if got := out.String(); !strings.Contains(got, `"name":"CI"`) {
		t.Fatalf("out = %s", got)
	}
}

func TestStatusItemsMapLegacyContexts(t *testing.T) {
	var rawItems []any
	if err := json.Unmarshal([]byte(`[{"id":1,"context":"ci/external","state":"success","target_url":"https://example.test","created_at":"2026-05-27T00:00:00Z","updated_at":"2026-05-27T00:01:00Z"}]`), &rawItems); err != nil {
		t.Fatal(err)
	}
	items := statusItems(rawItems)
	if len(items) != 1 {
		t.Fatalf("items = %#v", items)
	}
	item, err := normalizePRCheck(items[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.Name != "ci/external" || item.State != "SUCCESS" || item.Link != "https://example.test" {
		t.Fatalf("item = %#v", item)
	}
}

func TestPRChecksEligibilityControls(t *testing.T) {
	for _, row := range []struct {
		name string
		args []string
	}{
		{"required", []string{"checks", "7", "-R", "acme/repo", "--required", "--json", "name"}},
		{"unsupported-field", []string{"checks", "7", "-R", "acme/repo", "--json", "name,databaseId"}},
		{"template", []string{"checks", "7", "-R", "acme/repo", "--template", "{{.}}"}},
		{"watch-json", []string{"checks", "7", "-R", "acme/repo", "--watch", "--json", "name"}},
		{"missing-jq", []string{"checks", "7", "-R", "acme/repo", "--json", "name", "--jq", "."}},
	} {
		t.Run(row.name, func(t *testing.T) {
			relayTestServer(t, func(map[string]any) any { t.Error("delegated shape contacted data relay"); return nil })
			if row.name == "missing-jq" {
				t.Setenv("PATH", t.TempDir())
			}
			var out bytes.Buffer
			result := handleGHPR(t.Context(), row.args, &out)
			if result.action != ghDelegate || result.err != nil || out.Len() != 0 {
				t.Fatalf("eligibility widened: result=%+v output=%q", result, out.String())
			}
		})
	}
	for _, selector := range []string{"7", "https://github.com/acme/repo/pull/7", "acme/repo#7"} {
		t.Run(selector, func(t *testing.T) {
			f := newPRChecksFixture()
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{"checks", selector, "-R", "acme/repo", "--json", "name"}, &out)
			if result.action != ghComplete || result.err != nil || out.String() != "[{\"name\":\"unit\"}]\n" {
				t.Fatalf("selector changed: %+v output=%q", result, out.String())
			}
		})
	}
}
