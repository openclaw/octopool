package main

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestTopLevelRepoNumber(t *testing.T) {
	opts := ghTopOptions{repo: "openclaw/openclaw", positionals: []string{"85341"}}
	repo, number, ok := repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{positionals: []string{"https://github.com/openclaw/openclaw/pull/85341"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber URL = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "cli/cli", positionals: []string{"1"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "cli/cli" || number != "1" {
		t.Fatalf("repoNumber outside default owner = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "openclaw", positionals: []string{"1"}}
	if _, _, ok = repoNumber(opts); ok {
		t.Fatal("malformed explicit repo should fall back")
	}
}

func TestGHTopReadOptionDispatch(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		mode string
		want string
	}{
		{"control_plain", []string{"pr", "view", "7", "--json", "number,title"}, "relay", `{"number":7,"title":"synthetic"}`},
		{"regression_append", []string{"pr", "view", "7", "--json", "number", "--json", "title"}, "relay", `{"number":7,"title":"synthetic"}`},
		{"regression_empty_last", []string{"pr", "view", "7", "--json", "number", "--json="}, "relay", `{"number":7}`},
		{"regression_quoted", []string{"pr", "view", "7", "--json", `"number",title`}, "relay", `{"number":7,"title":"synthetic"}`},
		{"regression_first_record", []string{"pr", "view", "7", "--json", "number\n\"unterminated"}, "relay", `{"number":7}`},
		{"regression_unsupported_earlier", []string{"pr", "view", "7", "--json", "bogus", "--json", "number"}, "delegate", ""},
		{"regression_invalid_csv_earlier", []string{"pr", "view", "7", "--json", `"unterminated`, "--json", "number"}, "reject", ""},
		{"regression_space_field", []string{"pr", "view", "7", "--json", "number title"}, "delegate", ""},
		{"regression_empty_element", []string{"pr", "view", "7", "--json", "number,,title"}, "delegate", ""},
		{"regression_leading_space", []string{"pr", "view", "7", "--json", "number, title"}, "delegate", ""},
		{"regression_empty_json", []string{"pr", "view", "7", "--json="}, "delegate", ""},
		{"regression_empty_jq_without_json", []string{"pr", "view", "7", "--jq="}, "reject", ""},
		{"regression_short_equals_jq", []string{"pr", "view", "7", "--json", "number", "-q="}, "jqerror", ""},
		{"control_last_jq", []string{"pr", "view", "7", "--json", "number,title", "--jq", "(", "--jq", ".number"}, "relay", "7"},
		{"control_final_empty_jq", []string{"pr", "view", "7", "--json", "number", "--jq", "(", "--jq="}, "relay", `{"number":7}`},
		{"regression_undeclared_empty_state", []string{"pr", "view", "7", "--state=", "--json", "number"}, "delegate", ""},
		{"regression_undeclared_branch", []string{"pr", "list", "--branch", "main", "--json", "number"}, "delegate", ""},
		{"regression_undeclared_attempt", []string{"issue", "list", "--attempt", "2", "--json", "number"}, "delegate", ""},
		{"regression_empty_unsupported_author", []string{"pr", "list", "--author=", "--json", "number"}, "delegate", ""},
		{"control_empty_unsupported_label", []string{"pr", "list", "--label=", "--json", "number"}, "delegate", ""},
		{"regression_search_empty_author", []string{"search", "issues", "bug", "--author=", "--json", "number"}, "reject", ""},
		{"control_search_multi_repo", []string{"search", "issues", "bug", "--repo", "acme/repo", "--json", "number"}, "delegate", ""},
		{"control_search_duplicate_csv_repo", []string{"search", "issues", "bug", "--repo", "acme/repo,acme/repo", "--json", "number"}, "delegate", ""},
		{"control_search_unknown_topic", []string{"search", "repos", "bug", "--topic=", "--json", "name"}, "delegate", ""},
		{"control_workflow_json_extension", []string{"workflow", "view", "ci.yml", "--json", "id,name"}, "relay", `{"id":42,"name":"synthetic"}`},
		{"control_gist_json_extension", []string{"gist", "view", "abc123", "--json", "id"}, "relay", `{"id":42}`},
		{"control_final_pr_state_case", []string{"pr", "list", "--state=OPEN", "--json", "number"}, "relay", `[{"number":7}]`},
		{"control_final_run_status_case", []string{"run", "list", "--status=COMPLETED", "--json", "databaseId"}, "delegate", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if strings.Contains(test.name, "jq") && !jqAvailable() {
				t.Skip("jq not installed")
			}
			var requests []map[string]any
			relayTestServer(t, func(req map[string]any) any { requests = append(requests, req); return nativeOptionsResponse(t, req) })
			args := append(slices.Clone(test.args), "-R", "acme/repo")
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), args, &out)
			if test.mode == "jqerror" {
				if out.Len() != 0 || (result.action != ghDelegate && (result.action != ghFail || result.err == nil)) {
					t.Fatalf("-q= must retain '=' as the jq program or delegate: action=%v err=%v output=%q", result.action, result.err, out.String())
				}
				return
			}
			if test.mode == "relay" {
				if result.action != ghComplete || result.err != nil || len(requests) != 1 || strings.TrimSpace(out.String()) != test.want {
					t.Fatalf("action=%v err=%v data=%d output=%q want=%q", result.action, result.err, len(requests), out.String(), test.want)
				}
				return
			}
			// A native-invalid shape may fail here or delegate intact, but never relay partial fields.
			if len(requests) != 0 || out.Len() != 0 || (result.action != ghDelegate && (test.mode == "delegate" || result.action != ghFail)) {
				t.Fatalf("shape must %s without data/output: action=%v err=%v data=%d output=%q", test.mode, result.action, result.err, len(requests), out.String())
			}
		})
	}
}

func TestGHTopListLimitDispatch(t *testing.T) {
	type limitCase struct {
		name   string
		flags  []string
		limit  string
		action ghAction
	}
	for _, command := range []struct {
		name         string
		args         []string
		defaultLimit string
	}{
		{"pr", []string{"pr", "list", "--json", "number"}, "30"},
		{"issue", []string{"issue", "list", "--json", "number"}, "100"},
		{"run", []string{"run", "list", "--json", "databaseId"}, "20"},
		{"release", []string{"release", "list", "--json", "name"}, "30"},
		{"workflow", []string{"workflow", "list", "--json", "id"}, "50"},
		{"label", []string{"label", "list", "--json", "name"}, "30"},
		{"search_issues", []string{"search", "issues", "bug", "--json", "number"}, "30"},
		{"search_prs", []string{"search", "prs", "bug", "--json", "number"}, "30"},
		{"search_repos", []string{"search", "repos", "bug", "--json", "name"}, "30"},
	} {
		cases := []limitCase{
			{"control_default", nil, command.defaultLimit, ghComplete},
			{"regression_zero", []string{"--limit=0"}, "", ghFail},
			{"regression_negative", []string{"--limit=-1"}, "", ghFail},
			{"regression_octal", []string{"--limit=010"}, "8", ghComplete},
			{"regression_hex", []string{"--limit=0x10"}, "16", ghComplete},
			{"regression_invalid_earlier", []string{"--limit=08", "--limit=2"}, "", ghFail},
			{"control_final_range", []string{"--limit=0", "--limit=2"}, "2", ghComplete},
			{"control_search_range_override", []string{"--limit=1001", "--limit=2"}, "2", ghComplete},
			{"control_relay_cap", []string{"--limit=101"}, "", ghDelegate},
		}
		if command.name == "pr" || command.name == "search_issues" {
			positive, negative := ghDelegate, ghFail
			if math.MaxInt == math.MaxInt32 {
				negative = ghDelegate
			} else if command.name == "search_issues" {
				positive = ghFail
			}
			cases = append(cases,
				limitCase{"control_positive_wrap_to_one", []string{"--limit=4294967297"}, "", positive},
				limitCase{"control_negative_wrap_to_one", []string{"--limit=-4294967295"}, "", negative},
				limitCase{"control_relay_endpoint", []string{"--limit=100"}, "100", ghComplete},
			)
		}
		if command.name == "search_issues" {
			cases = append(cases,
				limitCase{"control_search_endpoint", []string{"--limit=1000"}, "", ghDelegate},
				limitCase{"control_search_above_endpoint", []string{"--limit=1001"}, "", ghFail},
			)
		}
		for _, test := range cases {
			t.Run(command.name+"/"+test.name, func(t *testing.T) {
				var requests []map[string]any
				relayTestServer(t, func(req map[string]any) any { requests = append(requests, req); return nativeOptionsResponse(t, req) })
				args := append(slices.Clone(command.args), test.flags...)
				if command.name != "search_repos" {
					args = append(args, "-R", "acme/repo")
				}
				var out bytes.Buffer
				result := runGHTopLevel(t.Context(), args, &out)
				if result.action != test.action || (result.err != nil) != (test.action == ghFail) {
					t.Fatalf("action=%v want=%v err=%v", result.action, test.action, result.err)
				}
				if test.limit == "" {
					if len(requests) != 0 || out.Len() != 0 {
						t.Fatalf("invalid/unrepresentable limit relayed: action=%v err=%v data=%d output=%q", result.action, result.err, len(requests), out.String())
					}
					return
				}
				if result.action != ghComplete || result.err != nil || len(requests) != 1 {
					t.Fatalf("action=%v err=%v requests=%v", result.action, result.err, requests)
				}
				want := test.limit
				if command.name == "issue" {
					want = "100"
				}
				if got := requests[0]["query"].(map[string]any)["per_page"]; got != want {
					t.Fatalf("per_page=%v want=%s", got, want)
				}
			})
		}
	}
}

func TestGHTopReadEnumOccurrences(t *testing.T) {
	for _, command := range []struct {
		name        string
		args        []string
		flag, valid string
	}{
		{"pr", []string{"pr", "list"}, "--state", "open"},
		{"issue", []string{"issue", "list"}, "--state", "open"},
		{"run", []string{"run", "list"}, "--status", "completed"},
		{"search_issues", []string{"search", "issues", "bug"}, "--state", "open"},
		{"search_prs", []string{"search", "prs", "bug"}, "--state", "open"},
	} {
		for _, first := range []string{"invalid", "", strings.ToUpper(command.valid)} {
			t.Run(command.name+"/earlier="+first, func(t *testing.T) {
				requests := 0
				relayTestServer(t, func(req map[string]any) any { requests++; return nativeOptionsResponse(t, req) })
				field := "number"
				if command.name == "run" {
					field = "databaseId"
				}
				args := append(slices.Clone(command.args), "-R", "acme/repo", "--json", field, command.flag, first, command.flag, command.valid)
				var out bytes.Buffer
				result := runGHTopLevel(t.Context(), args, &out)
				if first == strings.ToUpper(command.valid) {
					if result.action != ghComplete || result.err != nil || requests != 1 {
						t.Fatalf("valid case-insensitive occurrence: action=%v err=%v data=%d", result.action, result.err, requests)
					}
				} else if requests != 0 || out.Len() != 0 || (result.action != ghFail && result.action != ghDelegate) {
					t.Fatalf("invalid earlier enum disappeared: action=%v err=%v data=%d output=%q", result.action, result.err, requests, out.String())
				}
			})
		}
	}
}

func TestGHIssueLabelOccurrences(t *testing.T) {
	for _, test := range []struct {
		name     string
		flags    []string
		label    any
		delegate bool
	}{
		{"control_plain_csv", []string{"--label", "bug,help wanted", "--label", "docs"}, "bug,help wanted,docs", false},
		{"control_space", []string{"--label", "help wanted"}, "help wanted", false},
		{"regression_quote", []string{"--label", `"bug"`}, "bug", false},
		{"regression_doubled_quote", []string{"--label", `"a""b"`}, `a"b`, false},
		{"regression_empty", []string{"--label="}, nil, false},
		{"regression_empty_last", []string{"--label", "bug", "--label="}, "bug", false},
		{"regression_first_record", []string{"--label", "bug\nignored"}, "bug", false},
		{"regression_comma_label", []string{"--label", `"a,b"`}, nil, true},
		{"regression_empty_element", []string{"--label", "a,,b"}, nil, true},
		{"regression_quoted_empty", []string{"--label", `""`}, nil, true},
		{"regression_multiline", []string{"--label", "\"a\r\nb\""}, nil, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests []map[string]any
			relayTestServer(t, func(req map[string]any) any { requests = append(requests, req); return nativeOptionsResponse(t, req) })
			args := append([]string{"issue", "list", "-R", "acme/repo", "--json", "number"}, test.flags...)
			var out bytes.Buffer
			result := runGHTopLevel(t.Context(), args, &out)
			if test.delegate {
				if result.action != ghDelegate || len(requests) != 0 || out.Len() != 0 {
					t.Fatalf("unrepresentable label relayed: action=%v data=%d output=%q", result.action, len(requests), out.String())
				}
				return
			}
			if result.action != ghComplete || result.err != nil || len(requests) != 1 {
				t.Fatalf("action=%v err=%v data=%d", result.action, result.err, len(requests))
			}
			query := requests[0]["query"].(map[string]any)
			if _, present := query["labels"]; test.label == nil && present {
				t.Fatalf("empty effective labels must omit query key: %v", query)
			}
			if query["labels"] != test.label || query["per_page"] != "100" {
				t.Fatalf("labels=%#v want=%#v query=%v", query["labels"], test.label, query)
			}
		})
	}
}

func TestGHIssueLimitCountsFilteredItems(t *testing.T) {
	relayTestServer(t, func(req map[string]any) any {
		if req["query"].(map[string]any)["per_page"] != "100" {
			t.Error("issue filtering page size changed")
		}
		items := []any{map[string]any{"number": 99, "pull_request": map[string]any{}}}
		for i := 1; i <= 12; i++ {
			items = append(items, map[string]any{"number": i})
		}
		return items
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{"issue", "list", "-R", "acme/repo", "--json", "number", "--limit=010"}, &out)
	var got []map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if result.action != ghComplete || len(got) != 8 || !reflect.DeepEqual(got[7], map[string]any{"number": float64(8)}) {
		t.Fatalf("action=%v err=%v filtered=%v", result.action, result.err, got)
	}
}

func TestParseGHTopOptions(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{
		"-R", "openclaw/openclaw",
		"--json", "number,title,url",
		"--jq", ".number",
		"--limit", "50",
		"--state=open",
		"--label", "bug",
		"85341",
	}, topReadSpecs("issue list"))
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if opts.repo != "openclaw/openclaw" || opts.limit != 50 || opts.state != "open" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.json) != 3 || opts.json[2] != "url" || opts.jq != ".number" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.labels) != 1 || opts.labels[0] != "bug" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.positionals) != 1 || opts.positionals[0] != "85341" {
		t.Fatalf("opts = %#v", opts)
	}
}

func TestParseGHTopOptionsRejectsInvalidLimit(t *testing.T) {
	_, fallback, err := parseGHTopOptions([]string{"--limit", "nope"}, topReadSpecs("issue list"))
	if err == nil || fallback {
		t.Fatalf("fallback=%v err=%v", fallback, err)
	}
}

func TestParseGHTopOptionsValidatesAttempt(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{"42", "--attempt", "2"}, topReadSpecs("run view"))
	if err != nil || fallback || !opts.attemptSet || opts.attempt != 2 {
		t.Fatalf("opts=%#v fallback=%v err=%v", opts, fallback, err)
	}
	for _, value := range []string{"nope", "-1"} {
		if _, _, err := parseGHTopOptions([]string{"42", "--attempt", value}, topReadSpecs("run view")); err == nil {
			t.Fatalf("--attempt %s must fail", value)
		}
	}
}

func TestParseGHTopOptionsJSONOccurrences(t *testing.T) {
	for _, test := range []struct {
		name       string
		args, want []string
		invalid    bool
	}{
		{"control_plain_dedup", []string{"--json", "number,title,number"}, []string{"number", "title"}, false},
		{"regression_append", []string{"--json", "number", "--json=title,number"}, []string{"number", "title"}, false},
		{"regression_empty_last", []string{"--json", "number", "--json="}, []string{"number"}, false},
		{"control_empty_first", []string{"--json=", "--json", "number"}, []string{"number"}, false},
		{"regression_quoted_fields", []string{"--json", `"number",title`}, []string{"number", "title"}, false},
		{"regression_significant_space", []string{"--json", "number, title"}, []string{"number", " title"}, false},
		{"regression_not_space_separated", []string{"--json", "number title"}, []string{"number title"}, false},
		{"regression_empty_element", []string{"--json", "number,,title"}, []string{"number", "", "title"}, false},
		{"regression_quoted_empty", []string{"--json", `""`}, []string{""}, false},
		{"regression_doubled_quote", []string{"--json", `"a""b"`}, []string{`a"b`}, false},
		{"regression_first_record", []string{"--json", "number\nunknown"}, []string{"number"}, false},
		{"regression_ignored_malformed_record", []string{"--json", "number\n\"unterminated"}, []string{"number"}, false},
		{"regression_blank_line_crlf", []string{"--json", "\nnumber\r\nignored"}, []string{"number"}, false},
		{"regression_quoted_multiline", []string{"--json", "\"a\r\nb\""}, []string{"a\nb"}, false},
		{"regression_invalid_first", []string{"--json", `"unterminated`, "--json", "number"}, nil, true},
		{"regression_bare_quote", []string{"--json", `a"b`}, nil, true},
		{"regression_after_quote", []string{"--json", `"a"x`}, nil, true},
		{"regression_blank_record_only", []string{"--json", "\n"}, nil, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			opts, fallback, err := parseGHTopOptions(test.args, topReadSpecs("issue list"))
			if test.invalid {
				if err == nil || fallback {
					t.Fatalf("invalid CSV accepted: fields=%q fallback=%v err=%v", opts.json, fallback, err)
				}
				return
			}
			if err != nil || fallback || !slices.Equal(opts.json, test.want) {
				t.Fatalf("fields=%q want=%q fallback=%v err=%v", opts.json, test.want, fallback, err)
			}
		})
	}
}

func TestParseGHTopOptionsLimitOccurrences(t *testing.T) {
	type limitCase struct {
		raw  string
		want int64
	}
	cases := []limitCase{
		{"0", 0}, {"+0", 0}, {"-0", 0}, {"+16", 16}, {"-16", -16},
		{"010", 8}, {"0o10", 8}, {"0O10", 8}, {"0b10", 2}, {"0B10", 2},
		{"0x10", 16}, {"0X10", 16}, {"1_0", 10}, {"0x_F", 15},
		{"-9223372036854775808", -9223372036854775808}, {"9223372036854775807", 9223372036854775807},
		{"4294967297", 4294967297}, {"-4294967295", -4294967295},
	}
	if math.MaxInt != math.MaxInt64 {
		cases = append(cases,
			limitCase{strconv.FormatInt(int64(math.MinInt), 10), math.MinInt},
			limitCase{strconv.FormatInt(int64(math.MaxInt), 10), math.MaxInt},
		)
	}
	for _, test := range cases {
		t.Run("syntax/"+test.raw, func(t *testing.T) {
			opts, fallback, err := parseGHTopOptions([]string{"--limit", test.raw}, topReadSpecs("issue list"))
			wantFallback := test.want < math.MinInt || test.want > math.MaxInt
			if err != nil || fallback != wantFallback || !opts.limitSet || (!wantFallback && int64(opts.limit) != test.want) {
				t.Fatalf("limit=%d want=%d fallback=%v wantFallback=%v err=%v", opts.limit, test.want, fallback, wantFallback, err)
			}
		})
	}
	for _, raw := range []string{"", " 1", "1 ", "08", "1.0", "1e2", "_1", "1_", "1__0", "0x", "+", "--1", "9223372036854775808", "-9223372036854775809"} {
		t.Run("invalid_occurrence/"+raw, func(t *testing.T) {
			_, fallback, err := parseGHTopOptions([]string{"--limit", raw, "-L=2"}, topReadSpecs("issue list"))
			if err == nil || fallback {
				t.Fatalf("invalid earlier limit erased: fallback=%v err=%v", fallback, err)
			}
		})
	}
	for _, raw := range []string{"0", "-1", "1001", "9223372036854775807", "4294967297", "-4294967295"} {
		t.Run("control_final_range/"+raw, func(t *testing.T) {
			opts, fallback, err := parseGHTopOptions([]string{"--limit", raw, "--limit=2"}, topReadSpecs("issue list"))
			if err != nil || fallback || opts.limit != 2 {
				t.Fatalf("limit=%d fallback=%v err=%v", opts.limit, fallback, err)
			}
		})
	}
}

func TestParseGHTopOptionsScalarOwnership(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{"--repo", "acme/old", "-R=acme/repo", "--assignee", "alice", "--assignee=bob,carol", "--author", `"alice"`, "--jq", "(", "--jq=.number"}, topReadSpecs("issue list"))
	if err != nil || fallback || opts.repo != "acme/repo" || opts.assignee != "bob,carol" || opts.author != `"alice"` || opts.jq != ".number" {
		t.Fatalf("scalar assignment must not CSV-decode or validate discarded jq: opts=%#v fallback=%v err=%v", opts, fallback, err)
	}
}
