package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"strconv"
	"strings"
	"time"
)

type relayEnvelope struct {
	Status       int               `json:"status"`
	Headers      map[string]string `json:"headers"`
	Body         json.RawMessage   `json:"body"`
	BodyEncoding string            `json:"body_encoding"`
	Relay        relayMeta         `json:"relay"`
}

type relayMeta struct {
	Cache          string `json:"cache"`
	CacheExpiresAt string `json:"cache_expires_at"`
	RouteKind      string `json:"route_kind"`
}

// Routes whose body states something the caller is likely acting on right now
// (which SHA is at the head, whether the PR merged, whether CI finished). A
// cache hit here is correct but can trail a push or merge by the route TTL, and
// silently reads as current fact.
func volatileRouteKind(kind string) bool {
	switch kind {
	case "pr_view", "pr_list", "issue_view", "issue_list", "run_view", "run_list",
		"checks", "check_suites", "status", "status_list", "jobs", "job", "commit_view", "ref_view":
		return true
	default:
		return false
	}
}

// One line, on stderr, so `--json` consumers keep a clean stdout. Without it a
// cached answer is indistinguishable from a live one, which is how a stale head
// SHA or a "still open" merged PR reads as truth.
func noteCachedRead(envelope relayEnvelope) {
	if freshReadRequested() || quietCacheNotices() {
		return
	}
	if envelope.Relay.Cache != "hit" && envelope.Relay.Cache != "stale" {
		return
	}
	if !volatileRouteKind(envelope.Relay.RouteKind) {
		return
	}
	fmt.Fprintf(
		os.Stderr,
		"octopool: %s served from shared cache (%s)%s; set OCTOPOOL_FRESH=1 for a live read\n",
		envelope.Relay.RouteKind,
		envelope.Relay.Cache,
		cacheExpirySuffix(envelope.Relay.CacheExpiresAt),
	)
}

func cacheExpirySuffix(expiresAt string) string {
	if expiresAt == "" {
		return ""
	}
	expires, err := time.Parse(time.RFC3339, strings.Replace(strings.TrimSpace(expiresAt), " ", "T", 1))
	if err != nil {
		return ""
	}
	remaining := time.Until(expires).Round(time.Second)
	if remaining <= 0 {
		return ""
	}
	return fmt.Sprintf(", refreshes in %s", remaining)
}

var errOctopoolNotLoggedIn = errors.New("not logged in; run: octopool login")

type ghRelayClient struct {
	token   string
	baseURL string
	pool    string
}

func newGHRelayClient() (ghRelayClient, error) {
	auth, err := loadAuth()
	if err != nil {
		return ghRelayClient{}, err
	}
	token := strings.TrimSpace(os.Getenv("OCTOPOOL_TOKEN"))
	if token == "" {
		token = auth.Token
	}
	if token == "" {
		return ghRelayClient{}, errOctopoolNotLoggedIn
	}
	baseURL := envDefault("OCTOPOOL_URL", auth.URL)
	if baseURL == "" {
		baseURL = defaultURL
	}
	if err := validateAuthURLForRequest(auth, baseURL, "OCTOPOOL_TOKEN"); err != nil {
		return ghRelayClient{}, err
	}
	pool := envDefault("OCTOPOOL_POOL", auth.Pool)
	if pool == "" {
		pool = "maintainers"
	}
	return ghRelayClient{token: token, baseURL: baseURL, pool: pool}, nil
}

// Transient pool-exhaustion fallbacks are retried against the relay before the
// CLI gives up and burns the caller's local token: a concurrent session often
// fills the shared cache (or an identity cooldown resets) within seconds.
var relayRetryDelays = []time.Duration{time.Second, 3 * time.Second}

func transientFallbackReason(reason string) bool {
	switch reason {
	case "identities_cooling_down", "identity_pool_depleted",
		"github_identity_depleted", "github_rate_limited", "relay_overloaded":
		return true
	default:
		return false
	}
}

func relayRetryAttempts() int {
	raw := strings.TrimSpace(os.Getenv("OCTOPOOL_RELAY_RETRIES"))
	if raw == "" {
		return len(relayRetryDelays)
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 0 {
		return len(relayRetryDelays)
	}
	return parsed
}

func (client ghRelayClient) do(ctx context.Context, request ghAPIRequest) (relayEnvelope, error) {
	// All callers construct GET requests; keep writes outside the shared retry path.
	if request.method != "GET" {
		return relayEnvelope{}, fmt.Errorf("relay client requires GET, got %q", request.method)
	}
	retries := relayRetryAttempts()
	for attempt := 0; ; attempt++ {
		envelope, err := client.doOnce(ctx, request)
		if err == nil {
			return envelope, err
		}
		if attempt < retries && transientRelayFailure(err) {
			delay := relayRetryDelays[min(attempt, len(relayRetryDelays)-1)]
			if err := sleepContext(ctx, delay); err != nil {
				return envelope, err
			}
			continue
		}
		var relay *relayResponseError
		if errors.As(err, &relay) {
			if fallback, ok := localFallbackFromRelayError(relay); ok {
				return envelope, fallback
			}
		}
		return envelope, err
	}
}

func transientRelayFailure(err error) bool {
	var relay *relayResponseError
	if !errors.As(err, &relay) {
		return false
	}
	if relay.Code == "fallback_local" {
		return transientFallbackReason(relayFallbackReason(relay))
	}
	if relay.Status < 500 || relay.Status > 599 {
		return false
	}
	if relay.Code != "" {
		return relay.Code == "internal_error"
	}
	switch relay.Status {
	case 502, 503, 504:
		return true
	default:
		return false
	}
}

func (client ghRelayClient) doOnce(ctx context.Context, request ghAPIRequest) (relayEnvelope, error) {
	headers := request.headers
	if _, explicit := headers["cache-control"]; freshReadRequested() && !explicit {
		headers = maps.Clone(headers)
		if headers == nil {
			headers = make(map[string]string)
		}
		headers["cache-control"] = "max-age=0"
	}
	body := map[string]any{
		"pool":   client.pool,
		"method": request.method,
		"path":   request.path,
	}
	if len(request.query) > 0 {
		body["query"] = request.query
	}
	if len(headers) > 0 {
		body["headers"] = headers
	}
	if len(request.routeHint) > 0 {
		body["route_hint"] = request.routeHint
	}
	out, status, err := doRaw(ctx, apiURL(client.baseURL, "/v1/github/request"), client.token, body)
	if err != nil {
		return relayEnvelope{}, err
	}
	if status < 200 || status >= 300 {
		return relayEnvelope{}, parseRelayResponseError(status, out)
	}
	var envelope relayEnvelope
	if err := json.Unmarshal(out, &envelope); err != nil {
		return relayEnvelope{}, err
	}
	noteCachedRead(envelope)
	return envelope, nil
}

func decodeRelayBody(envelope relayEnvelope) ([]byte, error) {
	switch envelope.BodyEncoding {
	case "json":
		return append([]byte(nil), envelope.Body...), nil
	case "text":
		if rawJSONIsNull(envelope.Body) {
			return nil, nil
		}
		var text string
		if err := json.Unmarshal(envelope.Body, &text); err != nil {
			return nil, err
		}
		return []byte(text), nil
	case "base64":
		if rawJSONIsNull(envelope.Body) {
			return nil, nil
		}
		var encoded string
		if err := json.Unmarshal(envelope.Body, &encoded); err != nil {
			return nil, err
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, err
		}
		return decoded, nil
	default:
		return nil, fmt.Errorf("unsupported relay body encoding %q", envelope.BodyEncoding)
	}
}

func writeGHBody(ctx context.Context, stdout io.Writer, envelope relayEnvelope, jq string) error {
	out, err := decodeRelayBody(envelope)
	if err != nil {
		return err
	}
	if envelope.Status >= 400 {
		_, _ = stdout.Write(out)
		return fmt.Errorf("github returned status %d", envelope.Status)
	}
	return writeBytes(ctx, stdout, out, jq)
}

func rawJSONIsNull(value json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}
