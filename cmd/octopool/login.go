package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type loginResponse struct {
	Caller struct {
		GitHubLogin string `json:"github_login"`
		Pool        string `json:"pool"`
	} `json:"caller"`
	Token string `json:"token"`
}

type apiErrorResponse struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
		Details   struct {
			GitHubRateLimitReset     string `json:"github_rate_limit_reset"`
			GitHubRateLimitRemaining string `json:"github_rate_limit_remaining"`
			GitHubRateLimitResource  string `json:"github_rate_limit_resource"`
			GitHubRetryAfter         string `json:"github_retry_after"`
			FallbackReason           string `json:"reason"`
		} `json:"details"`
	} `json:"error"`
}

func runLogin(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	urlFlag := fs.String("url", "", "Octopool base URL")
	serverFlag := fs.String("server", "", "Octopool server URL")
	pool := fs.String("pool", "", "pool id")
	ghPath := fs.String("gh-path", envDefault("OCTOPOOL_GH_PATH", "gh"), "GitHub CLI path")
	trustRedirect := fs.Bool("trust-discovery-redirect", false, "allow discovery api_base on a different host")
	if err := fs.Parse(normalizeLoginArgs(args)); err != nil {
		return err
	}
	baseURL, err := loginServerArgument(fs, *urlFlag, *serverFlag)
	if err != nil {
		return err
	}
	server, err := discoverLoginServer(ctx, baseURL, *pool, *trustRedirect)
	if err != nil {
		return err
	}
	token, err := localGitHubToken(ctx, *ghPath)
	if err != nil {
		return err
	}
	body := map[string]any{
		"github_token": token,
		"pool":         server.Pool,
	}
	out, status, err := doRaw(ctx, apiURL(server.APIBase, "/v1/login/github-cli"), "", body)
	if err != nil {
		return err
	}
	if status >= 400 {
		return formatLoginFailure(status, out, *ghPath, server.APIBase, server.Pool)
	}
	var response loginResponse
	if err := json.Unmarshal(out, &response); err != nil {
		return err
	}
	if response.Token == "" {
		return errors.New("login response did not include a caller token")
	}
	if err := saveAuth(authFile{
		URL:       server.APIBase,
		Pool:      server.Pool,
		Token:     response.Token,
		Login:     response.Caller.GitHubLogin,
		CreatedAt: time.Now().UTC(),
	}); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "logged in to %s as %s for pool %s\n", server.APIBase, response.Caller.GitHubLogin, server.Pool)
	return nil
}

func normalizeLoginArgs(args []string) []string {
	flags := make([]string, 0, len(args))
	positionals := []string{}
	valueFlags := map[string]bool{
		"gh-path": true,
		"pool":    true,
		"server":  true,
		"url":     true,
	}
	for index := 0; index < len(args); index += 1 {
		arg := args[index]
		if arg == "--" {
			positionals = append(positionals, args[index+1:]...)
			break
		}
		if strings.HasPrefix(arg, "-") && arg != "-" {
			flags = append(flags, arg)
			name := loginFlagName(arg)
			if valueFlags[name] && !strings.Contains(arg, "=") && index+1 < len(args) {
				index += 1
				flags = append(flags, args[index])
			}
			continue
		}
		positionals = append(positionals, arg)
	}
	return append(flags, positionals...)
}

func loginFlagName(arg string) string {
	name := strings.TrimLeft(arg, "-")
	if before, _, ok := strings.Cut(name, "="); ok {
		name = before
	}
	return name
}

func loginServerArgument(fs *flag.FlagSet, urlFlag string, serverFlag string) (string, error) {
	visited := map[string]bool{}
	fs.Visit(func(item *flag.Flag) {
		visited[item.Name] = true
	})
	if fs.NArg() > 1 {
		return "", errors.New("usage: octopool login [server] [--pool <pool>]")
	}
	positional := ""
	if fs.NArg() == 1 {
		positional = fs.Arg(0)
	}
	if visited["url"] && visited["server"] && strings.TrimSpace(urlFlag) != strings.TrimSpace(serverFlag) {
		return "", errors.New("--url and --server disagree")
	}
	if positional != "" && (visited["url"] || visited["server"]) {
		flagValue := firstNonEmpty(serverFlag, urlFlag)
		if strings.TrimSpace(flagValue) != strings.TrimSpace(positional) {
			return "", errors.New("login server positional argument disagrees with --url/--server")
		}
	}
	return firstNonEmpty(positional, serverFlag, urlFlag, envDefault("OCTOPOOL_URL", defaultURL)), nil
}

func formatLoginFailure(status int, body []byte, ghPath string, serverURL string, pool string) error {
	trimmed := strings.TrimSpace(string(body))
	var response apiErrorResponse
	if err := json.Unmarshal(body, &response); err != nil || response.Error.Code == "" {
		return fmt.Errorf("login failed: HTTP %d: %s", status, trimmed)
	}
	message := response.Error.Message
	if message == "" {
		message = response.Error.Code
	}
	requestID := ""
	if response.Error.RequestID != "" {
		requestID = "\nOctopool request id: " + response.Error.RequestID
	}
	if response.Error.Code == "github_auth_failed" {
		resolvedGHPath := ghPath
		if resolved, err := resolveGHPath(ghPath); err == nil {
			resolvedGHPath = resolved
		}
		if isRateLimitedLoginFailure(message, response) {
			return fmt.Errorf("login failed: GitHub rejected the local gh token while Octopool verified it (%s).\nLikely cause: the GitHub API rate limit for this token is exhausted, or the token needs re-auth.%s\nCheck reset: %s api rate_limit --jq '.resources.core'\nRetry after reset: octopool login --gh-path %s%s", message, rateLimitHint(response), resolvedGHPath, resolvedGHPath, requestID)
		}
		return fmt.Errorf("login failed: GitHub rejected the local gh token while Octopool verified it (%s).\nRefresh GitHub CLI auth: %s auth login\nThen retry: octopool login --gh-path %s%s", message, resolvedGHPath, resolvedGHPath, requestID)
	}
	if response.Error.Code == "caller_not_provisioned" {
		quotedServerURL := shellQuoteArg(serverURL)
		quotedPool := shellQuoteArg(pool)
		return fmt.Errorf("login failed: your GitHub account is not provisioned for Octopool pool %q.\nAsk an Octopool admin to grant access with:\nOCTOPOOL_ADMIN_TOKEN=... octopool admin caller --url %s --pool %s --github-login your-github-login\nThen retry: octopool login %s%s", pool, quotedServerURL, quotedPool, quotedServerURL, requestID)
	}
	return fmt.Errorf("login failed: %s: %s%s", response.Error.Code, message, requestID)
}

func shellQuoteArg(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func isRateLimitedLoginFailure(message string, response apiErrorResponse) bool {
	if strings.Contains(message, "429") || strings.Contains(strings.ToLower(message), "rate limit") {
		return true
	}
	details := response.Error.Details
	return details.GitHubRateLimitRemaining == "0" ||
		details.GitHubRetryAfter != ""
}

func rateLimitHint(response apiErrorResponse) string {
	parts := []string{}
	if reset := githubResetTime(response.Error.Details.GitHubRateLimitReset); reset != "" {
		parts = append(parts, "GitHub reset: "+reset)
	}
	if remaining := response.Error.Details.GitHubRateLimitRemaining; remaining != "" {
		parts = append(parts, "remaining: "+remaining)
	}
	if resource := response.Error.Details.GitHubRateLimitResource; resource != "" {
		parts = append(parts, "resource: "+resource)
	}
	if retryAfter := response.Error.Details.GitHubRetryAfter; retryAfter != "" {
		parts = append(parts, "retry-after: "+retryAfter+"s")
	}
	if len(parts) == 0 {
		return ""
	}
	return "\n" + strings.Join(parts, "; ")
}

func githubResetTime(value string) string {
	if value == "" {
		return ""
	}
	epoch, err := strconv.ParseInt(value, 10, 64)
	if err != nil || epoch <= 0 {
		return ""
	}
	return time.Unix(epoch, 0).Local().Format(time.RFC1123)
}

func validateLoginURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname()) {
		return nil
	}
	if envDefault("OCTOPOOL_ALLOW_INSECURE_LOGIN", "") == "1" {
		return nil
	}
	return errors.New("login URL must use HTTPS; set OCTOPOOL_ALLOW_INSECURE_LOGIN=1 only for local development")
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func localGitHubToken(ctx context.Context, ghPath string) (string, error) {
	if token := strings.TrimSpace(os.Getenv("GH_TOKEN")); token != "" {
		return token, nil
	}
	if token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); token != "" {
		return token, nil
	}
	path, err := resolveGHPath(ghPath)
	if err != nil {
		return "", err
	}
	child, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, path, "auth", "token")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("gh auth token failed: %w", err)
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", errors.New("gh auth token returned empty output")
	}
	return token, nil
}

func resolveGHPath(configured string) (string, error) {
	self, _ := os.Executable()
	return resolveGHPathFrom(configured, self, ghPathCandidates(os.Getenv("PATH"), defaultGHCandidates()))
}

func defaultGHCandidates() []string {
	return []string{
		"/opt/homebrew/opt/gh/bin/gh",
		"/opt/homebrew/bin/gh",
		"/usr/local/bin/gh",
		"/usr/bin/gh",
	}
}

func ghPathCandidates(pathEnv string, fallback []string) []string {
	return ghPathCandidatesFor(pathEnv, fallback, runtime.GOOS, os.Getenv("PATHEXT"))
}

func ghPathCandidatesFor(pathEnv string, fallback []string, goos string, pathExt string) []string {
	seen := map[string]struct{}{}
	candidates := []string{}
	add := func(path string) {
		if path == "" {
			return
		}
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		candidates = append(candidates, path)
	}
	names := ghExecutableNames(goos, pathExt)
	for _, dir := range filepath.SplitList(pathEnv) {
		if !filepath.IsAbs(dir) {
			continue
		}
		for _, name := range names {
			add(filepath.Join(dir, name))
		}
	}
	for _, path := range fallback {
		add(path)
	}
	return candidates
}

func ghExecutableNames(goos string, pathExt string) []string {
	if goos != "windows" {
		return []string{"gh"}
	}
	names := []string{"gh"}
	extensions := strings.FieldsFunc(pathExt, func(r rune) bool {
		return r == ';' || r == ':'
	})
	if len(extensions) == 0 || strings.TrimSpace(pathExt) == "" {
		extensions = []string{".COM", ".EXE", ".BAT", ".CMD"}
	}
	for _, extension := range extensions {
		extension = strings.TrimSpace(extension)
		if extension == "" {
			continue
		}
		if !strings.HasPrefix(extension, ".") {
			extension = "." + extension
		}
		names = append(names, "gh"+strings.ToLower(extension))
	}
	return names
}

func resolveGHPathFrom(configured string, self string, candidates []string) (string, error) {
	if configured != "" && configured != "gh" {
		return configured, nil
	}
	for _, candidate := range candidates {
		if usableGHPath(candidate, self) {
			return candidate, nil
		}
	}
	return "", errors.New("real gh not found; set OCTOPOOL_GH_PATH or install GitHub CLI")
}

func usableGHPath(path string, self string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	if samePath(path, self) {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return false
	}
	return !octopoolGHWrapper(path)
}

func octopoolGHWrapper(path string) bool {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		base := filepath.Base(resolved)
		if base == "octopool" || base == "octopool-gh" {
			return true
		}
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || len(data) > 8192 {
		return false
	}
	return strings.Contains(string(data), "octopool gh")
}

func samePath(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return left == right
	}
	leftInfo, leftStat := os.Stat(leftAbs)
	rightInfo, rightStat := os.Stat(rightAbs)
	if leftStat == nil && rightStat == nil {
		return os.SameFile(leftInfo, rightInfo)
	}
	return leftAbs == rightAbs
}
