package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	body := map[string]any{
		"pool":   client.pool,
		"method": request.method,
		"path":   request.path,
	}
	if len(request.query) > 0 {
		body["query"] = request.query
	}
	if len(request.headers) > 0 {
		body["headers"] = request.headers
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
