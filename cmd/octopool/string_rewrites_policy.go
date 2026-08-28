package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const rewritePolicyTimeout = 5 * time.Second

func validRewriteTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func boundedRewriteRead(reader io.Reader, limit int) ([]byte, error) {
	if reader == nil {
		return nil, errRewriteBlocked
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil || len(data) > limit {
		return nil, errRewriteBlocked
	}
	return data, nil
}
func readRewriteFile(path string, stdin io.Reader, limit int) ([]byte, error) {
	if path == "-" {
		return boundedRewriteRead(stdin, limit)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > int64(limit) {
		return nil, errRewriteBlocked
	}
	file, err := openRewriteSnapshot(path)
	if err != nil {
		return nil, errRewriteBlocked
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > int64(limit) {
		return nil, errRewriteBlocked
	}
	return boundedRewriteRead(file, limit)
}

func rewritePolicyHTTP(ctx context.Context, baseURL, path, token, method string, body []byte) ([]byte, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errRewritePolicy
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")) {
		return nil, errRewritePolicy
	}
	if strings.TrimSpace(token) == "" {
		return nil, errRewritePolicy
	}
	child, cancel := context.WithTimeout(ctx, rewritePolicyTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(child, method, apiURL(baseURL, path), bytes.NewReader(body))
	if err != nil {
		return nil, errRewritePolicy
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Cache-Control", "no-cache, no-store")
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: rewritePolicyTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, errRewritePolicy
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return nil, errRewriteConflict
	}
	if response.StatusCode != http.StatusOK {
		return nil, errRewritePolicy
	}
	data, err := boundedRewriteRead(response.Body, rewriteMaxDocument)
	if err != nil {
		return nil, errRewritePolicy
	}
	return data, nil
}

func loadLocalStringRewritePolicy() (stringRewritePolicy, error) {
	path := os.Getenv("OCTOPOOL_STRING_REWRITE_FILE")
	explicit := path != ""
	if !explicit {
		auth, err := authPath()
		if err != nil {
			return stringRewritePolicy{}, errRewritePolicy
		}
		path = filepath.Join(filepath.Dir(auth), "string-rewrites.json")
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			return stringRewritePolicy{}, nil
		}
	}
	data, err := readRewriteFile(path, nil, rewriteMaxDocument)
	if err != nil {
		return stringRewritePolicy{}, errRewritePolicy
	}
	return parseStringRewritePolicy(data, false)
}

func (client ghRelayClient) stringRewritePolicy(ctx context.Context) (stringRewritePolicy, error) {
	data, err := rewritePolicyHTTP(ctx, client.baseURL, "/v1/pools/"+url.PathEscape(client.pool)+"/string-rewrites", client.token, http.MethodGet, nil)
	if err != nil {
		return stringRewritePolicy{}, errRewritePolicy
	}
	server, err := parseStringRewritePolicy(data, true)
	if err != nil {
		return stringRewritePolicy{}, err
	}
	local, err := loadLocalStringRewritePolicy()
	if err != nil {
		return stringRewritePolicy{}, err
	}
	return mergeStringRewritePolicies(server, local)
}
func currentStringRewritePolicy(ctx context.Context) (stringRewritePolicy, error) {
	client, err := newGHRelayClient()
	if err != nil {
		return stringRewritePolicy{}, errRewritePolicy
	}
	return client.stringRewritePolicy(ctx)
}
