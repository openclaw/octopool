package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestRelayCompleteCollection(t *testing.T) {
	for _, collection := range []struct{ path, key string }{
		{"commits/" + metadataHead + "/check-runs", "check_runs"},
		{"commits/" + metadataHead + "/status", "statuses"},
		{"actions/runs", "workflow_runs"},
		{"actions/workflows", "workflows"},
	} {
		for _, scenario := range []string{
			"empty", "full", "boundary", "large-identities", "growing", "shrinking",
			"duplicate-page", "duplicate-item", "short", "oversized", "exhausted",
			"missing-total", "fractional-total", "negative-total", "missing-array",
			"missing-id", "string-id", "fractional-id", "non-object",
		} {
			t.Run(collection.key+"/"+scenario, func(t *testing.T) {
				calls := 0
				relayTestServer(t, func(request map[string]any) any {
					calls++
					query := request["query"].(map[string]any)
					if query["page"] != strconv.Itoa(calls) || query["per_page"] != "100" {
						t.Fatalf("unexpected query: %v", query)
					}
					total := 101
					if scenario == "empty" {
						total = 0
					}
					if scenario == "boundary" {
						total = 1000
					}
					if scenario == "exhausted" {
						total = 1001
					}
					count := min(100, total-(calls-1)*100)
					items := make([]any, count)
					for i := range items {
						id := int64((calls-1)*100 + i + 1)
						if scenario == "large-identities" {
							id += 1 << 53
						}
						if scenario == "duplicate-page" && calls == 2 {
							id = 1
						}
						if scenario == "duplicate-item" {
							id = 1
						}
						items[i] = map[string]any{"id": id}
					}
					if scenario == "growing" && calls == 2 {
						total = 201
					}
					if scenario == "shrinking" && calls == 2 {
						total = 100
					}
					if scenario == "short" {
						items = items[:99]
					}
					if scenario == "oversized" {
						items = append(items, map[string]any{"id": 102})
					}
					response := map[string]any{"total_count": total, collection.key: items}
					switch scenario {
					case "missing-total":
						delete(response, "total_count")
					case "fractional-total":
						response["total_count"] = 100.5
					case "negative-total":
						response["total_count"] = -1
					case "missing-array":
						delete(response, collection.key)
					case "missing-id":
						items[0] = map[string]any{}
					case "string-id":
						items[0] = map[string]any{"id": "1"}
					case "fractional-id":
						items[0] = map[string]any{"id": 1.5}
					case "non-object":
						items[0] = nil
					}
					return response
				})
				client, err := newGHRelayClient()
				if err != nil {
					t.Fatal(err)
				}
				items, err := relayCompleteCollection(t.Context(), client, ghAPIRequest{
					method: "GET", path: "/repos/acme/repo/" + collection.path,
				}, collection.key)
				wantSize := map[string]int{"empty": 0, "full": 101, "boundary": 1000, "large-identities": 101}
				if size, valid := wantSize[scenario]; valid {
					if err != nil || len(items) != size {
						t.Fatalf("items=%d err=%v", len(items), err)
					}
					if want := max(1, (size+99)/100); calls != want {
						t.Fatalf("calls=%d want=%d", calls, want)
					}
				} else if !isLocalFallback(err) || items != nil {
					t.Fatalf("incomplete collection escaped: items=%d err=%v", len(items), err)
				}
				if calls > maxRelayPages {
					t.Fatalf("unbounded pagination: %d", calls)
				}
			})
		}
	}
}

// New checks can arrive at the same SHA between pages. The second page then
// repeats successes while the old failure moves to page 3. Neither consumer may
// publish those repeated successes as a complete snapshot.
func TestPRChecksGrowingCollectionsUseGuardedFallback(t *testing.T) {
	for _, key := range []string{"check_runs", "statuses"} {
		for _, command := range []string{"view", "checks"} {
			for _, noFallback := range []string{"", "1"} {
				t.Run(key+"/"+command+"/no-fallback="+noFallback, func(t *testing.T) {
					t.Setenv("OCTOPOOL_NO_FALLBACK", noFallback)
					pages := []int{}
					rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
						request := decodeCLIRequest(t, w, r)
						path := request["path"].(string)
						if strings.HasSuffix(path, "/pulls/1") {
							writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": metadataHead, "ref": "feature"}})
							return
						}
						collection := "check_runs"
						if strings.HasSuffix(path, "/status") {
							collection = "statuses"
						}
						if collection != key {
							writeCLIEnvelope(t, w, map[string]any{"total_count": 0, collection: []any{}})
							return
						}
						page, _ := strconv.Atoi(request["query"].(map[string]any)["page"].(string))
						pages = append(pages, page)
						total, count := 101, 100
						if page > 1 {
							total = 201
						}
						if page == 3 {
							count = 1
						}
						items := make([]any, count)
						for i := range items {
							id, conclusion := 101-i, "success"
							if page == 3 {
								id, conclusion = 1, "failure"
							}
							items[i] = map[string]any{"id": id, "name": fmt.Sprint(id), "status": "completed", "conclusion": conclusion}
							if collection == "statuses" {
								items[i] = map[string]any{"id": id, "context": fmt.Sprint(id), "state": conclusion}
							}
						}
						writeCLIEnvelope(t, w, map[string]any{"total_count": total, collection: items})
					})
					capture := captureRewriteGH(t)
					args := []string{"pr", command, "1", "-R", "acme/repo", "--json", "name,state"}
					if command == "view" {
						args[6] = "statusCheckRollup"
					}
					var out bytes.Buffer
					err := runGH(t.Context(), args, &out, io.Discard)
					if !reflect.DeepEqual(pages, []int{1, 2}) {
						t.Fatalf("pages=%v", pages)
					}
					if noFallback == "1" {
						if err == nil || out.Len() != 0 {
							t.Fatalf("partial result: err=%v out=%q", err, out.String())
						}
						if _, err := os.Stat(capture); !os.IsNotExist(err) {
							t.Fatal("native fallback ran")
						}
					} else {
						if err != nil || out.String() != "child stdout\n" {
							t.Fatalf("partial result before fallback: err=%v out=%q", err, out.String())
						}
						got := readRewriteCapture(t, capture)
						if got.Env["GH_HOST"] != "github.com" || !strings.Contains(strings.Join(got.Args, " "), "--repo=acme/repo") {
							t.Fatalf("unpinned fallback: %+v", got)
						}
					}
				})
			}
		}
	}
}

func TestSplitFieldsPreservesFirstOccurrence(t *testing.T) {
	parsed, unsupported, err := parseReadOptions([]string{"--json", "assignees,assignees,files,statusCheckRollup,files"}, topReadSpecs("pr view"))
	if err != nil || unsupported {
		t.Fatalf("parse: unsupported=%v err=%v", unsupported, err)
	}
	got := uniqueReadFields(parsed.values["--json"].strings)
	if !reflect.DeepEqual(got, []string{"assignees", "files", "statusCheckRollup"}) {
		t.Fatalf("fields=%v", got)
	}
}

func TestGHPRChecksWatchRejectsRepeatedCollectionIDs(t *testing.T) {
	calls := 0
	relayTestServer(t, func(request map[string]any) any {
		path := request["path"].(string)
		if strings.HasSuffix(path, "/pulls/1") {
			return map[string]any{"head": map[string]any{"sha": metadataHead, "ref": "feature"}}
		}
		if !strings.HasSuffix(path, "/check-runs") {
			t.Fatalf("unexpected path %s", path)
		}
		calls++
		count := 100
		if calls == 2 {
			count = 1
		}
		items := make([]any, count)
		for i := range items {
			items[i] = map[string]any{"id": i + 1, "name": fmt.Sprint(i), "status": "completed", "conclusion": "success"}
		}
		return map[string]any{"total_count": 101, "check_runs": items}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{"checks", "1", "-R", "acme/repo", "--watch"}, &out)
	if result.action != ghFail || !isLocalFallback(result.err) || out.Len() != 0 || calls != 2 {
		t.Fatalf("watch accepted incomplete snapshot: result=%+v output=%q calls=%d", result, out.String(), calls)
	}
}

func TestPRChecksMetadataCollectionBudgets(t *testing.T) {
	for _, scenario := range []string{"match-page-2", "match-page-10", "41-operations", "21-without-actions", "1001-workflows", "1001-runs", "late-duplicate", "late-short", "late-total-change"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPRChecksFixture()
			count := 101
			if scenario == "match-page-10" || scenario == "41-operations" || scenario == "21-without-actions" {
				count = 1000
			}
			if scenario == "1001-workflows" || scenario == "1001-runs" {
				count = 1001
			}
			f.runs, f.workflows = []any{}, []any{}
			for i := 0; i < count; i++ {
				suite := 10000 + i
				if i == count-1 {
					suite = 201
				}
				f.runs = append(f.runs, map[string]any{"id": 3000 + i, "head_sha": metadataHead, "check_suite_id": suite, "workflow_id": 4000 + count - 1, "event": "pull_request", "name": "not CI"})
				f.workflows = append(f.workflows, map[string]any{"id": 4000 + i, "name": "CI", "state": "disabled_manually", "path": fmt.Sprintf(".github/workflows/%d.yml", i)})
			}
			if scenario == "1001-workflows" {
				f.runs = f.runs[count-1:]
			}
			if scenario == "41-operations" || scenario == "21-without-actions" {
				f.checks, f.statuses = []any{}, []any{}
				for i := 0; i < 1000; i++ {
					c := prChecksCheck(int64(i+1), fmt.Sprintf("job-%04d", i), "completed", "success")
					if scenario == "21-without-actions" {
						c["app"] = map[string]any{"id": 999, "slug": "third-party"}
					}
					f.checks = append(f.checks, c)
					f.statuses = append(f.statuses, map[string]any{"id": i + 1, "context": fmt.Sprintf("status-%04d", i), "state": "success", "target_url": "https://example.test/status", "description": "external", "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z"})
				}
			}
			if strings.HasPrefix(scenario, "late-") {
				// The needed match is already on page 1. Completeness still requires page 2.
				f.runs[0].(map[string]any)["check_suite_id"] = 201
				f.runs[count-1].(map[string]any)["check_suite_id"] = 99999
				for _, r := range f.runs {
					r.(map[string]any)["workflow_id"] = 4000
				}
			}
			_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				req := decodeCLIRequest(t, w, r)
				body := f.response(t, req)
				if req["path"] == "/repos/acme/repo/actions/workflows" && f.calls("/actions/workflows") == 2 {
					page := body.(map[string]any)
					switch scenario {
					case "late-duplicate":
						page["workflows"] = []any{f.workflows[0]}
					case "late-short":
						page["workflows"] = []any{}
					case "late-total-change":
						page["total_count"] = 102
					}
				}
				writeCLIEnvelope(t, w, body)
			})
			var out bytes.Buffer
			err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{json: []string{"name", "workflow", "event"}})
			invalid := strings.HasPrefix(scenario, "late-") || strings.HasPrefix(scenario, "1001-")
			if invalid {
				if !isLocalFallback(err) || out.Len() != 0 {
					t.Errorf("incomplete metadata escaped before output: err=%v bytes=%d", err, out.Len())
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				var rows []map[string]any
				if e := json.Unmarshal(out.Bytes(), &rows); e != nil {
					t.Fatal(e)
				}
				if len(rows) != len(f.checks)+len(f.statuses) {
					t.Errorf("complete output rows=%d", len(rows))
				}
				if scenario != "21-without-actions" && rows[0]["workflow"] != "CI" {
					t.Errorf("late-page association missing: %v", rows[0])
				}
			}
			wantRuns, wantCatalogue := (count+99)/100, (count+99)/100
			if scenario == "1001-runs" {
				wantRuns, wantCatalogue = 1, 0
			}
			if scenario == "1001-workflows" {
				wantRuns, wantCatalogue = 1, 1
			}
			if scenario == "21-without-actions" {
				wantRuns, wantCatalogue = 0, 0
			}
			if f.calls("/actions/runs") != wantRuns || f.calls("/actions/workflows") != wantCatalogue {
				t.Errorf("complete bounded joins: runs=%d want=%d catalogue=%d want=%d", f.calls("/actions/runs"), wantRuns, f.calls("/actions/workflows"), wantCatalogue)
			}
			if policies.Load() != int64(len(f.requests)) {
				t.Errorf("policy/data split: policies=%d data=%d", policies.Load(), len(f.requests))
			}
			if scenario == "41-operations" && len(f.requests) != 41 || scenario == "21-without-actions" && len(f.requests) != 21 {
				t.Errorf("logical data budget=%d", len(f.requests))
			}
		})
	}
}

func TestPRChecksLogicalDedupAcrossPages(t *testing.T) {
	for _, mode := range []string{"json", "human", "watch"} {
		t.Run(mode, func(t *testing.T) {
			f := newPRChecksFixture()
			f.checks = []any{}
			for i := 0; i < 100; i++ {
				c := prChecksCheck(int64(i+1), "unit", "completed", "failure")
				c["started_at"] = "2026-09-01T00:00:00Z"
				f.checks = append(f.checks, c)
			}
			f.checks = append(f.checks, prChecksCheck(101, "unit", "completed", "success"))
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			sleeps := recordWatchSleeps(t)
			var out bytes.Buffer
			args := []string{"checks", "7", "-R", "acme/repo"}
			if mode == "json" {
				args = append(args, "--json", "name,state")
			}
			if mode == "watch" {
				args = append(args, "--watch")
			}
			result := handleGHPR(t.Context(), args, &out)
			if result.err != nil || result.action != ghComplete {
				t.Errorf("obsolete failure survived logical dedup: action=%v err=%v", result.action, result.err)
			}
			if mode == "json" {
				if out.String() != "[{\"name\":\"unit\",\"state\":\"SUCCESS\"}]\n" {
					t.Errorf("expected only newest successful check, bytes=%d", out.Len())
				}
			} else {
				if strings.Count(out.String(), "unit\t") != 1 {
					t.Errorf("obsolete rows printed: %d", strings.Count(out.String(), "unit\t"))
				}
				if mode == "watch" && !strings.Contains(out.String(), "checks: 0 pending, 1 pass, 0 fail, 0 cancel\n") {
					t.Errorf("watch counts not deduped")
				}
			}
			if len(*sleeps) != 0 {
				t.Errorf("terminal checks slept: %v", *sleeps)
			}
		})
	}
}

func TestPRChecksDedupNamespacesAndLiteralKey(t *testing.T) {
	for _, scenario := range []string{"workflow-event-status", "slash-key", "equal-start-no-invented-winner"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPRChecksFixture()
			f.checks, f.runs, f.workflows = []any{}, []any{}, []any{}
			for i := 0; i < 3; i++ {
				c := prChecksCheck(int64(i+1), "unit", "completed", "success")
				c["check_suite"] = map[string]any{"id": 201 + i}
				c["started_at"] = fmt.Sprintf("2026-09-01T0%d:00:00Z", i)
				workflow, event := "CI", "push"
				if i == 1 {
					workflow = "Other"
				}
				if i == 2 {
					event = "pull_request"
				}
				if scenario == "slash-key" {
					if i == 0 {
						c["name"], workflow, event = "a/b", "c", "push"
					} else if i == 1 {
						c["name"], workflow, event = "a", "b/c", "push"
					}
				}
				if scenario == "equal-start-no-invented-winner" {
					workflow, event = "CI", "push"
					c["started_at"] = "2026-09-01T00:00:00Z"
				}
				f.checks = append(f.checks, c)
				f.runs = append(f.runs, map[string]any{"id": 301 + i, "head_sha": metadataHead, "check_suite_id": 201 + i, "workflow_id": 401 + i, "name": "wrong", "event": event})
				f.workflows = append(f.workflows, map[string]any{"id": 401 + i, "name": workflow, "state": "active", "path": fmt.Sprintf(".github/workflows/%d.yml", i)})
			}
			if scenario == "workflow-event-status" {
				f.statuses = []any{map[string]any{"id": 10, "context": "unit", "state": "success", "created_at": "2026-09-01T00:00:00Z"}, map[string]any{"id": 11, "context": "unit", "state": "success", "created_at": "2026-09-01T01:00:00Z"}}
			}
			relayTestServer(t, func(r map[string]any) any { return f.response(t, r) })
			var out bytes.Buffer
			if err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{json: []string{"name", "state"}}); err != nil {
				t.Fatal(err)
			}
			var got []map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]int{"workflow-event-status": 4, "slash-key": 2, "equal-start-no-invented-winner": 1}[scenario]
			if len(got) != want {
				t.Fatalf("native logical namespaces/key rows=%d want=%d output=%s", len(got), want, out.String())
			}
		})
	}
}
