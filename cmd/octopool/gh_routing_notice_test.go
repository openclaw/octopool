package main

import (
	"bytes"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestNativeReadRoutingNotice(t *testing.T) {
	for _, test := range []struct {
		name   string
		args   []string
		notice string
	}{
		{"pr_gate_bundle", []string{"pr", "view", "7", "-R", "acme/repo", "--json", "title,mergeStateStatus"}, "JSON fields require native gh for the entire export"},
		{"repo_license", []string{"repo", "view", "acme/repo", "--json=licenseInfo"}, "JSON fields require native gh for the entire export"},
		{"release_assets", []string{"release", "view", "v1.0", "-R", "acme/repo", "--json=assets"}, "JSON fields require native gh for the entire export"},
		{"issue_comments", []string{"issue", "view", "7", "-R", "acme/repo", "--json=number,comments"}, "JSON fields require native gh for the entire export"},
		{"include", []string{"api", "repos/acme/repo", "--include"}, "--include uses native gh and caller credentials"},
		{"include_short", []string{"api", "repos/acme/repo", "-i"}, "--include uses native gh and caller credentials"},
		{"include_bundle", []string{"api", "repos/acme/repo", "-iHAccept: application/vnd.github+json"}, "--include uses native gh and caller credentials"},
		{"include_mutation", []string{"api", "repos/acme/repo", "-XPOST", "--include"}, ""},
		{"include_body", []string{"api", "repos/acme/repo", "-iFname=synthetic"}, ""},
		{"include_final_false", []string{"api", "repos/acme/repo", "-i", "--include=false"}, ""},
		{"include_false", []string{"api", "repos/acme/repo", "--include=false"}, ""},
		{"include_value", []string{"api", "repos/acme/repo", "--template", "--include"}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := 0
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				data++
				t.Error("native read unexpectedly reached relay data")
				w.WriteHeader(400)
			})
			capture := captureRewriteGH(t)
			t.Setenv("GH_HOST", "")
			t.Setenv("GH_REPO", "")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			var stdout, stderr bytes.Buffer
			if err := runGH(t.Context(), test.args, &stdout, &stderr); err != nil {
				t.Fatal(err)
			}
			got := readRewriteCapture(t, capture)
			if !reflect.DeepEqual(got.Args, test.args) || stdout.String() != "child stdout\n" || data != 0 {
				t.Fatalf("routing or native output changed: %+v stdout=%q data=%d", got, stdout.String(), data)
			}
			if test.notice != "" && !strings.Contains(stderr.String(), test.notice) {
				t.Fatalf("missing route explanation: %q", stderr.String())
			}
			if test.notice == "" && strings.Contains(stderr.String(), "--include uses") {
				t.Fatalf("option value/false became a route explanation: %q", stderr.String())
			}
		})
	}
}
