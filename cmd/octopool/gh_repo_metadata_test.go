package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestRepoViewMetadata(t *testing.T) {
	for _, visibility := range []string{"public", "private", "internal"} {
		t.Run(visibility, func(t *testing.T) {
			relayTestServer(t, func(request map[string]any) any {
				return repoMetadataFixture(visibility)
			})
			var out bytes.Buffer
			result := handleGHRepo(t.Context(), []string{"view", "acme/repo", "--json", "owner,visibility,nameWithOwner"}, &out)
			want := map[string]any{
				"owner":         map[string]any{"id": "O_owner", "login": "acme"},
				"visibility":    strings.ToUpper(visibility),
				"nameWithOwner": "acme/repo",
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if result.err != nil || result.action != ghComplete || !reflect.DeepEqual(got, want) {
				t.Fatalf("action=%v err=%v got=%v want=%v", result.action, result.err, got, want)
			}
		})
	}
}

func repoMetadataFixture(visibility string) map[string]any {
	return map[string]any{
		"full_name": "acme/repo", "visibility": visibility,
		"owner": map[string]any{"id": 42, "node_id": "O_owner", "login": "acme", "type": "Organization", "url": "https://api.github.com/users/acme"},
	}
}

func TestCLIEndToEndRepoMetadata(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	server := cliRelayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeCLIEnvelope(t, w, repoMetadataFixture("public"))
	})
	for _, test := range []struct {
		name string
		args []string
		want string
	}{
		{"repo view", []string{"gh", "repo", "view", "acme/repo", "--json", "owner,visibility"}, `{"owner":{"id":"O_owner","login":"acme"},"visibility":"PUBLIC"}`},
		{"repo jq", []string{"gh", "repo", "view", "acme/repo", "--json", "owner,visibility", "--jq", ".owner.id,.visibility"}, "O_owner\nPUBLIC"},
		{"raw api", []string{"gh", "api", "repos/acme/repo", "--jq", ".owner.id,.owner.node_id,.visibility"}, "42\nO_owner\npublic"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.name != "repo view" && !jqAvailable() {
				t.Skip("jq not installed")
			}
			result := runCLI(t, bin, server.URL, nil, test.args...)
			if result.err != nil || result.stdout != test.want+"\n" {
				t.Fatalf("err=%v stdout=%q want=%q stderr=%q", result.err, result.stdout, test.want, result.stderr)
			}
		})
	}
}

func TestRepoViewIncompleteMetadata(t *testing.T) {
	for _, test := range []struct {
		name  string
		field string
		value any
	}{
		{"missing owner", "owner", nil},
		{"invalid owner", "owner", "acme"},
		{"missing owner ID", "owner", map[string]any{"login": "acme"}},
		{"numeric owner ID", "owner", map[string]any{"node_id": 42, "login": "acme"}},
		{"blank owner ID", "owner", map[string]any{"node_id": " \t", "login": "acme"}},
		{"missing login", "owner", map[string]any{"node_id": "O_owner"}},
		{"blank login", "owner", map[string]any{"node_id": "O_owner", "login": " "}},
		{"missing visibility", "visibility", nil},
		{"invalid visibility", "visibility", 42},
		{"unknown visibility", "visibility", "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			relayTestServer(t, func(request map[string]any) any {
				repository := repoMetadataFixture("public")
				repository[test.field] = test.value
				return repository
			})
			for _, selected := range []bool{true, false} {
				fields := "nameWithOwner"
				if selected {
					fields += "," + test.field
				}
				var out bytes.Buffer
				result := handleGHRepo(t.Context(), []string{"view", "acme/repo", "--json", fields}, &out)
				if selected {
					if result.action != ghFail || !isLocalFallback(result.err) || out.Len() != 0 {
						t.Fatalf("expected typed fallback without partial output: action=%v err=%v out=%q", result.action, result.err, out.String())
					}
				} else if result.action != ghComplete || result.err != nil || out.String() != "{\"nameWithOwner\":\"acme/repo\"}\n" {
					t.Fatalf("unselected field affected output: action=%v err=%v out=%q", result.action, result.err, out.String())
				}
			}
		})
	}
}
