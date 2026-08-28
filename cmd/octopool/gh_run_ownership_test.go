package main

import (
	"bytes"
	"encoding/json"
	"maps"
	"strconv"
	"strings"
	"testing"
)

func TestRunOwnershipFreshAndHistoricalHead(t *testing.T) {
	for _, id := range []string{"33167365292", "33167365221"} {
		for _, fresh := range []bool{false, true} {
			t.Run(id+"/fresh="+strconv.FormatBool(fresh), func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "0")
				if fresh {
					t.Setenv("OCTOPOOL_FRESH", "1")
				}
				const head = "224a80eeebec678db6646ef888f5bbc89caf63c4"
				var paths []string
				relayTestServer(t, func(body map[string]any) any {
					path := body["path"].(string)
					paths = append(paths, path)
					headers, _ := body["headers"].(map[string]any)
					if fresh && headers["cache-control"] != "max-age=0" {
						t.Errorf("%s headers=%v, want max-age=0", path, headers)
					}
					if !fresh && headers["cache-control"] != nil {
						t.Errorf("ordinary %s read bypasses cache: %v", path, headers)
					}
					if strings.HasSuffix(path, "/jobs") {
						return map[string]any{"total_count": 0, "jobs": []any{}}
					}
					numericID, _ := strconv.ParseInt(id, 10, 64)
					return map[string]any{"id": numericID, "head_sha": head, "head_branch": "fixture-branch", "event": "pull_request", "name": "CI", "run_attempt": 1, "pull_requests": []any{map[string]any{"head": map[string]any{"sha": "9999999999999999999999999999999999999999"}}}}
				})
				var out bytes.Buffer
				result := handleGHRun(t.Context(), []string{"view", id, "-R", "openclaw/Peekaboo", "--json", "databaseId,headSha,headBranch,event,workflowName,jobs"}, &out)
				if result.err != nil || result.action != ghComplete {
					t.Fatalf("result=%+v", result)
				}
				var got map[string]any
				if err := json.Unmarshal(out.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if got["headSha"] != head {
					t.Fatalf("historical head mapping=%v", got)
				}
				if len(paths) != 2 || paths[1] != "/repos/openclaw/Peekaboo/actions/runs/"+id+"/attempts/1/jobs" {
					t.Fatalf("paths=%v", paths)
				}
			})
		}
	}
}

func TestRelayFreshPreservesExplicitHeadersAndCallerMap(t *testing.T) {
	t.Setenv("OCTOPOOL_FRESH", "1")
	var seen map[string]any
	relayTestServer(t, func(body map[string]any) any { seen, _ = body["headers"].(map[string]any); return map[string]any{} })
	client, err := newGHRelayClient()
	if err != nil {
		t.Fatal(err)
	}
	for _, headers := range []map[string]string{nil, {"x-octopool-public-shape": "actions-summary-v1"}, {"cache-control": "max-age=60"}, {"cache-control": ""}} {
		before := maps.Clone(headers)
		_, err := client.do(t.Context(), ghAPIRequest{method: "GET", path: "/repos/openclaw/Peekaboo/actions/runs/33167365292", headers: headers})
		if err != nil {
			t.Fatal(err)
		}
		want, explicit := headers["cache-control"]
		if !explicit {
			want = "max-age=0"
		}
		if seen["cache-control"] != want {
			t.Errorf("headers=%v want cache-control=%q", seen, want)
		}
		if !maps.Equal(headers, before) {
			t.Errorf("mutated caller headers: before=%v after=%v", before, headers)
		}
	}
	request, delegate, err := parseGHAPIArgs([]string{"repos/openclaw/Peekaboo/actions/runs/33167365292", "-H", "Cache-Control: max-age=60"})
	if err != nil || delegate {
		t.Fatalf("delegate=%v err=%v", delegate, err)
	}
	if _, err := client.do(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	if seen["cache-control"] != "max-age=60" {
		t.Fatalf("raw explicit headers=%v", seen)
	}
}
