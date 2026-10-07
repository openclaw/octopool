package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

// restGitHubAPIRoot is the production GitHub API. The rename harness points
// it at a loopback server; callers do not set it from the environment.
var restGitHubAPIRoot = "https://api.github.com"

type restPRWrite struct {
	command, number, repo string
	body, bodyFile        string
}

// Deliberately exclude selectors, duplicate flags, and every other native option.
func parseRESTPRWrite(args []string) (restPRWrite, bool) {
	if len(args) < 3 || args[0] != "pr" {
		return restPRWrite{}, false
	}
	values := "--repo,-R"
	switch args[1] {
	case "comment", "edit":
		values += " --body,-b --body-file,-F"
	case "close":
		values += " --comment,-c"
	default:
		return restPRWrite{}, false
	}
	flags, err := parseRewriteFlags(args[2:], rewriteFlagNames(values), nil)
	if err != nil || len(flags.positionals) != 1 || !isDigits(flags.positionals[0]) {
		return restPRWrite{}, false
	}
	number, err := strconv.ParseInt(flags.positionals[0], 10, 64)
	if err != nil || number <= 0 {
		return restPRWrite{}, false
	}
	if flags.has("--repo") && flags.values["--repo"] == "" {
		return restPRWrite{}, false
	}
	if args[1] != "close" && (flags.has("--body") == flags.has("--body-file") || flags.has("--body-file") && flags.values["--body-file"] == "") {
		return restPRWrite{}, false
	}
	body := flags.values["--body"]
	if args[1] == "close" {
		body = flags.values["--comment"]
	}
	return restPRWrite{args[1], strconv.FormatInt(number, 10), flags.values["--repo"], body, flags.values["--body-file"]}, true
}

func restWriteEnv(env []string, key string) string {
	// exec.Cmd uses the last value when the environment contains duplicates.
	for i := len(env) - 1; i >= 0; i-- {
		name, value, _ := strings.Cut(env[i], "=")
		if name == key || runtime.GOOS == "windows" && strings.EqualFold(name, key) {
			return value
		}
	}
	return ""
}

func nativeRESTWriteToken(ctx context.Context, path string, env []string) (string, error) {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if token := restWriteEnv(env, key); token != "" {
			return token, nil
		}
	}
	return storedGitHubToken(ctx, path, env)
}

func execRESTPRWrite(ctx context.Context, ghPath string, original []string, prepared *rewritePreparation, env []string, stdout, stderr io.Writer) (bool, error) {
	if restWriteEnv(env, "OCTOPOOL_REST_WRITES") == "0" || restWriteEnv(env, "GH_FORCE_TTY") != "" {
		return false, nil
	}
	for _, output := range []io.Writer{stdout, stderr} {
		if file, ok := output.(*os.File); ok && rewriteReaderIsTerminal(file) {
			return false, nil
		}
	}
	if host := restWriteEnv(env, "GH_HOST"); host != "" && host != "github.com" {
		return false, nil
	}
	before, ok := parseRESTPRWrite(original)
	if !ok {
		return false, nil
	}
	write, ok := parseRESTPRWrite(prepared.args)
	if !ok || before.command != write.command {
		return false, nil
	}
	// Use the same local base-repository resolver as guarded PR reads. Explicit
	// pins made by the guard win; unknown hosts and ambiguous remotes stay native.
	raw := write.repo
	if raw == "" {
		raw = restWriteEnv(env, "GH_REPO")
	}
	// Local git probes use the process environment. A distinct child environment
	// can clear GH_REPO or redirect git configuration, so leave that discovery to gh.
	if raw == "" && !slices.Equal(env, os.Environ()) {
		return false, nil
	}
	repo, err := rewritePRReadBaseRepo(prepared.policy, raw)
	if err != nil {
		return false, nil
	}
	write.repo = repo
	token, err := nativeRESTWriteToken(ctx, ghPath, env)
	if err != nil {
		return false, nil
	}
	// Credential/repository failures can delegate before consuming stdin. After
	// this point no error hands off or retries, even if a response was lost.
	if write.bodyFile != "" {
		body, err := readRewriteFile(write.bodyFile, prepared.stdin, rewriteMaxContent)
		if err != nil {
			// With no active rules the native command still owns unusual file
			// sources and file errors. Stdin cannot be handed off after reading.
			if len(prepared.policy.Rules) == 0 && write.bodyFile != "-" {
				return false, nil
			}
			return true, err
		}
		write.body = string(body)
	}
	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	err = write.execute(ctx, client, token, prepared.policy, stdout, stderr)
	if err != nil {
		var exit exitCodeError
		if errors.As(err, &exit) {
			return true, err
		}
		if _, outputErr := fmt.Fprintln(stderr, redactRESTWriteToken(err.Error(), token)); outputErr != nil {
			return true, outputErr
		}
		return true, exitCodeError{Code: 1}
	}
	return true, nil
}

type restPRResponse struct {
	Number int64  `json:"number"`
	URL    string `json:"html_url"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Merged *bool  `json:"merged"`
}

func (write *restPRWrite) execute(ctx context.Context, client *http.Client, token string, policy stringRewritePolicy, stdout, stderr io.Writer) error {
	pullPath := repoPath(write.repo, "pulls", write.number)
	commentPath := repoPath(write.repo, "issues", write.number, "comments")
	var pr restPRResponse
	if write.command != "edit" {
		// The issues endpoint also accepts ordinary issues. Prove this is a PR
		// before commenting, and preserve native close's merged/closed no-ops.
		followed, err := restPRRequest(ctx, client, token, policy, http.MethodGet, pullPath, nil, http.StatusOK, &pr)
		if err != nil {
			return err
		}
		if !write.acceptPR(pr, followed, policy) {
			return errors.New("invalid GitHub REST pull request response")
		}
		pullPath = repoPath(write.repo, "pulls", write.number)
		commentPath = repoPath(write.repo, "issues", write.number, "comments")
		if write.command == "close" {
			if pr.Merged == nil || (pr.State != "open" && pr.State != "closed") {
				return errors.New("invalid GitHub REST pull request state")
			}
			repo := strings.TrimSuffix(strings.TrimPrefix(pr.URL, "https://github.com/"), "/pull/"+write.number)
			label := redactRESTWriteToken(fmt.Sprintf("%s#%s (%s)", repo, write.number, pr.Title), token)
			if *pr.Merged {
				if _, err := fmt.Fprintf(stderr, "X Pull request %s can't be closed because it was already merged\n", label); err != nil {
					return err
				}
				return exitCodeError{Code: 1}
			}
			if pr.State == "closed" {
				_, err := fmt.Fprintf(stderr, "! Pull request %s is already closed\n", label)
				return err
			}
		}
	}
	if write.command == "comment" || write.command == "close" && write.body != "" {
		var comment struct {
			URL string `json:"html_url"`
		}
		followed, err := restPRRequest(ctx, client, token, policy, http.MethodPost, commentPath, map[string]string{"body": write.body}, http.StatusCreated, &comment)
		if err != nil {
			return err
		}
		prURL, id, ok := strings.Cut(comment.URL, "#issuecomment-")
		commentPR := pr
		commentPR.URL = prURL
		if !ok || !isDigits(id) || !write.acceptPR(commentPR, followed, policy) {
			return errors.New("invalid GitHub REST comment response")
		}
		// A rename can happen after the preflight; close must use the new repo too.
		pr = commentPR
		pullPath = repoPath(write.repo, "pulls", write.number)
		if write.command == "comment" {
			_, err := fmt.Fprintln(stdout, redactRESTWriteToken(comment.URL, token))
			return err
		}
	}
	payload := map[string]string{"body": write.body}
	if write.command == "close" {
		payload = map[string]string{"state": "closed"}
	}
	var updated restPRResponse
	followed, err := restPRRequest(ctx, client, token, policy, http.MethodPatch, pullPath, payload, http.StatusOK, &updated)
	if err != nil {
		return err
	}
	if !write.acceptPR(updated, followed, policy) || write.command == "close" && updated.State != "closed" {
		return errors.New("invalid GitHub REST pull request response")
	}
	if write.command == "edit" {
		_, err := fmt.Fprintln(stdout, redactRESTWriteToken(updated.URL, token))
		return err
	}
	repo := strings.TrimSuffix(strings.TrimPrefix(updated.URL, "https://github.com/"), "/pull/"+write.number)
	_, err = fmt.Fprintf(stderr, "✓ Closed pull request %s\n", redactRESTWriteToken(fmt.Sprintf("%s#%s (%s)", repo, write.number, pr.Title), token))
	return err
}

func (write restPRWrite) validPR(pr restPRResponse) bool {
	return strconv.FormatInt(pr.Number, 10) == write.number && strings.EqualFold(pr.URL, "https://github.com/"+write.repo+"/pull/"+write.number)
}

func (write *restPRWrite) acceptPR(pr restPRResponse, followed bool, policy stringRewritePolicy) bool {
	if write.validPR(pr) {
		return true
	}
	// A rename redirect is the only time the canonical html_url may differ
	// from the repository the caller still has checked out.
	return followed && write.adoptCanonical(pr, policy) && write.validPR(pr)
}

func (write *restPRWrite) adoptCanonical(pr restPRResponse, policy stringRewritePolicy) bool {
	if strconv.FormatInt(pr.Number, 10) != write.number {
		return false
	}
	const prefix = "https://github.com/"
	suffix := "/pull/" + write.number
	if !strings.HasPrefix(pr.URL, prefix) || !strings.HasSuffix(pr.URL, suffix) {
		return false
	}
	repo := strings.TrimSuffix(strings.TrimPrefix(pr.URL, prefix), suffix)
	if !validCanonicalRepo(repo) || restPolicyAllowsCanonical(policy, repo) != nil {
		return false
	}
	write.repo = repo
	return true
}

func validCanonicalRepo(repo string) bool {
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return false
	}
	if strings.ContainsAny(repo, " \t?#%\\") || owner == "." || owner == ".." || name == "." || name == ".." {
		return false
	}
	return true
}

func restPolicyAllowsCanonical(policy stringRewritePolicy, repo string) error {
	if len(policy.Rules) == 0 {
		return nil
	}
	for _, text := range []string{
		repo,
		"https://github.com/" + repo,
		restGitHubAPIRoot + "/repos/" + repo,
		"/repos/" + repo,
	} {
		if err := policy.checkStructural(text); err != nil {
			return err
		}
	}
	return nil
}

func restPRRequest(ctx context.Context, client *http.Client, token string, policy stringRewritePolicy, method, path string, payload map[string]string, expected int, result any) (bool, error) {
	return restPRExchange(ctx, client, token, policy, method, path, payload, expected, result, true)
}

func restPRExchange(ctx context.Context, client *http.Client, token string, policy stringRewritePolicy, method, path string, payload map[string]string, expected int, result any, allowFollow bool) (bool, error) {
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			return false, err
		}
	}
	endpoint := restGitHubAPIRoot + path
	headers := map[string]string{"Accept": "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"}
	if len(policy.Rules) > 0 {
		// Content is already rewritten. Check generated wire material without
		// applying replacement rules a second time or changing structural fields.
		if err := policy.guardRequest(ghAPIRequest{method: method, path: path}); err != nil {
			return false, err
		}
		if err := policy.checkStructural(endpoint); err != nil {
			return false, err
		}
		for key, value := range payload {
			if policy.check(key) != nil || policy.check(value) != nil {
				return false, errRewriteBlocked
			}
		}
		if policy.check(string(body)) != nil {
			return false, errRewriteBlocked
		}
		for key, value := range headers {
			if policy.checkStructural(key) != nil || policy.checkStructural(value) != nil {
				return false, errRewriteBlocked
			}
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return false, errors.New("could not prepare GitHub REST request")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		// Transport errors can contain authentication material or arbitrary proxy
		// responses. Report a fixed error, with no replay after an uncertain write.
		return false, errors.New("GitHub REST request failed; the write may have been accepted")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, rewriteMaxContent+1))
	if err != nil || len(data) > rewriteMaxContent {
		return false, errors.New("could not read GitHub REST response; the write may have been accepted")
	}
	if resp.StatusCode != expected {
		if allowFollow && restRedirectStatus(resp.StatusCode) {
			if next, ok := restRenameLocation(resp.Header.Get("Location"), path); ok {
				// Learn the canonical owner/name before replaying. A numeric
				// repository path does not contain the name the policy guards.
				id, suffix, ok := restRenameParts(next)
				if !ok {
					return false, errors.New("invalid GitHub REST redirect")
				}
				repo, err := restCanonicalRepository(ctx, client, token, policy, id)
				if err != nil {
					return false, err
				}
				if err := restPolicyAllowsCanonical(policy, repo); err != nil {
					return false, err
				}
				named := "/repos/" + repo + suffix
				if _, err := restPRExchange(ctx, client, token, policy, method, named, payload, expected, result, false); err != nil {
					return true, err
				}
				return true, nil
			}
		}
		message := http.StatusText(resp.StatusCode)
		var failure struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &failure) == nil && failure.Message != "" {
			message = failure.Message
		}
		return false, fmt.Errorf("HTTP %d: %s (%s)", resp.StatusCode, redactRESTWriteToken(message, token), endpoint)
	}
	if json.Unmarshal(data, result) != nil {
		return false, errors.New("invalid GitHub REST response; the write may have been accepted")
	}
	return false, nil
}

func restRedirectStatus(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}

func restRenameLocation(location, originalPath string) (string, bool) {
	parsed, err := url.Parse(location)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, "api.github.com") {
		return "", false
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path == "" || parsed.Path == originalPath {
		return "", false
	}
	suffix := restResourceSuffix(originalPath)
	if suffix == "" || strings.Contains(parsed.Path, "//") {
		return "", false
	}
	if _, nextSuffix, ok := restRenameParts(parsed.Path); !ok || nextSuffix != suffix {
		return "", false
	}
	return parsed.Path, true
}

func restRenameParts(path string) (id, suffix string, ok bool) {
	suffix = restResourceSuffix(path)
	if suffix == "" {
		return "", "", false
	}
	id, ok = strings.CutPrefix(strings.TrimSuffix(path, suffix), "/repositories/")
	if !ok || id == "" || strings.Contains(id, "/") || !isDigits(id) {
		return "", "", false
	}
	return id, suffix, true
}

func restCanonicalRepository(ctx context.Context, client *http.Client, token string, policy stringRewritePolicy, id string) (string, error) {
	var identity struct {
		FullName string `json:"full_name"`
	}
	if _, err := restPRExchange(ctx, client, token, policy, http.MethodGet, "/repositories/"+id, nil, http.StatusOK, &identity, false); err != nil {
		return "", err
	}
	if !validCanonicalRepo(identity.FullName) {
		return "", errors.New("invalid GitHub repository identity")
	}
	return identity.FullName, nil
}

func restResourceSuffix(path string) string {
	// Owner or repository names may themselves be "pulls" or "issues".
	// Skip the repository prefix, then take only a real resource tail.
	parts := strings.Split(strings.Trim(path, "/"), "/")
	var tail []string
	switch {
	case len(parts) >= 4 && parts[0] == "repos":
		tail = parts[3:]
	case len(parts) >= 3 && parts[0] == "repositories" && isDigits(parts[1]):
		tail = parts[2:]
	default:
		return ""
	}
	suffix := "/" + strings.Join(tail, "/")
	if strings.HasPrefix(suffix, "/pulls/") || strings.HasPrefix(suffix, "/issues/") {
		return suffix
	}
	return ""
}

func redactRESTWriteToken(text, token string) string {
	if token == "" {
		return text
	}
	text = strings.ReplaceAll(text, token, "[REDACTED]")
	return strings.ReplaceAll(text, url.QueryEscape(token), "[REDACTED]")
}
