package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var relayQueryPathPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^/repos/[^/]+/[^/]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/commits$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/commits/[0-9A-Fa-f]{7,64}$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/pulls/[0-9]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/pulls$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/pulls/[0-9]+/(files|comments|reviews)$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/commits/[0-9A-Fa-f]{7,64}/(check-runs|status)$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/runs$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/runs/[0-9]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/runs/[0-9]+/(jobs|artifacts)$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/jobs/[0-9]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/jobs/[0-9]+/logs$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/check-runs/[0-9]+/annotations$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/issues/[0-9]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/issues$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/issues/[0-9]+/(comments|timeline)$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/branches/[^/?#]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/workflows$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/workflows/[^/?#]+$`),
	regexp.MustCompile(`^/repos/[^/]+/[^/]+/actions/workflows/[^/?#]+/runs$`),
	regexp.MustCompile(`^/rate_limit$`),
}

type relayEnvelope struct {
	Status       int               `json:"status"`
	Headers      map[string]string `json:"headers"`
	Body         json.RawMessage   `json:"body"`
	BodyEncoding string            `json:"body_encoding"`
}

var errOctopoolNotLoggedIn = errors.New("not logged in; run: octopool login")

func runGH(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, "usage: octopool gh api <GET path> [--jq expr]")
		fmt.Fprintln(stdout, "       octopool gh pr|issue|run|repo|release ...")
		return nil
	}
	if args[0] != "api" {
		handled, err := runGHTopLevel(ctx, args, stdout)
		if err != nil {
			if shouldRunRealGH(err) {
				return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, err)
			}
			return err
		}
		if handled {
			return nil
		}
		return execRealGH(ctx, args, stdout, stderr)
	}
	request, fallback, err := parseGHAPIArgs(args[1:])
	if err != nil {
		return err
	}
	if fallback {
		return execRealGH(ctx, args, stdout, stderr)
	}
	if !safeRelayRequest(request) {
		return execRealGH(ctx, args, stdout, stderr)
	}
	if request.jq != "" && !jqAvailable() {
		return execRealGH(ctx, args, stdout, stderr)
	}
	client, err := newGHRelayClient()
	if err != nil {
		if shouldRunRealGH(err) {
			return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, err)
		}
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		if shouldRunRealGH(err) {
			return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, err)
		}
		return err
	}
	return writeGHBody(ctx, stdout, envelope, request.jq)
}

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

func (client ghRelayClient) do(ctx context.Context, request ghAPIRequest) (relayEnvelope, error) {
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
	out, status, err := doRaw(ctx, apiURL(client.baseURL, "/v1/github/request"), client.token, body)
	if err != nil {
		return relayEnvelope{}, err
	}
	if status >= 400 {
		if fallback, ok := parseLocalFallback(out); ok {
			return relayEnvelope{}, fallback
		}
		return relayEnvelope{}, fmt.Errorf("octopool request failed: %s", strings.TrimSpace(string(out)))
	}
	var envelope relayEnvelope
	if err := json.Unmarshal(out, &envelope); err != nil {
		return relayEnvelope{}, err
	}
	return envelope, nil
}

type ghAPIRequest struct {
	method  string
	path    string
	query   map[string]any
	headers map[string]string
	jq      string
}

func parseGHAPIArgs(args []string) (ghAPIRequest, bool, error) {
	request := ghAPIRequest{
		method:  "GET",
		query:   map[string]any{},
		headers: map[string]string{},
	}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch arg {
		case "--method", "-X":
			index++
			if index >= len(args) {
				return request, false, errors.New("--method requires a value")
			}
			request.method = strings.ToUpper(args[index])
		case "--jq", "-q":
			index++
			if index >= len(args) {
				return request, false, errors.New("--jq requires a value")
			}
			request.jq = args[index]
		case "-H", "--header":
			index++
			if index >= len(args) {
				return request, false, errors.New("--header requires a value")
			}
			key, value, ok := strings.Cut(args[index], ":")
			if ok {
				header := strings.ToLower(strings.TrimSpace(key))
				if !safeRelayHeader(header) {
					return request, true, nil
				}
				request.headers[header] = strings.TrimSpace(value)
			}
		case "-f", "-F", "--field", "--raw-field", "--paginate", "--slurp":
			return request, true, nil
		default:
			if strings.HasPrefix(arg, "--method=") {
				request.method = strings.ToUpper(strings.TrimPrefix(arg, "--method="))
				continue
			}
			if strings.HasPrefix(arg, "--jq=") {
				request.jq = strings.TrimPrefix(arg, "--jq=")
				continue
			}
			if strings.HasPrefix(arg, "--header=") {
				key, value, ok := strings.Cut(strings.TrimPrefix(arg, "--header="), ":")
				if ok {
					header := strings.ToLower(strings.TrimSpace(key))
					if !safeRelayHeader(header) {
						return request, true, nil
					}
					request.headers[header] = strings.TrimSpace(value)
				}
				continue
			}
			if strings.HasPrefix(arg, "-") {
				return request, true, nil
			}
			if request.path != "" {
				return request, true, nil
			}
			path, rawQuery, ok := strings.Cut(arg, "?")
			request.path = path
			if ok {
				values, err := url.ParseQuery(rawQuery)
				if err != nil {
					return request, false, err
				}
				for key, items := range values {
					if len(items) == 1 {
						request.query[key] = items[0]
					} else if len(items) > 1 {
						request.query[key] = items
					}
				}
			}
		}
	}
	if request.path == "" {
		return request, false, errors.New("gh api path is required")
	}
	if !strings.HasPrefix(request.path, "/") {
		request.path = "/" + request.path
	}
	return request, request.method != "GET", nil
}

func safeRelayHeader(header string) bool {
	switch header {
	case "accept", "x-github-api-version", "if-none-match", "if-modified-since":
		return true
	default:
		return false
	}
}

func safeRelayRequest(request ghAPIRequest) bool {
	if !safeRelayPath(request.path) {
		return false
	}
	if len(request.query) > 0 && !relayQueryPath(request.path) {
		return false
	}
	for key := range request.query {
		if sensitiveQueryKey(key) {
			return false
		}
	}
	return true
}

func safeRelayPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.HasPrefix(path, "/") &&
		!strings.Contains(path, "://") &&
		!strings.Contains(path, "\\") &&
		!strings.Contains(path, "?") &&
		!strings.Contains(path, "#") &&
		!strings.Contains(path, "..") &&
		!hasDotSegment(path) &&
		!strings.Contains(lower, "%2e") &&
		!strings.Contains(lower, "%5c")
}

func hasDotSegment(path string) bool {
	return path == "." || strings.Contains(path, "/./") || strings.HasSuffix(path, "/.")
}

func relayQueryPath(path string) bool {
	for _, pattern := range relayQueryPathPatterns {
		if pattern.MatchString(path) {
			return true
		}
	}
	return false
}

func sensitiveQueryKey(key string) bool {
	lower := strings.ToLower(key)
	return strings.Contains(lower, "token") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "password") ||
		strings.Contains(lower, "passwd") ||
		strings.Contains(lower, "api_key") ||
		strings.Contains(lower, "apikey") ||
		strings.Contains(lower, "access_key") ||
		strings.Contains(lower, "private_key")
}

func writeGHBody(ctx context.Context, stdout io.Writer, envelope relayEnvelope, jq string) error {
	var out []byte
	switch envelope.BodyEncoding {
	case "text":
		if rawJSONIsNull(envelope.Body) {
			break
		}
		var text string
		if err := json.Unmarshal(envelope.Body, &text); err != nil {
			return err
		}
		out = []byte(text)
	case "base64":
		if rawJSONIsNull(envelope.Body) {
			break
		}
		var encoded string
		if err := json.Unmarshal(envelope.Body, &encoded); err != nil {
			return err
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return err
		}
		out = decoded
	default:
		out = append([]byte(nil), envelope.Body...)
	}
	if envelope.Status >= 400 {
		_, _ = stdout.Write(out)
		return fmt.Errorf("github returned status %d", envelope.Status)
	}
	if jq != "" {
		return runJQ(ctx, stdout, out, jq)
	}
	_, err := stdout.Write(out)
	if len(out) > 0 && !bytes.HasSuffix(out, []byte("\n")) {
		_, _ = fmt.Fprintln(stdout)
	}
	return err
}

func rawJSONIsNull(value json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

type localFallbackError struct {
	Reason string
}

func (err localFallbackError) Error() string {
	if err.Reason == "" {
		return "octopool requested local gh fallback"
	}
	return "octopool requested local gh fallback: " + err.Reason
}

func isLocalFallback(err error) bool {
	var fallback localFallbackError
	return errors.As(err, &fallback)
}

func shouldRunRealGH(err error) bool {
	return isLocalFallback(err) || errors.Is(err, errOctopoolNotLoggedIn)
}

func parseLocalFallback(out []byte) (localFallbackError, bool) {
	var response apiErrorResponse
	if err := json.Unmarshal(out, &response); err != nil {
		return localFallbackError{}, false
	}
	if response.Error.Code != "fallback_local" {
		return localFallbackError{}, false
	}
	reason := response.Error.Details.FallbackReason
	if reason == "" {
		reason = response.Error.Message
	}
	return localFallbackError{Reason: reason}, true
}

func execRealGHAfterLocalFallback(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	stderr io.Writer,
	reason error,
) error {
	if envDefault("OCTOPOOL_NO_FALLBACK", "") != "" {
		return reason
	}
	if !errors.Is(reason, errOctopoolNotLoggedIn) {
		fmt.Fprintf(stderr, "octopool: %v; falling back to real gh\n", reason)
	}
	return execRealGH(ctx, args, stdout, stderr)
}

func runJQ(ctx context.Context, stdout io.Writer, input []byte, expr string) error {
	child, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, "jq", "-r", expr)
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	return cmd.Run()
}

func jqAvailable() bool {
	_, err := exec.LookPath("jq")
	return err == nil
}

func execRealGH(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	path, err := resolveGHPath(envDefault("OCTOPOOL_GH_PATH", "gh"))
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitCodeError{Code: exitErr.ExitCode()}
		}
		return err
	}
	return nil
}
