package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
)

type statsResponse struct {
	Pool            string                `json:"pool"`
	Window          statsWindow           `json:"window"`
	Operator        statsOperator         `json:"operator"`
	ClientFilter    string                `json:"client_filter"`
	PoolUsage       statsAggregate        `json:"pool_usage"`
	CallerUsage     statsAggregate        `json:"caller_usage"`
	ClientUsage     statsAggregate        `json:"client_usage"`
	Routes          []statsRoute          `json:"routes"`
	Backends        []statsBackend        `json:"backends"`
	FallbackReasons []statsFallbackReason `json:"fallback_reasons"`
	Clients         []statsClient         `json:"clients"`
	Cache           statsCache            `json:"cache"`
}

type statsWindow struct {
	Label   string `json:"label"`
	Seconds int    `json:"seconds"`
}

type statsOperator struct {
	GitHubLogin string `json:"github_login"`
	ClientName  string `json:"client_name"`
}

type statsAggregate struct {
	Requests             int      `json:"requests"`
	Errors               int      `json:"errors"`
	ServiceErrors        int      `json:"service_errors"`
	Fallbacks            int      `json:"fallbacks"`
	AvgDurationMS        *float64 `json:"avg_duration_ms"`
	CacheHits            int      `json:"cache_hits"`
	CacheStale           int      `json:"cache_stale"`
	CacheMisses          int      `json:"cache_misses"`
	CacheBypass          int      `json:"cache_bypass"`
	CacheUnknown         int      `json:"cache_unknown"`
	CacheableRequests    int      `json:"cacheable_requests"`
	EligibleRequests     int      `json:"eligible_cache_requests"`
	CacheHitRate         *float64 `json:"cache_hit_rate"`
	CacheableHitRate     *float64 `json:"cacheable_hit_rate"`
	EligibleHitRate      *float64 `json:"eligible_cache_hit_rate"`
	BypassRate           *float64 `json:"bypass_rate"`
	Coalesced            int      `json:"coalesced"`
	CacheServedResponses *int     `json:"cache_served_responses"`
	UncachedOutcomes     *int     `json:"uncached_outcomes"`
	// Deprecated wire aliases remain readable until older Workers are upgraded.
	SavedGitHubCalls int `json:"saved_github_requests"`
	BackendRequests  int `json:"backend_requests"`
}

func (stats statsAggregate) cacheOutcomes() (int, int) {
	cacheServed, uncached := stats.SavedGitHubCalls, stats.BackendRequests
	// Presence matters: a canonical zero must override a nonzero historical alias.
	if stats.CacheServedResponses != nil {
		cacheServed = *stats.CacheServedResponses
	}
	if stats.UncachedOutcomes != nil {
		uncached = *stats.UncachedOutcomes
	}
	return cacheServed, uncached
}

type statsRoute struct {
	RouteKind    string `json:"route_kind"`
	LatestSeenAt string `json:"latest_seen_at"`
	statsAggregate
}

type statsClient struct {
	ClientName   string `json:"client_name"`
	LatestSeenAt string `json:"latest_seen_at"`
	statsAggregate
}

type statsBackend struct {
	Backend     string `json:"backend"`
	RouteKind   string `json:"route_kind"`
	Requests    int    `json:"requests"`
	CacheMisses int    `json:"cache_misses"`
	CacheBypass int    `json:"cache_bypass"`
	Revalidated int    `json:"revalidated"`
}

type statsFallbackReason struct {
	Reason    string `json:"reason"`
	RouteKind string `json:"route_kind"`
	Requests  int    `json:"requests"`
}

type statsCache struct {
	TotalEntries   int   `json:"total_entries"`
	FreshEntries   int   `json:"fresh_entries"`
	ExpiredEntries int   `json:"expired_entries"`
	BodyBytes      int64 `json:"body_bytes"`
}

func runStats(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("stats", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	requestFlags := newCallerRequestFlags(fs)
	since := fs.String("since", "24h", "stats window, e.g. 30m, 24h, 7d")
	client := fs.String("client", "", "client name to filter client usage and routes")
	jsonOutput := fs.Bool("json", false, "print raw JSON")
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool stats [flags]"); err != nil {
		return err
	} else if handled {
		return nil
	}
	auth, err := requestFlags.applyAuth(fs)
	if err != nil {
		return err
	}
	token, err := requestFlags.authorize(auth)
	if err != nil {
		return err
	}
	query := url.Values{}
	if strings.TrimSpace(*since) != "" {
		query.Set("since", strings.TrimSpace(*since))
	}
	if strings.TrimSpace(*client) != "" {
		query.Set("client", strings.TrimSpace(*client))
	}
	endpoint := apiURL(*requestFlags.baseURL, "/v1/pools/"+urlPath(*requestFlags.pool)+"/stats")
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	resp, err := getJSONRaw(ctx, endpoint, token)
	if err != nil {
		return err
	}
	if *jsonOutput {
		return writeJSONResponse(stdout, resp)
	}
	defer resp.Body.Close()
	body, err := readJSONResponseBody(resp.Body, 8<<20)
	if err != nil {
		return err
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var stats statsResponse
	if err := json.Unmarshal(body, &stats); err != nil {
		return err
	}
	return renderStats(stdout, stats)
}

func renderStats(w io.Writer, stats statsResponse) error {
	poolCached, poolUncached := stats.PoolUsage.cacheOutcomes()
	clientCached, clientUncached := stats.ClientUsage.cacheOutcomes()
	lines := []string{
		"pool: " + stats.Pool,
		"window: " + firstNonEmpty(stats.Window.Label, "24h"),
		fmt.Sprintf("operator: %s", firstNonEmpty(stats.Operator.GitHubLogin, "unknown")),
		fmt.Sprintf("client: %s", firstNonEmpty(stats.Operator.ClientName, "legacy")),
	}
	clientUsageLabel := "this client"
	if stats.ClientFilter != "" {
		lines = append(lines, "client filter: "+stats.ClientFilter)
		clientUsageLabel = stats.ClientFilter
	}
	lines = append(lines,
		fmt.Sprintf(
			"recorded relay requests: %d (%d service errors, %d local fallbacks)",
			stats.PoolUsage.Requests,
			stats.PoolUsage.ServiceErrors,
			stats.PoolUsage.Fallbacks,
		),
		fmt.Sprintf(
			"cache: %s body reuse (%d hits, %d stale, %d misses, %d bypass, %d unknown)",
			percent(stats.PoolUsage.CacheHitRate),
			stats.PoolUsage.CacheHits,
			stats.PoolUsage.CacheStale,
			stats.PoolUsage.CacheMisses,
			stats.PoolUsage.CacheBypass,
			stats.PoolUsage.CacheUnknown,
		),
		fmt.Sprintf(
			"eligible: %d/%d requests, %s body reuse",
			stats.PoolUsage.EligibleRequests,
			stats.PoolUsage.Requests,
			percent(stats.PoolUsage.EligibleHitRate),
		),
		fmt.Sprintf("coalesced: %d duplicate misses", stats.PoolUsage.Coalesced),
		fmt.Sprintf(
			"outcomes: %d cache-served, %d uncached",
			poolCached,
			poolUncached,
		),
		fmt.Sprintf(
			"caller: %d requests, %s body reuse",
			stats.CallerUsage.Requests,
			percent(stats.CallerUsage.CacheHitRate),
		),
		fmt.Sprintf(
			"%s: %d requests, %d cache-served, %d uncached",
			clientUsageLabel,
			stats.ClientUsage.Requests,
			clientCached,
			clientUncached,
		),
		fmt.Sprintf(
			"entries: %d fresh / %d total, %d expired, %s",
			stats.Cache.FreshEntries,
			stats.Cache.TotalEntries,
			stats.Cache.ExpiredEntries,
			byteFmt(stats.Cache.BodyBytes),
		),
	)
	for _, line := range lines {
		if _, err := fmt.Fprintln(w, line); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(w, "top routes:"); err != nil {
		return err
	}
	if len(stats.Routes) == 0 {
		if _, err := fmt.Fprintln(w, "  none"); err != nil {
			return err
		}
	} else {
		for _, route := range stats.Routes {
			if _, err := fmt.Fprintf(
				w,
				"  %s: %d req, %s eligible body reuse, %d stale, %d miss, %d bypass, %d errors, %d fallback\n",
				route.RouteKind,
				route.Requests,
				percent(route.EligibleHitRate),
				route.CacheStale,
				route.CacheMisses,
				route.CacheBypass,
				route.ServiceErrors,
				route.Fallbacks,
			); err != nil {
				return err
			}
		}
	}
	if len(stats.Backends) > 0 {
		if _, err := fmt.Fprintln(w, "backend-attributed relay outcomes:"); err != nil {
			return err
		}
		for _, backend := range stats.Backends {
			if _, err := fmt.Fprintf(
				w,
				"  %s / %s: %d req, %d miss, %d bypass, %d revalidated\n",
				backend.Backend,
				backend.RouteKind,
				backend.Requests,
				backend.CacheMisses,
				backend.CacheBypass,
				backend.Revalidated,
			); err != nil {
				return err
			}
		}
	}
	if len(stats.FallbackReasons) > 0 {
		if _, err := fmt.Fprintln(w, "fallback reasons:"); err != nil {
			return err
		}
		for _, fallback := range stats.FallbackReasons {
			if _, err := fmt.Fprintf(
				w,
				"  %s / %s: %d req\n",
				fallback.Reason,
				fallback.RouteKind,
				fallback.Requests,
			); err != nil {
				return err
			}
		}
	}
	if _, err := fmt.Fprintln(w, "clients:"); err != nil {
		return err
	}
	if len(stats.Clients) == 0 {
		_, err := fmt.Fprintln(w, "  none")
		return err
	}
	for _, client := range stats.Clients {
		cached, uncached := client.statsAggregate.cacheOutcomes()
		if _, err := fmt.Fprintf(
			w,
			"  %s: %d req, %d cache-served, %d uncached, %d fallback\n",
			client.ClientName,
			client.Requests,
			cached,
			uncached,
			client.Fallbacks,
		); err != nil {
			return err
		}
	}
	return nil
}

func percent(value *float64) string {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return "n/a"
	}
	return fmt.Sprintf("%.1f%%", *value*100)
}

func byteFmt(value int64) string {
	switch {
	case value >= 1024*1024:
		return fmt.Sprintf("%.1f MiB", float64(value)/(1024*1024))
	case value >= 1024:
		return fmt.Sprintf("%.1f KiB", float64(value)/1024)
	default:
		return fmt.Sprintf("%d B", value)
	}
}
