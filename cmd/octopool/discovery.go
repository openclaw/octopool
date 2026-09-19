package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type serverDiscovery struct {
	Service       string `json:"service"`
	Version       int    `json:"version"`
	APIBase       string `json:"api_base"`
	AppBase       string `json:"app_base"`
	DefaultPool   string `json:"default_pool"`
	AllowedOrg    string `json:"allowed_org"`
	MinCLIVersion string `json:"min_cli_version"`
	Auth          struct {
		CLIGitHubToken bool `json:"cli_github_token"`
		WebLogin       bool `json:"web_login"`
	} `json:"auth"`
}

type resolvedLoginServer struct {
	InputURL  string
	APIBase   string
	AppBase   string
	Pool      string
	Org       string
	Discovery serverDiscovery
}

func discoverLoginServer(
	ctx context.Context,
	rawURL string,
	poolOverride string,
	trustRedirect bool,
) (resolvedLoginServer, error) {
	inputURL, err := normalizeBaseURL(rawURL)
	if err != nil {
		return resolvedLoginServer{}, err
	}
	if err := validateLoginURL(inputURL); err != nil {
		return resolvedLoginServer{}, err
	}
	discovery, err := fetchServerDiscovery(ctx, inputURL)
	if err != nil {
		return resolvedLoginServer{}, err
	}
	apiBase, err := normalizeBaseURL(firstNonEmpty(discovery.APIBase, inputURL))
	if err != nil {
		return resolvedLoginServer{}, fmt.Errorf("discovery api_base is invalid: %w", err)
	}
	if err := validateLoginURL(apiBase); err != nil {
		return resolvedLoginServer{}, fmt.Errorf("discovery api_base is invalid: %w", err)
	}
	if !trustRedirect && !sameURLHost(inputURL, apiBase) {
		return resolvedLoginServer{}, fmt.Errorf("discovery api_base host %q differs from login host %q; rerun with --trust-discovery-redirect if you trust this server", mustURLHostPort(apiBase), mustURLHostPort(inputURL))
	}
	appBase := strings.TrimRight(firstNonEmpty(discovery.AppBase, apiBase), "/")
	pool := firstNonEmpty(poolOverride, envDefault("OCTOPOOL_POOL", ""), discovery.DefaultPool, "maintainers")
	return resolvedLoginServer{
		InputURL:  inputURL,
		APIBase:   apiBase,
		AppBase:   appBase,
		Pool:      pool,
		Org:       discovery.AllowedOrg,
		Discovery: discovery,
	}, nil
}

func fetchServerDiscovery(ctx context.Context, baseURL string) (serverDiscovery, error) {
	endpoint := apiURL(baseURL, "/.well-known/octopool")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return serverDiscovery{}, err
	}
	req.Header.Set("accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return serverDiscovery{}, fmt.Errorf("server discovery failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := readJSONResponseBody(resp.Body, 1<<20)
	if err != nil {
		return serverDiscovery{}, err
	}
	if resp.StatusCode >= 400 {
		return serverDiscovery{}, fmt.Errorf("server discovery failed: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var discovery serverDiscovery
	if err := json.Unmarshal(body, &discovery); err != nil {
		return serverDiscovery{}, fmt.Errorf("server discovery returned invalid JSON: %w", err)
	}
	if discovery.Service != "octopool" {
		return serverDiscovery{}, errors.New("server discovery did not identify an Octopool server")
	}
	if discovery.Version < 1 {
		return serverDiscovery{}, errors.New("server discovery returned an unsupported version")
	}
	if !discovery.Auth.CLIGitHubToken {
		return serverDiscovery{}, errors.New("server does not support CLI GitHub-token login")
	}
	return discovery, nil
}

func normalizeBaseURL(rawURL string) (string, error) {
	raw := strings.TrimSpace(rawURL)
	if raw == "" {
		raw = defaultURL
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("URL %q is missing a host", rawURL)
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), nil
}

func sameURLHost(left string, right string) bool {
	return strings.EqualFold(mustURLHostPort(left), mustURLHostPort(right))
}

func mustURLHostPort(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return parsed.Host
}
