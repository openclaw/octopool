package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestRenderStatsWorkerMetricVersions(t *testing.T) {
	for _, tc := range []struct {
		name             string
		body             string
		cached, uncached int
	}{
		{"historical Worker", `{"saved_github_requests":7,"backend_requests":3}`, 7, 3},
		{"canonical Worker", `{"cache_served_responses":7,"uncached_outcomes":3}`, 7, 3},
		{"canonical zero", `{"cache_served_responses":0,"uncached_outcomes":0,"saved_github_requests":7,"backend_requests":3}`, 0, 0},
		{"mixed Worker", `{"cache_served_responses":0,"saved_github_requests":7,"backend_requests":3}`, 0, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var aggregate statsAggregate
			if err := json.Unmarshal([]byte(tc.body), &aggregate); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err := renderStats(&out, statsResponse{
				PoolUsage:   aggregate,
				ClientUsage: aggregate,
				Clients:     []statsClient{{ClientName: "test-client", statsAggregate: aggregate}},
			}); err != nil {
				t.Fatal(err)
			}
			want := fmt.Sprintf("%d cache-served, %d uncached", tc.cached, tc.uncached)
			if strings.Count(out.String(), want) != 3 {
				t.Fatalf("expected pool, current-client and client-list metrics %q in:\n%s", want, out.String())
			}
		})
	}
}

func TestRenderStats(t *testing.T) {
	rate := 0.625
	stats := statsResponse{
		Pool:     "maintainers",
		Window:   statsWindow{Label: "24h", Seconds: 86400},
		Operator: statsOperator{GitHubLogin: "steipete", ClientName: "steipete-mbp"},
		PoolUsage: statsAggregate{
			Requests:         12,
			Errors:           3,
			ServiceErrors:    1,
			Fallbacks:        2,
			CacheHits:        5,
			CacheStale:       2,
			CacheMisses:      3,
			CacheBypass:      4,
			CacheHitRate:     &rate,
			EligibleRequests: 8,
			EligibleHitRate:  &rate,
			Coalesced:        2,
			SavedGitHubCalls: 7,
			BackendRequests:  7,
		},
		CallerUsage: statsAggregate{
			Requests:     8,
			CacheHitRate: &rate,
		},
		ClientUsage: statsAggregate{
			Requests:         5,
			SavedGitHubCalls: 4,
			BackendRequests:  1,
		},
		Clients: []statsClient{{
			ClientName: "steipete-mbp",
			statsAggregate: statsAggregate{
				Requests:         5,
				SavedGitHubCalls: 4,
				BackendRequests:  1,
			},
		}},
		Cache: statsCache{
			TotalEntries:   9,
			FreshEntries:   7,
			ExpiredEntries: 2,
			BodyBytes:      1536,
		},
		Routes: []statsRoute{{
			RouteKind: "pr_view",
			statsAggregate: statsAggregate{
				Requests:        6,
				ServiceErrors:   0,
				Fallbacks:       1,
				CacheStale:      1,
				CacheMisses:     1,
				CacheBypass:     2,
				EligibleHitRate: &rate,
			},
		}},
		Backends: []statsBackend{{
			Backend:     "github_web",
			RouteKind:   "pr_view",
			Requests:    3,
			CacheMisses: 3,
		}},
		FallbackReasons: []statsFallbackReason{{
			Reason:    "identity_pool_depleted",
			RouteKind: "pr_view",
			Requests:  1,
		}},
	}
	var out bytes.Buffer
	if err := renderStats(&out, stats); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		"pool: maintainers",
		"operator: steipete",
		"client: steipete-mbp",
		"cache: 62.5% body reuse (5 hits, 2 stale, 3 misses, 4 bypass, 0 unknown)",
		"eligible: 8/12 requests, 62.5% body reuse",
		"coalesced: 2 duplicate misses",
		"outcomes: 7 cache-served, 7 uncached",
		"this client: 5 requests, 4 cache-served, 1 uncached",
		"entries: 7 fresh / 9 total, 2 expired, 1.5 KiB",
		"  pr_view: 6 req, 62.5% eligible body reuse, 1 stale, 1 miss, 2 bypass, 0 errors, 1 fallback",
		"backend-attributed relay outcomes:\n  github_web / pr_view: 3 req, 3 miss, 0 bypass, 0 revalidated",
		"fallback reasons:\n  identity_pool_depleted / pr_view: 1 req",
		"clients:\n  steipete-mbp: 5 req, 4 cache-served, 1 uncached, 0 fallback",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in:\n%s", want, got)
		}
	}
}

func TestRenderStatsNoRoutes(t *testing.T) {
	var out bytes.Buffer
	if err := renderStats(&out, statsResponse{Pool: "maintainers"}); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.Contains(got, "cache: n/a body reuse") {
		t.Fatalf("missing n/a cache rate:\n%s", got)
	}
	if !strings.Contains(got, "top routes:\n  none") {
		t.Fatalf("missing empty routes:\n%s", got)
	}
}

func TestRenderStatsClientFilter(t *testing.T) {
	var out bytes.Buffer
	stats := statsResponse{
		Pool:         "maintainers",
		Operator:     statsOperator{ClientName: "steipete-mbp"},
		ClientFilter: "ci-runner",
		ClientUsage:  statsAggregate{Requests: 4, SavedGitHubCalls: 1, BackendRequests: 3},
	}
	if err := renderStats(&out, stats); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.Contains(got, "client: steipete-mbp\nclient filter: ci-runner\n") {
		t.Fatalf("missing client filter after calling client:\n%s", got)
	}
	if !strings.Contains(got, "ci-runner: 4 requests, 1 cache-served, 3 uncached") {
		t.Fatalf("missing filtered usage label:\n%s", got)
	}
	if strings.Contains(got, "this client:") {
		t.Fatalf("unexpected unfiltered usage label:\n%s", got)
	}
}
