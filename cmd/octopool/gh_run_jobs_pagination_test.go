package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestRunJobsPagination(t *testing.T) {
	for _, mode := range []string{"json", "human", "watch"} {
		for _, test := range []struct {
			name      string
			total     int
			wantPages int
			failure   bool
		}{
			{"two_pages", 156, 2, false},
			{"ten_pages", 1000, 10, false},
			{"total_drift", 156, 2, true},
			{"duplicate_id", 156, 2, true},
			{"short_middle_page", 256, 2, true},
			{"bound", 1001, 1, true},
			{"foreign_run", 156, 2, true},
			{"foreign_head", 156, 2, true},
			{"reused_prior_attempt", 156, 2, false},
			{"last_next_link", 156, 2, true},
			{"wrong_next_link", 156, 1, true},
			{"oversized_page", 156, 1, true},
		} {
			t.Run(mode+"/"+test.name, func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "1")
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				if mode == "watch" {
					// An owned watch must not launch native gh even when fallback is enabled.
					t.Setenv("OCTOPOOL_NO_FALLBACK", "")
				}
				capture := captureRewriteGH(t)
				recordWatchSleeps(t)
				var pages []int
				fixture := newRunExportFixture()
				fixture.run["conclusion"] = "success"
				attempt := 3
				if test.name == "reused_prior_attempt" {
					attempt = 2
				}
				fixture.run["run_attempt"] = attempt
				relayTestServer(t, func(request map[string]any) any {
					path := request["path"].(string)
					headers, _ := request["headers"].(map[string]any)
					if headers["cache-control"] != "max-age=0" {
						t.Errorf("freshness lost on %s: %v", path, headers)
					}
					if path == "/repos/acme/repo/actions/runs/42" {
						return fixture.run
					}
					if path != fmt.Sprintf("/repos/acme/repo/actions/runs/42/attempts/%d/jobs", attempt) {
						t.Fatalf("unexpected path: %s", path)
					}
					shape := headers["x-octopool-public-shape"]
					if (mode == "json" && shape != nil) || (mode != "json" && shape != publicShapeActionsJobs) {
						t.Errorf("wrong jobs shape: %v", shape)
					}
					query := request["query"].(map[string]any)
					page, err := strconv.Atoi(query["page"].(string))
					if err != nil || page != len(pages)+1 || query["per_page"] != "100" {
						t.Fatalf("unexpected pagination: %v after %v", query, pages)
					}
					pages = append(pages, page)
					total := test.total
					start := (page - 1) * 100
					count := min(100, total-start)
					if test.name == "short_middle_page" && page == 2 {
						count--
					}
					if test.name == "oversized_page" {
						count++
					}
					jobs := make([]map[string]any, count)
					for i := range jobs {
						// Descending identities and names expose accidental sorting.
						id := 2000 - start - i
						jobs[i] = runExportJob(id)
						jobs[i]["name"] = fmt.Sprintf("job-%04d", id)
						jobs[i]["run_attempt"] = attempt
						if test.name == "reused_prior_attempt" && i%2 == 0 {
							jobs[i]["run_attempt"] = 1
						}
					}
					if page == 2 {
						switch test.name {
						case "total_drift":
							total++
						case "duplicate_id":
							jobs[0]["id"] = 2000
						case "foreign_run":
							jobs[0]["run_id"] = 43
						case "foreign_head":
							jobs[0]["head_sha"] = "foreign"
						}
					}
					responseHeaders := map[string]string{}
					if test.name == "last_next_link" || test.name == "wrong_next_link" {
						next := page + 1
						if test.name == "wrong_next_link" {
							next++
						}
						responseHeaders["Link"] = fmt.Sprintf(`<https://api.github.com%s?page=%d>; rel="next"`, path, next)
					}
					return relayTestResponse{Headers: responseHeaders, Body: map[string]any{"total_count": total, "jobs": jobs}}
				})
				args := []string{"run", "view", "42", "-R", "acme/repo"}
				if mode == "json" {
					args = append(args, "--json", "jobs")
				} else if mode == "watch" {
					args[1] = "watch"
				}
				var stdout, stderr bytes.Buffer
				err := runGH(t.Context(), args, &stdout, &stderr)
				if _, statErr := os.Stat(capture); !os.IsNotExist(statErr) {
					t.Fatal("pagination launched native gh")
				}
				if len(pages) != test.wantPages {
					t.Fatalf("pages=%v, want %d; err=%v", pages, test.wantPages, err)
				}
				if test.failure {
					if err == nil || strings.Contains(stdout.String(), "job-2000") || strings.Contains(stdout.String(), "completed with") {
						t.Fatalf("invalid collection leaked output: err=%v stdout=%q", err, stdout.String())
					}
					if mode == "watch" {
						if !strings.Contains(stdout.String(), "Watching run 42") || !strings.Contains(err.Error(), "without local gh fallback") {
							t.Fatalf("watch ownership lost: err=%v stdout=%q", err, stdout.String())
						}
					} else if !isLocalFallback(err) || stdout.Len() != 0 {
						t.Fatalf("view must fail closed before rendering: err=%v stdout=%q", err, stdout.String())
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if mode == "json" {
					var got struct{ Jobs []map[string]any }
					if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
						t.Fatal(err)
					}
					want := make([]map[string]any, test.total)
					for i := range want {
						id := 2000 - i
						want[i] = map[string]any{
							"databaseId": float64(id), "name": fmt.Sprintf("job-%04d", id), "status": "completed", "conclusion": "success",
							"startedAt": "2026-01-02T03:04:06Z", "completedAt": "2026-01-02T03:05:06Z",
							"url": "https://github.com/acme/repo/actions/runs/42/job/" + strconv.Itoa(id), "steps": []any{},
						}
					}
					if !reflect.DeepEqual(got.Jobs, want) {
						t.Fatal("jobs differ from native export fields or acquisition order")
					}
				} else {
					remaining := stdout.String()
					if strings.Count(remaining, "job-") != test.total {
						t.Fatalf("rendered job count differs from %d", test.total)
					}
					for i := 0; i < test.total; i++ {
						name := fmt.Sprintf("job-%04d", 2000-i)
						index := strings.Index(remaining, name)
						if index == -1 {
							t.Fatalf("missing or out-of-order job: %s", name)
						}
						remaining = remaining[index+len(name):]
					}
				}
			})
		}
	}
}
