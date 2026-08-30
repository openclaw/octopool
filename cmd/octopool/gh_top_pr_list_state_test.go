package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func prListStateFixtures(public bool) ([]map[string]any, []string) {
	if public {
		return []map[string]any{
			{"state": "OPEN", "draft": false},
			{"state": "CLOSED", "draft": false},
			{"state": "DRAFT", "draft": true},
			{"state": "MERGED", "draft": false},
		}, []string{"OPEN", "CLOSED", "OPEN", "MERGED"}
	}
	return []map[string]any{
		{"state": "open", "draft": false, "merged_at": nil},
		{"state": "closed", "draft": false, "merged_at": nil},
		{"state": "closed", "draft": false, "merged_at": prStateTestTime},
		{"state": "open", "draft": true},
		{"state": "closed", "draft": true},
		{"state": "closed", "draft": false, "merged": true},
		{"state": "DRAFT", "draft": true, "closed_at": prStateTestTime},
	}, []string{"OPEN", "CLOSED", "MERGED", "OPEN", "CLOSED", "MERGED", "CLOSED"}
}

func TestRunGHPRListStateProjection(t *testing.T) {
	for _, test := range []struct {
		name, fields, shape  string
		public, empty, fresh bool
	}{
		{"public state", "state", "pr-list-v1", true, false, false},
		{"public expanded", "number,state,isDraft", "pr-list-v1", true, false, false},
		{"REST public fallback", "state", "pr-list-v1", false, false, false},
		{"REST forced", "state,headRefOid", "", false, false, false},
		{"REST expanded", "number,state,headRefOid,isDraft", "", false, false, false},
		{"state omitted", "number,isDraft", "pr-list-v1", false, false, false},
		{"fresh state omitted", "number,isDraft", "pr-list-v1", false, false, true},
		{"empty", "state,headRefOid", "", false, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("OCTOPOOL_FRESH", "")
			if test.fresh {
				t.Setenv("OCTOPOOL_FRESH", "1")
			}
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			items, states := prListStateFixtures(test.public)
			if test.empty {
				items, states = []map[string]any{}, []string{}
			}
			want := make([]map[string]any, 0, len(items))
			for i, item := range items {
				item["number"] = float64(i + 1)
				if !test.public {
					item["head"] = map[string]any{"sha": prStateTestHead}
				}
				all := map[string]any{"number": float64(i + 1), "state": states[i], "headRefOid": prStateTestHead, "isDraft": item["draft"]}
				row := map[string]any{}
				for _, field := range strings.Split(test.fields, ",") {
					row[field] = all[field]
				}
				want = append(want, row)
			}
			before, _ := json.Marshal(items)
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				headers := map[string]any{}
				if test.shape != "" {
					headers["x-octopool-public-shape"] = test.shape
				}
				if strings.Contains(test.fields, "state") || test.fresh {
					headers["cache-control"] = "max-age=0"
				}
				wantRequest := map[string]any{
					"pool": "maintainers", "method": "GET", "path": "/repos/openclaw/octopool/pulls",
					"query": map[string]any{"state": "all", "per_page": "20"}, "headers": headers,
				}
				if !reflect.DeepEqual(request, wantRequest) {
					t.Errorf("request = %#v, want %#v", request, wantRequest)
				}
				return items
			})
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), []string{"pr", "list", "-R", "openclaw/octopool", "--state", "all", "--limit", "20", "--json", test.fields}, &out, &stderr); err != nil {
				t.Fatalf("runGH: %v, stderr=%q", err, stderr.String())
			}
			var got []map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("projection = %#v, want %#v", got, want)
			}
			after, _ := json.Marshal(items)
			if !bytes.Equal(before, after) || calls != 1 {
				t.Errorf("source changed or extra requests: before=%s after=%s calls=%d", before, after, calls)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("unexpected native fallback")
			}
		})
	}
}

func TestRunGHPRListStateDelegation(t *testing.T) {
	for _, test := range []struct{ state, fields string }{
		{"closed", "state,headRefOid"}, {"merged", "state,headRefOid"},
		{"all", "state,mergeable"}, {"all", "state,comments"}, {"all", "state,merged"},
		{"all", "state,mergeStateStatus"},
	} {
		t.Run(test.state+"/"+test.fields, func(t *testing.T) {
			emptyRewriteTestServer(t)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			capture := captureRewriteGH(t)
			args := []string{"pr", "list", "-R", "openclaw/octopool", "--state", test.state, "--json", test.fields}
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			if got := readRewriteCapture(t, capture); !reflect.DeepEqual(got.Args, args) || out.String() != "child stdout\n" {
				t.Errorf("delegation: args=%v output=%q", got.Args, out.String())
			}
		})
	}
}
