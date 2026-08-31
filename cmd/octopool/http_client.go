package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

var errInvalidRedirectLocation = errors.New("invalid redirect Location header")

type jsonRedirectTransport struct {
	base http.RoundTripper
}

func (transport jsonRedirectTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := transport.base.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	switch resp.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		if location := resp.Header.Get("Location"); location != "" {
			// net/http parses Location before CheckRedirect and quotes it on failure.
			if _, err := req.URL.Parse(location); err != nil {
				resp.Body.Close()
				return nil, errInvalidRedirectLocation
			}
		}
	}
	return resp, nil
}

func doJSONRequest(req *http.Request) (*http.Response, error) {
	// Login carries its credential in the body, so protect every JSON request.
	// Keep credential-free discovery's redirect behavior on the shared client.
	client := *httpClient
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = jsonRedirectTransport{base: transport}
	var redirectErr error
	var followedRedirect bool
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if !sameURLOrigin(req.URL, next.URL) {
			redirectErr = errors.New("refusing cross-origin redirect for credential-bearing request")
		} else if len(via) >= 10 {
			redirectErr = errors.New("stopped after 10 redirects")
		}
		if redirectErr == nil {
			followedRedirect = true
			// Older Go versions drop Authorization when only hostname casing changes.
			if authorization := req.Header.Get("Authorization"); authorization != "" {
				next.Header.Set("Authorization", authorization)
			}
		}
		return redirectErr
	}
	resp, err := client.Do(req)
	if redirectErr != nil {
		// net/http wraps redirect errors with the untrusted Location URL.
		return nil, redirectErr
	}
	if errors.Is(err, errInvalidRedirectLocation) {
		// A previous same-origin redirect may also have reflected secrets in its URL.
		return nil, errInvalidRedirectLocation
	}
	if followedRedirect && err != nil {
		var requestErr *url.Error
		if errors.As(err, &requestErr) {
			// Keep the transport cause without printing reflected redirect query values.
			safeErr := *requestErr
			safeErr.URL = req.URL.Redacted()
			return resp, &safeErr
		}
	}
	return resp, err
}

func sameURLOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		effectiveURLPort(left) == effectiveURLPort(right)
}

func effectiveURLPort(value *url.URL) string {
	if port := value.Port(); port != "" {
		return port
	}
	switch strings.ToLower(value.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

func getJSON(ctx context.Context, stdout io.Writer, url string, token string) error {
	resp, err := getJSONRaw(ctx, url, token)
	if err != nil {
		return err
	}
	return writeJSONResponse(stdout, resp)
}

func getJSONRaw(ctx context.Context, url string, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+token)
	return doJSONRequest(req)
}

func postJSON(ctx context.Context, stdout io.Writer, url string, token string, body map[string]any) error {
	resp, err := postJSONRaw(ctx, url, token, body)
	if err != nil {
		return err
	}
	return writeJSONResponse(stdout, resp)
}

func postJSONRaw(
	ctx context.Context,
	url string,
	token string,
	body map[string]any,
) (*http.Response, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(encoded)))
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	req.Header.Set("content-type", "application/json")
	return doJSONRequest(req)
}

func writeJSONResponse(stdout io.Writer, resp *http.Response) error {
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func doRaw(ctx context.Context, url string, token string, body map[string]any) ([]byte, int, error) {
	resp, err := postJSONRaw(ctx, url, token, body)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return out, resp.StatusCode, nil
}
