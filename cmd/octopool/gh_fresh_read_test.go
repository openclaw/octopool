package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
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

func TestCLIEndToEndCacheFreshnessNotices(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	for _, test := range []struct {
		name, cache, fresh, quiet string
		wantNotice                bool
	}{
		{"ordinary stale", "stale", "", "", true},
		{"fresh stale from older relay", "stale", "1", "", true},
		{"quiet stale", "stale", "1", "1", false},
		{"ordinary hit", "hit", "", "", true},
		{"fresh revalidated hit", "hit", "1", "", false},
		{"fresh miss", "miss", "1", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				if request == nil {
					return
				}
				headers, _ := request["headers"].(map[string]any)
				if test.fresh == "1" && headers["cache-control"] != "max-age=0" {
					t.Errorf("headers = %v, want max-age=0", headers)
				}
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(relayEnvelope{
					Status: 200, Body: json.RawMessage(`{"head":{"sha":"` + head + `"}}`), BodyEncoding: "json",
					Relay: relayMeta{Cache: test.cache, RouteKind: "pr_view"},
				}); err != nil {
					t.Error(err)
				}
			})
			result := runCLI(t, bin, server.URL, map[string]string{
				"OCTOPOOL_FRESH": test.fresh, "OCTOPOOL_QUIET_CACHE": test.quiet,
				"OCTOPOOL_NO_FALLBACK": "1",
			}, "gh", "api", "repos/openclaw/freshness-fixture/pulls/73")
			if result.err != nil {
				t.Fatalf("err=%v stderr=%q", result.err, result.stderr)
			}
			var body struct {
				Head struct {
					SHA string `json:"sha"`
				} `json:"head"`
			}
			if err := json.Unmarshal([]byte(result.stdout), &body); err != nil || body.Head.SHA != head {
				t.Fatalf("stdout=%q err=%v", result.stdout, err)
			}
			if test.wantNotice != strings.Contains(result.stderr, "pr_view served from shared cache") {
				t.Errorf("notice=%q, want notice=%v", result.stderr, test.wantNotice)
			}
			if test.cache == "stale" && test.wantNotice {
				if !strings.Contains(result.stderr, "not a live read") || strings.Contains(result.stderr, "set OCTOPOOL_FRESH=1") {
					t.Errorf("stale notice must warn against live decisions without repeating FRESH advice: %q", result.stderr)
				}
			}
		})
	}
}
