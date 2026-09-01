package main

import (
	"bytes"
	"context"
	"errors"
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

type rewritePolicyHTTPResult struct {
	data    []byte
	attempt rewritePolicyAttempt
}

func rewritePolicyHTTP(ctx context.Context, baseURL, path, token, method string, body []byte) (rewritePolicyHTTPResult, error) {
	result := rewritePolicyHTTPResult{attempt: rewritePolicyAttempt{started: time.Now()}}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return result, result.attempt.failure(rewritePolicyRequest)
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")) {
		return result, result.attempt.failure(rewritePolicyRequest)
	}
	if strings.TrimSpace(token) == "" {
		return result, result.attempt.failure(rewritePolicyRequest)
	}
	child, cancel := context.WithTimeout(ctx, rewritePolicyTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(child, method, apiURL(baseURL, path), bytes.NewReader(body))
	if err != nil {
		return result, result.attempt.failure(rewritePolicyRequest)
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
		return result, result.attempt.failure(rewritePolicyTransportClass(err))
	}
	defer response.Body.Close()
	result.attempt.status = response.StatusCode
	result.attempt.ray = safeRewritePolicyRay(response.Header)
	if response.StatusCode == http.StatusConflict {
		return result, errRewriteConflict
	}
	if response.StatusCode != http.StatusOK {
		return result, result.attempt.failure(rewritePolicyHTTPStatus)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, rewriteMaxDocument+1))
	if err != nil {
		return result, result.attempt.failure(rewritePolicyResponseRead)
	}
	if len(data) > rewriteMaxDocument {
		return result, result.attempt.failure(rewritePolicyResponseSize)
	}
	result.data = data
	return result, nil
}

func loadLocalStringRewritePolicy(attempt rewritePolicyAttempt) (stringRewritePolicy, error) {
	path := os.Getenv("OCTOPOOL_STRING_REWRITE_FILE")
	explicit := path != ""
	if !explicit {
		auth, err := authPath()
		if err != nil {
			return stringRewritePolicy{}, attempt.failure(rewritePolicyLocalRead)
		}
		path = filepath.Join(filepath.Dir(auth), "string-rewrites.json")
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			return stringRewritePolicy{}, nil
		}
	}
	data, err := readRewriteFile(path, nil, rewriteMaxDocument)
	if err != nil {
		return stringRewritePolicy{}, attempt.failure(rewritePolicyLocalRead)
	}
	policy, err := parseStringRewritePolicy(data, false)
	if err != nil {
		return stringRewritePolicy{}, attempt.failure(rewritePolicyLocalValidation)
	}
	return policy, nil
}

func (client ghRelayClient) stringRewritePolicy(ctx context.Context) (stringRewritePolicy, error) {
	result, err := rewritePolicyHTTP(ctx, client.baseURL, "/v1/pools/"+url.PathEscape(client.pool)+"/string-rewrites", client.token, http.MethodGet, nil)
	if errors.Is(err, errRewriteConflict) {
		return stringRewritePolicy{}, result.attempt.failure(rewritePolicyHTTPStatus)
	}
	if err != nil {
		return stringRewritePolicy{}, err
	}
	server, err := parseStringRewritePolicy(result.data, true)
	if err != nil {
		return stringRewritePolicy{}, result.attempt.failure(rewritePolicyServerValidation)
	}
	local, err := loadLocalStringRewritePolicy(result.attempt)
	if err != nil {
		return stringRewritePolicy{}, err
	}
	merged, err := mergeStringRewritePolicies(server, local)
	if err != nil {
		return stringRewritePolicy{}, result.attempt.failure(rewritePolicyMerge)
	}
	return merged, nil
}
func currentStringRewritePolicy(ctx context.Context) (stringRewritePolicy, error) {
	attempt := rewritePolicyAttempt{started: time.Now()}
	client, err := newGHRelayClient()
	if err != nil {
		return stringRewritePolicy{}, attempt.failure(rewritePolicySetup)
	}
	return client.stringRewritePolicy(ctx)
}
