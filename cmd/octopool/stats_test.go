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
		Operator: statsOperator{GitHubLogin: "steipete"},
		PoolUsage: statsAggregate{
			Requests:     12,
			Errors:       1,
			CacheHits:    5,
			CacheMisses:  3,
			CacheBypass:  4,
			CacheHitRate: &rate,
		},
		CallerUsage: statsAggregate{
			Requests:     8,
			CacheHitRate: &rate,
		},
		Cache: statsCache{
			TotalEntries:   9,
			FreshEntries:   7,
			ExpiredEntries: 2,
			BodyBytes:      1536,
		},
		Routes: []statsRoute{{
			RouteKind: "pr_view",
			statsAggregate: statsAggregate{
				Requests:     6,
				Errors:       0,
				CacheHitRate: &rate,
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
		"cache: 62.5% hit (5 hits, 3 misses, 4 bypass)",
		"entries: 7 fresh / 9 total, 2 expired, 1.5 KiB",
		"  pr_view: 6 req, 62.5% hit, 0 errors",
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
