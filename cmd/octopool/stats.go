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
	Pool        string         `json:"pool"`
	Window      statsWindow    `json:"window"`
	Operator    statsOperator  `json:"operator"`
	PoolUsage   statsAggregate `json:"pool_usage"`
	CallerUsage statsAggregate `json:"caller_usage"`
	Routes      []statsRoute   `json:"routes"`
	Cache       statsCache     `json:"cache"`
}

type statsWindow struct {
	Label   string `json:"label"`
	Seconds int    `json:"seconds"`
}

type statsOperator struct {
	GitHubLogin string `json:"github_login"`
}

type statsAggregate struct {
	Requests          int      `json:"requests"`
	Errors            int      `json:"errors"`
	AvgDurationMS     *float64 `json:"avg_duration_ms"`
	CacheHits         int      `json:"cache_hits"`
	CacheMisses       int      `json:"cache_misses"`
	CacheBypass       int      `json:"cache_bypass"`
	CacheUnknown      int      `json:"cache_unknown"`
	CacheableRequests int      `json:"cacheable_requests"`
	CacheHitRate      *float64 `json:"cache_hit_rate"`
}

type statsRoute struct {
	RouteKind    string `json:"route_kind"`
	LatestSeenAt string `json:"latest_seen_at"`
	statsAggregate
}

type statsCache struct {
	TotalEntries   int   `json:"total_entries"`
	FreshEntries   int   `json:"fresh_entries"`
	ExpiredEntries int   `json:"expired_entries"`
	BodyBytes      int64 `json:"body_bytes"`
}

func runStats(ctx context.Context, args []string, stdout io.Writer) error {
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("stats", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	baseURL := fs.String("url", defaultAuthURL(auth), "Octopool base URL")
	pool := fs.String("pool", defaultAuthPool(auth), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	since := fs.String("since", "24h", "stats window, e.g. 30m, 24h, 7d")
	jsonOutput := fs.Bool("json", false, "print raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := validateAuthURLForRequest(auth, *baseURL, *tokenEnv); err != nil {
		return err
	}
	token, err := callerToken(*tokenEnv)
	if err != nil {
		return err
	}
	query := url.Values{}
	if strings.TrimSpace(*since) != "" {
		query.Set("since", strings.TrimSpace(*since))
	}
	endpoint := apiURL(*baseURL, "/v1/pools/"+urlPath(*pool)+"/stats")
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
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
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
	lines := []string{
		"pool: " + stats.Pool,
		"window: " + firstNonEmpty(stats.Window.Label, "24h"),
		fmt.Sprintf("operator: %s", firstNonEmpty(stats.Operator.GitHubLogin, "unknown")),
		fmt.Sprintf("requests: %s (%s errors)", intFmt(stats.PoolUsage.Requests), intFmt(stats.PoolUsage.Errors)),
		fmt.Sprintf(
			"cache: %s hit (%s hits, %s misses, %s bypass, %s unknown)",
			percent(stats.PoolUsage.CacheHitRate),
			intFmt(stats.PoolUsage.CacheHits),
			intFmt(stats.PoolUsage.CacheMisses),
			intFmt(stats.PoolUsage.CacheBypass),
			intFmt(stats.PoolUsage.CacheUnknown),
		),
		fmt.Sprintf(
			"cacheable: %s/%s requests",
			intFmt(stats.PoolUsage.CacheableRequests),
			intFmt(stats.PoolUsage.Requests),
		),
		fmt.Sprintf(
			"caller: %s requests, %s hit",
			intFmt(stats.CallerUsage.Requests),
			percent(stats.CallerUsage.CacheHitRate),
		),
		fmt.Sprintf(
			"entries: %s fresh / %s total, %s expired, %s",
			intFmt(stats.Cache.FreshEntries),
			intFmt(stats.Cache.TotalEntries),
			intFmt(stats.Cache.ExpiredEntries),
			byteFmt(stats.Cache.BodyBytes),
		),
	}
	for _, line := range lines {
		if _, err := fmt.Fprintln(w, line); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(w, "top routes:"); err != nil {
		return err
	}
	if len(stats.Routes) == 0 {
		_, err := fmt.Fprintln(w, "  none")
		return err
	}
	for _, route := range stats.Routes {
		if _, err := fmt.Fprintf(
			w,
			"  %s: %s req, %s hit, %s errors\n",
			route.RouteKind,
			intFmt(route.Requests),
			percent(route.CacheHitRate),
			intFmt(route.Errors),
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

func intFmt(value int) string {
	return fmt.Sprintf("%d", value)
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
