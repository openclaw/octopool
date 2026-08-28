package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestAdminStringRewriteRevisionUpdate(t *testing.T) {
	for _, test := range []struct {
		name     string
		conflict bool
		revision string
		stdin    bool
	}{
		{name: "file"}, {name: "stdin", stdin: true}, {name: "explicit revision", revision: "7"}, {name: "operator conflict", revision: "6"}, {name: "concurrent conflict", conflict: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			methods := []string{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/admin/string-rewrites" || r.Header.Get("Authorization") != "Bearer admin-test" {
					t.Error("incorrect admin request")
					w.WriteHeader(400)
					return
				}
				methods = append(methods, r.Method)
				switch r.Method {
				case "GET":
					_, _ = io.WriteString(w, `{"schema_version":1,"revision":7,"updated_at":"2026-08-28T00:00:00Z","rules":[]}`)
				case "PUT":
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
					}
					if payload["schema_version"] != float64(1) || payload["expected_revision"] != float64(7) || len(payload) != 3 {
						t.Error("PUT is not conditional")
					}
					rules, ok := payload["rules"].([]any)
					if !ok || len(rules) != 1 {
						t.Error("missing imported rules")
					}
					if test.conflict {
						w.WriteHeader(409)
						_, _ = io.WriteString(w, `internal-model`)
						return
					}
					_, _ = io.WriteString(w, `{"schema_version":1,"revision":8,"updated_at":"2026-08-28T00:00:00Z","rule_count":1}`)
				default:
					t.Error("unexpected method")
					w.WriteHeader(400)
				}
			}))
			defer server.Close()
			file := filepath.Join(t.TempDir(), "policy.json")
			if err := os.WriteFile(file, []byte(`{"schema_version":1,"rules":[{"pattern":"internal-model","replacement":"public"}]}`), 0600); err != nil {
				t.Fatal(err)
			}
			if test.stdin {
				input, err := os.Open(file)
				if err != nil {
					t.Fatal(err)
				}
				defer input.Close()
				original := os.Stdin
				os.Stdin = input
				defer func() { os.Stdin = original }()
				file = "-"
			}
			t.Setenv("OCTOPOOL_ADMIN_TOKEN", "admin-test")
			args := []string{"string-rewrites", "set", "--url", server.URL, "--file", file}
			if test.revision != "" {
				args = append(args, "--if-revision", test.revision)
			}
			var out bytes.Buffer
			err := runAdmin(t.Context(), args, &out)
			if test.conflict || test.revision == "6" {
				if err != errRewriteConflict || out.Len() != 0 {
					t.Fatalf("conflict err=%v output=%q", err, out.String())
				}
			} else {
				if err != nil || out.String() != "revision: 8\nrule_count: 1\n" {
					t.Fatalf("update err=%v output=%q", err, out.String())
				}
			}
			want := []string{"GET", "PUT"}
			if test.revision == "6" {
				want = []string{"GET"}
			}
			if !reflect.DeepEqual(methods, want) {
				t.Fatalf("methods=%v", methods)
			}
		})
	}
}
func TestAdminStringRewriteStatusDoesNotExposeRules(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/admin/string-rewrites" || r.Header.Get("Authorization") != "Bearer admin-test" {
			t.Error("invalid admin request")
		}
		_, _ = io.WriteString(w, rewriteActiveTestPolicy)
	}))
	defer server.Close()
	t.Setenv("OCTOPOOL_ADMIN_TOKEN", "admin-test")
	var out bytes.Buffer
	if err := runAdmin(t.Context(), []string{"string-rewrites", "status", "--url", server.URL}, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "revision: 1\nrule_count: 1\n" {
		t.Fatalf("output=%q", out.String())
	}
}
