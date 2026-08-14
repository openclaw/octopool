package main

import (
	"bytes"
	"testing"
)

// A merge-gate field must never be answered from the shared cache: right after
// a push or a merge the cached copy still reports the previous head SHA or an
// open PR, and callers read that as current fact.
func TestPRViewGateFieldsRequestLiveRead(t *testing.T) {
	for _, field := range []string{"headRefOid", "state", "merged", "mergeable"} {
		t.Run(field, func(t *testing.T) {
			var seen map[string]any
			relayTestServer(t, func(body map[string]any) any {
				headers, _ := body["headers"].(map[string]any)
				seen = headers
				return map[string]any{
					"number":   7,
					"state":    "open",
					"merged":   false,
					"html_url": "https://github.com/openclaw/octopool/pull/7",
					"head":     map[string]any{"sha": "0123456789abcdef0123456789abcdef01234567"},
				}
			})
			var out bytes.Buffer
			result := handleGHPR(t.Context(), []string{
				"view", "7", "-R", "openclaw/octopool", "--json", "number," + field,
			}, &out)
			if result.err != nil || result.action != ghComplete {
				t.Fatalf("action=%v err=%v", result.action, result.err)
			}
			if seen["cache-control"] != "max-age=0" {
				t.Fatalf("%s read headers = %#v, want cache-control max-age=0", field, seen)
			}
		})
	}
}

// Fields that describe the PR itself rather than its current gate state stay on
// the shared cache; that is the whole point of the relay.
func TestPRViewStableFieldsStayCached(t *testing.T) {
	var seen map[string]any
	relayTestServer(t, func(body map[string]any) any {
		seen, _ = body["headers"].(map[string]any)
		return map[string]any{
			"number":   7,
			"title":    "cached read",
			"html_url": "https://github.com/openclaw/octopool/pull/7",
		}
	})
	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"view", "7", "-R", "openclaw/octopool", "--json", "number,title",
	}, &out)
	if result.err != nil || result.action != ghComplete {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
	if _, forced := seen["cache-control"]; forced {
		t.Fatalf("stable-field read headers = %#v, want no cache-control", seen)
	}
}

// OCTOPOOL_FRESH is the escape hatch for raw `gh api`, where the CLI cannot see
// which fields the caller is about to act on.
func TestGHAPIFreshEnvForcesLiveRead(t *testing.T) {
	t.Setenv("OCTOPOOL_FRESH", "1")
	request, delegate, err := parseGHAPIArgs([]string{"repos/openclaw/octopool/pulls/7"})
	if err != nil || delegate {
		t.Fatalf("delegate=%v err=%v", delegate, err)
	}
	if request.headers["cache-control"] != "max-age=0" {
		t.Fatalf("headers = %#v, want cache-control max-age=0", request.headers)
	}
}

// An explicit cache-control from the caller must reach the relay instead of
// forcing a local `gh` fallback that spends the caller's own quota.
func TestGHAPICacheControlHeaderRelays(t *testing.T) {
	request, delegate, err := parseGHAPIArgs([]string{
		"repos/openclaw/octopool/pulls/7", "-H", "cache-control: max-age=0",
	})
	if err != nil || delegate {
		t.Fatalf("delegate=%v err=%v", delegate, err)
	}
	if request.headers["cache-control"] != "max-age=0" {
		t.Fatalf("headers = %#v, want relayed cache-control", request.headers)
	}
}

func TestVolatileRouteKindCoversDecisionRoutes(t *testing.T) {
	for _, kind := range []string{"pr_view", "run_view", "checks", "status"} {
		if !volatileRouteKind(kind) {
			t.Fatalf("%s should be treated as volatile", kind)
		}
	}
	for _, kind := range []string{"repo_view", "user_view", "license_view"} {
		if volatileRouteKind(kind) {
			t.Fatalf("%s should not be treated as volatile", kind)
		}
	}
}
