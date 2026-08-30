package main

import (
	"bytes"
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
							writeCLIEnvelope(t, w, map[string]any{"head": map[string]any{"sha": metadataHead}})
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
	got := splitFields("assignees,assignees,files statusCheckRollup,files")
	if !reflect.DeepEqual(got, []string{"assignees", "files", "statusCheckRollup"}) {
		t.Fatalf("fields=%v", got)
	}
}

func TestGHPRChecksWatchRejectsRepeatedCollectionIDs(t *testing.T) {
	calls := 0
	relayTestServer(t, func(request map[string]any) any {
		path := request["path"].(string)
		if strings.HasSuffix(path, "/pulls/1") {
			return map[string]any{"head": map[string]any{"sha": metadataHead}}
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
