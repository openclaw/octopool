package main

import (
	"bytes"
	"strings"
	"testing"
)

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
		"cache: 62.5% hit (5 hits, 2 stale, 3 misses, 4 bypass, 0 unknown)",
		"eligible: 8/12 requests, 62.5% hit",
		"coalesced: 2 duplicate misses",
		"github: 7 saved, 7 backend",
		"this client: 5 requests, 4 saved, 1 backend",
		"entries: 7 fresh / 9 total, 2 expired, 1.5 KiB",
		"  pr_view: 6 req, 62.5% eligible hit, 1 stale, 1 miss, 2 bypass, 0 errors, 1 fallback",
		"clients:\n  steipete-mbp: 5 req, 4 saved, 1 backend, 0 fallback",
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
	if !strings.Contains(got, "cache: n/a hit") {
		t.Fatalf("missing n/a cache rate:\n%s", got)
	}
	if !strings.Contains(got, "top routes:\n  none") {
		t.Fatalf("missing empty routes:\n%s", got)
	}
}
