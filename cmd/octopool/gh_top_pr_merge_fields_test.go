package main

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRunGHPRViewMergeStateStatusDelegates(t *testing.T) {
	for _, fields := range []string{
		"mergeStateStatus",
		"headRefOid,state,mergeable,mergeStateStatus",
		"mergeStateStatus,autoMergeRequest,maintainerCanModify,mergedBy",
	} {
		t.Run(fields, func(t *testing.T) {
			// Unsupported field sets delegate even when typed local fallback is disabled.
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
			calls := 0
			relayTestServer(t, func(request map[string]any) any {
				calls++
				t.Error("viewer-dependent merge state must not request relay data")
				return map[string]any{"mergeable_state": "unstable"}
			})
			args := []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", fields}
			var out bytes.Buffer
			result := handleGHPR(t.Context(), args[1:], &out)
			if result.err != nil || result.action != ghDelegate || out.Len() != 0 || calls != 0 {
				t.Fatalf("action=%v err=%v calls=%d output=%q", result.action, result.err, calls, out.String())
			}
			err := runGH(t.Context(), args, &out, io.Discard)
			want := "real-gh:" + strings.Join(args, " ") + "\n"
			if err != nil || calls != 0 || out.String() != want {
				t.Fatalf("err=%v calls=%d output=%q, want %q", err, calls, out.String(), want)
			}
		})
	}
}

// Native gh v2.101.0 exports a nil *AutoMergeRequest as JSON null.
func TestRunGHPRViewMergeFieldsProjection(t *testing.T) {
	for _, test := range []struct{ fields, jq, want string }{
		{"autoMergeRequest", "", "{\"autoMergeRequest\":null}\n"},
		{"headRefOid,state,mergeable,autoMergeRequest", "", `{"autoMergeRequest":null,"headRefOid":"` + prMergeableTestHead + `","mergeable":"MERGEABLE","state":"OPEN"}` + "\n"},
		{"autoMergeRequest,state,autoMergeRequest", "", "{\"autoMergeRequest\":null,\"state\":\"OPEN\"}\n"},
		{"state,autoMergeRequest", `(.state == "OPEN") and has("autoMergeRequest") and (.autoMergeRequest == null)`, "true\n"},
	} {
		t.Run(test.fields+"/"+test.jq, func(t *testing.T) {
			if test.jq != "" && !jqAvailable() {
				t.Skip("jq is not installed")
			}
			t.Setenv("OCTOPOOL_FRESH", "")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			calls := 0
			rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls++
				checkPRMergeableRequest(t, decodeCLIRequest(t, w, r))
				pr := prMergeableFixture(true, true)
				pr["auto_merge"] = nil
				writeCLIEnvelope(t, w, pr)
			})
			args := []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", test.fields}
			if test.jq != "" {
				args = append(args, "--jq", test.jq)
			}
			var out bytes.Buffer
			err := runGH(t.Context(), args, &out, io.Discard)
			if err != nil || calls != 1 || out.String() != test.want {
				t.Fatalf("err=%v calls=%d output=%q, want %q", err, calls, out.String(), test.want)
			}
		})
	}
}

func TestRunGHPRViewMergeFieldsFallback(t *testing.T) {
	for _, test := range []struct {
		name, fields string
		pr           map[string]any
	}{
		{"missing auto merge", "autoMergeRequest", map[string]any{}},
		{"enabled auto merge", "autoMergeRequest", map[string]any{"auto_merge": map[string]any{"merge_method": "squash"}}},
		{"empty auto merge object", "autoMergeRequest", map[string]any{"auto_merge": map[string]any{}}},
		{"boolean auto merge", "autoMergeRequest", map[string]any{"auto_merge": false}},
		{"string auto merge", "autoMergeRequest", map[string]any{"auto_merge": "null"}},
		{"missing auto merge in bundle", "state,autoMergeRequest", map[string]any{"state": "open"}},
		{"cached page projection", "headRefOid,state,mergeable,autoMergeRequest", map[string]any{"state": "OPEN", "merged": false, "head": map[string]any{"sha": prMergeableTestHead}}},
		{"GraphQL keys are not REST evidence", "autoMergeRequest", map[string]any{"autoMergeRequest": nil}},
	} {
		for _, noFallback := range []string{"", "1"} {
			t.Run(test.name+"/no-fallback="+noFallback, func(t *testing.T) {
				t.Setenv("OCTOPOOL_FRESH", "")
				t.Setenv("OCTOPOOL_NO_FALLBACK", noFallback)
				t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))
				calls := 0
				relayTestServer(t, func(request map[string]any) any {
					calls++
					checkPRMergeableRequest(t, request)
					return relayTestResponse{Body: test.pr, Relay: relayMeta{Cache: "hit", RouteKind: "pr_view"}}
				})
				args := []string{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", test.fields}
				var out bytes.Buffer
				err := runGH(t.Context(), args, &out, io.Discard)
				want := ""
				if noFallback == "1" {
					if !isLocalFallback(err) {
						t.Fatalf("expected typed local fallback, got %v", err)
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					want = "real-gh:" + strings.Join(args, " ") + "\n"
				}
				if calls != 1 || out.String() != want {
					t.Fatalf("calls=%d output=%q, want one REST read and %q", calls, out.String(), want)
				}
			})
		}
	}
}

func TestRunGHPRViewUnselectedMergeFields(t *testing.T) {
	relayTestServer(t, func(request map[string]any) any {
		checkPRMergeableRequest(t, request)
		return map[string]any{"mergeable": false, "mergeable_state": "future_state", "auto_merge": map[string]any{}}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"view", "7", "--repo", "openclaw/octopool", "--json", "mergeable",
	}, &out)
	if result.err != nil || result.action != ghComplete || out.String() != "{\"mergeable\":\"CONFLICTING\"}\n" {
		t.Fatalf("action=%v err=%v output=%q", result.action, result.err, out.String())
	}
}

func TestRunGHSearchPRMergeFieldsDelegate(t *testing.T) {
	for _, fields := range []string{"mergeStateStatus", "autoMergeRequest", "state,mergeStateStatus,autoMergeRequest"} {
		t.Run(fields, func(t *testing.T) {
			emptyRewriteTestServer(t)
			var out bytes.Buffer
			result := handleGHSearch(t.Context(), []string{"prs", "--repo", "openclaw/octopool", "--json", fields}, &out)
			if result.err != nil || result.action != ghDelegate || out.Len() != 0 {
				t.Fatalf("action=%v err=%v output=%q", result.action, result.err, out.String())
			}
		})
	}
}
