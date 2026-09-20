package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
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

func TestGHAPIFreshUserReadSkipsSavedLogin(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq is required")
	}
	isolateTestConfig(t)
	for _, name := range []string{"OCTOPOOL_TOKEN", "OCTOPOOL_URL", "OCTOPOOL_POOL", "OCTOPOOL_STRING_REWRITE_FILE"} {
		t.Setenv(name, "")
	}
	t.Setenv("OCTOPOOL_FRESH", "1")
	var health, data atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveEmptyRewritePolicy(t, w, r, "test-token", "maintainers") {
			return
		}
		if r.URL.Path == "/v1/pools/maintainers/health" {
			health.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		data.Add(1)
		request := decodeCLIRequest(t, w, r)
		headers, _ := request["headers"].(map[string]any)
		if request["path"] != "/user" || headers["cache-control"] != "max-age=0" {
			t.Errorf("fresh user request=%v", request)
		}
		writeCLIEnvelope(t, w, map[string]any{"login": "current-login"})
	}))
	t.Cleanup(server.Close)
	if err := saveAuth(authFile{URL: server.URL, Pool: "maintainers", Token: "test-token", Login: "saved-login"}); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"gh", "api", "user", "--jq", ".login"}, &stdout, &stderr)
	if err != nil || stdout.String() != "current-login\n" || stderr.Len() != 0 || health.Load() != 0 || data.Load() != 1 {
		t.Fatalf("err=%v stdout=%q stderr=%q health=%d data=%d", err, stdout.String(), stderr.String(), health.Load(), data.Load())
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
	for _, kind := range []string{
		"pr_view", "pr_list", "issue_view", "issue_list", "run_view", "run_list", "workflow_run_list",
		"commit_check_runs", "commit_check_runs_ref", "commit_check_suites", "commit_check_suites_ref",
		"commit_status", "commit_status_ref", "commit_statuses", "commit_statuses_ref", "ref_statuses",
		"run_jobs", "job_view", "commit_view", "commit_view_ref", "git_ref", "git_matching_refs",
	} {
		if !volatileRouteKind(kind) {
			t.Fatalf("%s should be treated as volatile", kind)
		}
	}
	for _, kind := range []string{"repo_view", "user_view", "repo_license", "checks", "status", "ref_view"} {
		if volatileRouteKind(kind) {
			t.Fatalf("%s should not be treated as volatile", kind)
		}
	}
}

func TestCacheExpirySuffix(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		expires := time.Now().Add(2 * time.Minute)
		for _, test := range []struct{ name, timestamp, want string }{
			{"worker UTC timestamp", expires.UTC().Format("2006-01-02 15:04:05"), ", refreshes in 2m0s"},
			{"RFC3339 UTC", expires.UTC().Format(time.RFC3339), ", refreshes in 2m0s"},
			{"RFC3339 offset", expires.In(time.FixedZone("offset", 3600)).Format(time.RFC3339), ", refreshes in 2m0s"},
			{"surrounding whitespace", " " + expires.UTC().Format("2006-01-02 15:04:05") + "\n", ", refreshes in 2m0s"},
			{"expired", time.Now().Add(-time.Minute).UTC().Format("2006-01-02 15:04:05"), ""},
			{"missing", "", ""},
			{"invalid", "not a timestamp", ""},
		} {
			if got := cacheExpirySuffix(test.timestamp); got != test.want {
				t.Errorf("%s: cacheExpirySuffix(%q) = %q, want %q", test.name, test.timestamp, got, test.want)
			}
		}
	})
}

func TestCLIEndToEndCacheFreshnessNotices(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	for _, test := range []struct {
		name, cache, fresh, quiet, cacheControl string
		wantNotice                              bool
	}{
		{"ordinary stale", "stale", "", "", "", true},
		{"fresh stale from older relay", "stale", "1", "", "", true},
		{"quiet stale", "stale", "1", "1", "", false},
		{"ordinary hit", "hit", "", "", "", true},
		{"fresh hit without revalidation proof", "hit", "1", "", "", true},
		{"explicit cache age overrides fresh", "hit", "1", "", "max-age=60", true},
		{"quiet hit", "hit", "1", "1", "max-age=60", false},
		{"fresh miss", "miss", "1", "", "", false},
		{"ordinary miss", "miss", "", "", "", false},
		{"cache bypass", "bypass", "", "", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				if request == nil {
					return
				}
				headers, _ := request["headers"].(map[string]any)
				wantCacheControl := test.cacheControl
				if test.fresh == "1" && wantCacheControl == "" {
					wantCacheControl = "max-age=0"
				}
				if wantCacheControl != "" && headers["cache-control"] != wantCacheControl {
					t.Errorf("headers = %v, want %s", headers, wantCacheControl)
				}
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(relayEnvelope{
					Status: 200, Body: json.RawMessage(`{"head":{"sha":"` + head + `"}}`), BodyEncoding: "json",
					Relay: relayMeta{Cache: test.cache, RouteKind: "pr_view"},
				}); err != nil {
					t.Error(err)
				}
			})
			args := []string{"gh", "api", "repos/openclaw/freshness-fixture/pulls/73"}
			if test.cacheControl != "" {
				args = append(args, "-H", "Cache-Control: "+test.cacheControl)
			}
			result := runCLI(t, bin, server.URL, map[string]string{
				"OCTOPOOL_FRESH": test.fresh, "OCTOPOOL_QUIET_CACHE": test.quiet,
				"OCTOPOOL_NO_FALLBACK": "1",
			}, args...)
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
			if test.cache == "hit" && test.fresh == "1" && test.wantNotice {
				if !strings.Contains(result.stderr, "freshness is not confirmed") || strings.Contains(result.stderr, "set OCTOPOOL_FRESH=1") {
					t.Errorf("fresh cache hit must not assume revalidation or repeat FRESH advice: %q", result.stderr)
				}
			}
		})
	}
}
