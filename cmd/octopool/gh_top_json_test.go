package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestFilterJSONFieldsUsesGHNames(t *testing.T) {
	raw := []byte(`{"number":85341,"title":"fix","html_url":"https://example.test/pr","head":{"ref":"feature","sha":"abc1234"},"draft":true}`)
	out, err := filterJSONFields(raw, []string{"number", "url", "headRefName", "headRefOid", "isDraft"}, fieldMapPR)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["url"] != "https://example.test/pr" || got["headRefName"] != "feature" || got["headRefOid"] != "abc1234" || got["isDraft"] != true {
		t.Fatalf("filtered = %#v", got)
	}
}

func TestFilterJSONFieldsPreservesNumbers(t *testing.T) {
	for _, test := range []struct{ name, raw, want string }{
		{"large id", `{"id":9007199254740993,"ignored":true}`, `{"id":9007199254740993}`},
		{"nested numbers", `{"owner":{"id":18446744073709551615,"score":0.123456789012345678901}}`, `{"owner":{"id":18446744073709551615,"score":0.123456789012345678901}}`},
		{"large exponent", `{"id":1e400}`, `{"id":1e400}`},
		{"list", `[{"id":9007199254740993},null,{"id":-9007199254740993}]`, `[{"id":9007199254740993},null,{"id":-9007199254740993}]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, err := filterJSONFields([]byte(test.raw), []string{"id", "owner"}, nil)
			if err != nil || string(out) != test.want {
				t.Fatalf("out=%s err=%v, want %s", out, err, test.want)
			}
		})
	}
}

func TestFilterJSONFieldsRejectsTrailingJSON(t *testing.T) {
	for _, raw := range []string{`{"id":1}{"id":2}`, `{"id":1} garbage`, `{"id":1} null`} {
		out, err := filterJSONFields([]byte(raw), []string{"id"}, nil)
		if err == nil || len(out) != 0 {
			t.Fatalf("input=%q out=%s err=%v", raw, out, err)
		}
	}
}

func TestWorkflowViewJSONPreservesID(t *testing.T) {
	relayTestServer(t, func(request map[string]any) any {
		if request["path"] != "/repos/acme/repo/actions/workflows/ci.yml" {
			t.Errorf("unexpected request: %v", request)
		}
		return map[string]any{"id": json.Number("9007199254740993"), "name": "CI"}
	})
	var out bytes.Buffer
	result := runGHTopLevel(t.Context(), []string{"workflow", "view", "ci.yml", "-R", "acme/repo", "--json", "id"}, &out)
	if result.err != nil || result.action != ghComplete || out.String() != "{\"id\":9007199254740993}\n" {
		t.Fatalf("action=%v err=%v out=%s", result.action, result.err, &out)
	}
}
