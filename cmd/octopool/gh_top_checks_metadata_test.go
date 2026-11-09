package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestPRCheckMetadataCatalogueRefresh(t *testing.T) {
	for _, mode := range []string{"checks", "rollup", "fresh-checks", "fresh-rollup", "watch"} {
		for _, scenario := range []string{"recovered", "still-missing", "missing-run", "missing-event"} {
			t.Run(mode+"/"+scenario, func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "")
				if strings.HasPrefix(mode, "fresh-") {
					t.Setenv("OCTOPOOL_FRESH", "1")
				}
				fresh := strings.HasPrefix(mode, "fresh-") || mode == "watch"
				rollup := strings.HasSuffix(mode, "rollup")
				f := newPRChecksFixture()
				check := prChecksCheck(2, "deploy", "completed", "success")
				check["check_suite"] = map[string]any{"id": 202}
				f.checks = append(f.checks, check)
				f.runs = append(f.runs, map[string]any{"id": 302, "head_sha": metadataHead, "check_suite_id": 202, "workflow_id": 402, "event": "push"})
				if scenario == "missing-run" {
					f.runs = f.runs[:1]
				} else if scenario == "missing-event" {
					delete(f.runs[1].(map[string]any), "event")
				}
				workflows := f.workflows
				f.workflows = nil
				for i := 0; i < 100; i++ {
					f.workflows = append(f.workflows, map[string]any{"id": 1000 + i, "name": "unrelated", "state": "active", "path": ".github/workflows/other.yml"})
				}
				f.workflows = append(f.workflows, workflows...)
				f.workflows = append(f.workflows, map[string]any{"id": 402, "name": "Deploy", "state": "active", "path": ".github/workflows/deploy.yml"})
				relayTestServer(t, func(request map[string]any) any {
					response := f.response(t, request)
					if strings.HasSuffix(request["path"].(string), "/actions/workflows") {
						headers, _ := request["headers"].(map[string]any)
						if headers["cache-control"] != "max-age=0" || scenario != "recovered" {
							return map[string]any{"total_count": 100, "workflows": f.workflows[:100]}
						}
					}
					return response
				})
				client, err := newGHRelayClient()
				if err != nil {
					t.Fatal(err)
				}
				names := map[string]string{}
				if rollup {
					var items []any
					items, err = relayPRStatusCheckRollup(t.Context(), client, "acme/repo", metadataHead)
					for _, raw := range items {
						item := raw.(map[string]any)
						names[item["name"].(string)] = item["workflowName"].(string)
					}
				} else {
					var items []prCheckRow
					if mode == "watch" {
						items, err = prCheckItemsForSHAFresh(t.Context(), client, "acme/repo", metadataHead)
					} else {
						items, err = prCheckItemsForSHAWithHeaders(t.Context(), client, "acme/repo", metadataHead, nil)
					}
					for _, item := range items {
						names[item.Name] = item.Workflow
					}
				}
				wantCatalogueReads := 1
				if scenario == "recovered" {
					wantCatalogueReads = 2 // Both fresh pages are required to find the names.
					if err != nil || !reflect.DeepEqual(names, map[string]string{"unit": "CI", "deploy": "Deploy"}) {
						t.Fatalf("workflow association failed: names=%v err=%v", names, err)
					}
				} else if !isLocalFallback(err) || !strings.Contains(err.Error(), "missing workflow association for GitHub Actions check suite") || len(names) != 0 {
					t.Fatalf("unverified association must fall back without rows: names=%v err=%v", names, err)
				}
				if !fresh && (scenario == "recovered" || scenario == "still-missing") {
					wantCatalogueReads++ // Exactly one retry of the complete catalogue.
				}
				if f.calls("/actions/workflows") != wantCatalogueReads || f.calls("/actions/runs") != 1 || f.calls("/check-runs") != 1 || f.calls("/status") != 1 {
					t.Fatalf("unexpected collection reads: catalogue=%d want=%d requests=%v", f.calls("/actions/workflows"), wantCatalogueReads, f.requests)
				}
				catalogueReads := 0
				for _, request := range f.requests {
					headers, _ := request["headers"].(map[string]any)
					var wantCacheControl any
					if strings.HasSuffix(request["path"].(string), "/actions/workflows") {
						if fresh || catalogueReads > 0 {
							wantCacheControl = "max-age=0"
						}
						catalogueReads++
					} else if fresh || rollup {
						wantCacheControl = "max-age=0"
					}
					if headers["cache-control"] != wantCacheControl {
						t.Errorf("collection freshness: request=%v want=%v", request, wantCacheControl)
					}
				}
			})
		}
	}
}

func TestPRChecksSkipUnusedWorkflowMetadata(t *testing.T) {
	for _, test := range []struct {
		fields        []string
		metadataReads int
		row           map[string]any
	}{
		{nil, 0, nil},
		{[]string{"name", "state", "bucket"}, 0, map[string]any{"name": "unit", "state": "SUCCESS", "bucket": "pass"}},
		{[]string{"name", "workflow"}, 1, map[string]any{"name": "unit", "workflow": "CI"}},
		{[]string{"name", "event"}, 1, map[string]any{"name": "unit", "event": "pull_request"}},
	} {
		t.Run(strings.Join(test.fields, ","), func(t *testing.T) {
			f := newPRChecksFixture()
			relayTestServer(t, func(request map[string]any) any { return f.response(t, request) })
			var out bytes.Buffer
			if err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{json: test.fields}); err != nil {
				t.Fatal(err)
			}
			if f.calls("/actions/runs") != test.metadataReads || f.calls("/actions/workflows") != test.metadataReads {
				t.Fatalf("unexpected metadata reads: %v", f.requests)
			}
			if test.row == nil {
				if !strings.Contains(out.String(), "unit\tpass") {
					t.Fatalf("human output = %q", out.String())
				}
			} else {
				var rows []map[string]any
				if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
					t.Fatal(err)
				}
				if want := []map[string]any{test.row}; !reflect.DeepEqual(rows, want) {
					t.Fatalf("rows = %v, want %v", rows, want)
				}
			}
		})
	}
}

func TestPRChecksUnusedMetadataStillValidatesIdentity(t *testing.T) {
	for _, scenario := range []string{"wrong-head", "missing-app", "missing-suite"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPRChecksFixture()
			check := f.checks[0].(map[string]any)
			switch scenario {
			case "wrong-head":
				check["head_sha"] = strings.Repeat("f", 40)
			case "missing-app":
				delete(check, "app")
			case "missing-suite":
				delete(check, "check_suite")
			}
			relayTestServer(t, func(request map[string]any) any { return f.response(t, request) })
			var out bytes.Buffer
			err := relayPRChecks(t.Context(), &out, "acme/repo", "7", ghTopOptions{json: []string{"name"}})
			if !isLocalFallback(err) || out.Len() != 0 {
				t.Fatalf("invalid identity escaped: err=%v output=%q", err, out.String())
			}
			if f.calls("/actions/runs") != 0 || f.calls("/actions/workflows") != 0 {
				t.Fatalf("invalid identity fetched metadata: %v", f.requests)
			}
		})
	}
}
