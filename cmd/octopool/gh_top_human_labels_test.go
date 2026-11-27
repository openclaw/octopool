package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestHumanViewLabelOrder(t *testing.T) {
	labels := func(names ...string) []any {
		items := make([]any, 0, len(names))
		for _, name := range names {
			items = append(items, map[string]any{"name": name})
		}
		return items
	}
	for _, command := range []string{"issue", "pr"} {
		for _, tt := range []struct {
			name   string
			labels any
			want   string
		}{
			{"reverse order", labels("zeta", "Beta", "alpha"), "alpha, Beta, zeta"},
			{"stable case ties and Unicode", labels("beta", "Beta", "Äther", "alpha"), "alpha, beta, Beta, Äther"},
			{"already sorted", labels("alpha", "Beta"), "alpha, Beta"},
			{"empty", labels(), ""},
			{"null", nil, ""},
			{"nonarray", "not labels", ""},
			{"invalid entries", []any{nil, "bad", map[string]any{"name": 3}, map[string]any{"name": ""}, map[string]any{"name": "beta"}, map[string]any{"name": "Alpha"}}, "Alpha, beta"},
			{"sort before sanitizing", labels("a", "\x1bZ"), "Z, a"},
		} {
			t.Run(command+"/"+tt.name, func(t *testing.T) {
				setHumanTestSeams(t, time.Time{})
				resource := "issues"
				if command == "pr" {
					resource = "pulls"
				}
				path := "/repos/acme/repo/" + resource + "/7"
				var paths []string
				relayTestServer(t, func(body map[string]any) any {
					requested, _ := body["path"].(string)
					paths = append(paths, requested)
					if requested == path+"/reviews" && command == "pr" {
						return []any{}
					}
					if requested != path {
						t.Errorf("unexpected request %q", requested)
						return nil
					}
					return map[string]any{
						"number": 7, "title": "Label fixture", "state": "open", "body": "Body",
						"user": map[string]any{"login": "author"}, "labels": tt.labels,
						"assignees": []any{map[string]any{"login": "zeta"}, map[string]any{"login": "Alpha"}},
						"milestone": map[string]any{"title": "Milestone"}, "comments": 0,
						"html_url": "https://github.com/acme/repo/pull/7", "additions": 0, "deletions": 0,
					}
				})
				var out, stderr bytes.Buffer
				if err := runGH(t.Context(), []string{command, "view", "7", "-R", "acme/repo"}, &out, &stderr); err != nil {
					t.Fatalf("runGH: %v, stderr=%q", err, stderr.String())
				}
				want := "title:\tLabel fixture\nstate:\tOPEN\nauthor:\tauthor\nlabels:\t" + tt.want + "\n"
				wantPaths := path
				if command == "pr" {
					want += "assignees:\tzeta, Alpha\nreviewers:\t\nprojects:\t\nmilestone:\tMilestone\nnumber:\t7\n" +
						"url:\thttps://github.com/acme/repo/pull/7\nadditions:\t0\ndeletions:\t0\nauto-merge:\tdisabled\n"
					wantPaths += "," + path + "/reviews"
				} else {
					want += "comments:\t0\nassignees:\tzeta, Alpha\nprojects:\t\nmilestone:\tMilestone\n" +
						"issue-type:\t\nparent:\t\nsub-issues:\t\nsub-issues-completed:\t\nblocked-by:\t\nblocking:\t\nnumber:\t7\n"
				}
				want += "--\nBody\n"
				if out.String() != want || stderr.Len() != 0 {
					t.Fatalf("output=%q stderr=%q, want=%q", out.String(), stderr.String(), want)
				}
				if got := strings.Join(paths, ","); got != wantPaths {
					t.Fatalf("requests=%q, want=%q", got, wantPaths)
				}
			})
		}
	}
}

func TestHumanViewLabelsPreserveSourceOrder(t *testing.T) {
	labels := []any{map[string]any{"name": "zeta"}, map[string]any{"name": "alpha"}}
	pr := map[string]any{"labels": labels}
	before, _ := json.Marshal(pr)
	var out bytes.Buffer
	if err := renderHumanPRView(&out, pr, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(pr)
	if !bytes.Equal(before, after) {
		t.Fatalf("renderer mutated input: before=%s after=%s", before, after)
	}
}

func TestHumanViewLabelOrderLeavesJSONAndIssueListOrder(t *testing.T) {
	for _, args := range [][]string{
		{"issue", "view", "7", "--json", "labels"},
		{"pr", "view", "7", "--json", "labels"},
		{"issue", "list"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			setHumanTestSeams(t, time.Time{})
			relayTestServer(t, func(body map[string]any) any {
				item := map[string]any{
					"number": 7, "title": "Label fixture", "state": "open", "updated_at": "2026-01-01T00:00:00Z",
					"labels": []any{
						map[string]any{"node_id": "LA_zeta", "name": "zeta", "color": "ffffff", "description": ""},
						map[string]any{"node_id": "LA_alpha", "name": "alpha", "color": "ffffff", "description": ""},
					},
				}
				if args[1] == "list" {
					return []any{item}
				}
				return item
			})
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), append(args, "-R", "acme/repo"), &out, &stderr); err != nil {
				t.Fatalf("runGH: %v, stderr=%q", err, stderr.String())
			}
			if args[1] == "list" {
				if want := "7\tOPEN\tLabel fixture\tzeta, alpha\t2026-01-01T00:00:00Z\n"; out.String() != want {
					t.Fatalf("output=%q, want=%q", out.String(), want)
				}
			} else {
				var value struct{ Labels []struct{ Name string } }
				if err := json.Unmarshal(out.Bytes(), &value); err != nil {
					t.Fatal(err)
				}
				if len(value.Labels) != 2 || value.Labels[0].Name != "zeta" || value.Labels[1].Name != "alpha" {
					t.Fatalf("JSON label order changed: %s", out.String())
				}
			}
		})
	}
}
