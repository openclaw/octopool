package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"
)

const defaultURL = "https://octopool.dev"

var httpClient = &http.Client{Timeout: 30 * time.Second}
var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() {
	if isGHArgv(os.Args[0]) {
		args := os.Args[1:]
		var err error
		if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
			err = execRealGH(context.Background(), args, os.Stdout, os.Stderr)
		} else {
			err = runGH(context.Background(), args, os.Stdout, os.Stderr)
		}
		if err != nil {
			var exit exitCodeError
			if errors.As(err, &exit) {
				os.Exit(exit.Code)
			}
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		var exit exitCodeError
		if errors.As(err, &exit) {
			os.Exit(exit.Code)
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

type exitCodeError struct {
	Code int
}

func (e exitCodeError) Error() string {
	return fmt.Sprintf("exit status %d", e.Code)
}

func run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stderr)
		return errors.New("missing command")
	}
	switch args[0] {
	case "version", "--version":
		fmt.Fprintln(stdout, versionLine())
		return nil
	case "login":
		return runLogin(ctx, args[1:], stdout)
	case "gh":
		return runGH(ctx, args[1:], stdout, stderr)
	case "health":
		return runHealth(ctx, args[1:], stdout)
	case "stats":
		return runStats(ctx, args[1:], stdout)
	case "request":
		return runRequest(ctx, args[1:], stdout)
	case "admin":
		return runAdmin(ctx, args[1:], stdout)
	case "help", "-h", "--help":
		usage(stdout)
		return nil
	default:
		usage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func versionLine() string {
	infoVersion, infoCommit, infoDate := buildInfoVersion()
	displayVersion := version
	if displayVersion == "dev" && infoVersion != "" {
		displayVersion = infoVersion
	}
	displayCommit := commit
	if displayCommit == "unknown" && infoCommit != "" {
		displayCommit = infoCommit
	}
	displayDate := date
	if displayDate == "unknown" && infoDate != "" {
		displayDate = infoDate
	}
	return fmt.Sprintf("octopool %s (%s, %s)", displayVersion, displayCommit, displayDate)
}

func buildInfoVersion() (string, string, string) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "", "", ""
	}
	infoVersion := ""
	if info.Main.Version != "" && info.Main.Version != "(devel)" {
		infoVersion = strings.TrimPrefix(info.Main.Version, "v")
	}
	infoCommit := ""
	infoDate := ""
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			if len(setting.Value) >= 7 {
				infoCommit = setting.Value[:7]
			} else {
				infoCommit = setting.Value
			}
		case "vcs.time":
			infoDate = setting.Value
		}
	}
	return infoVersion, infoCommit, infoDate
}

func runHealth(ctx context.Context, args []string, stdout io.Writer) error {
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", defaultAuthURL(auth), "Octopool base URL")
	pool := fs.String("pool", defaultAuthPool(auth), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := validateAuthURLForRequest(auth, *url, *tokenEnv); err != nil {
		return err
	}
	token, err := callerToken(*tokenEnv)
	if err != nil {
		return err
	}
	return getJSON(ctx, stdout, apiURL(*url, "/v1/pools/"+urlPath(*pool)+"/health"), token)
}

func runRequest(ctx context.Context, args []string, stdout io.Writer) error {
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", defaultAuthURL(auth), "Octopool base URL")
	pool := fs.String("pool", defaultAuthPool(auth), "pool id")
	tokenEnv := fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var")
	method := fs.String("method", "GET", "GitHub method")
	path := fs.String("path", "", "GitHub API path")
	queryValues := multiFlag{}
	headerValues := multiFlag{}
	fs.Var(&queryValues, "query", "query key=value, repeatable")
	fs.Var(&headerValues, "header", "header key=value, repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("--path is required")
	}
	if err := validateAuthURLForRequest(auth, *url, *tokenEnv); err != nil {
		return err
	}
	token, err := callerToken(*tokenEnv)
	if err != nil {
		return err
	}
	body := map[string]any{
		"pool":   *pool,
		"method": strings.ToUpper(*method),
		"path":   *path,
	}
	if len(queryValues) > 0 {
		body["query"] = valuesMap(queryValues)
	}
	if len(headerValues) > 0 {
		body["headers"] = valuesMap(headerValues)
	}
	return postJSON(ctx, stdout, apiURL(*url, "/v1/github/request"), token, body)
}

func runAdmin(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("missing admin subcommand")
	}
	switch args[0] {
	case "caller":
		return runAdminCaller(ctx, args[1:], stdout)
	case "identity":
		return runAdminIdentity(ctx, args[1:], stdout)
	default:
		return fmt.Errorf("unknown admin subcommand %q", args[0])
	}
}

func runAdminCaller(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("admin caller", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	adminTokenEnv := fs.String("admin-token-env", "OCTOPOOL_ADMIN_TOKEN", "admin token env var")
	githubLogin := fs.String("github-login", "", "GitHub login to register")
	name := fs.String("name", "", "caller display name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *githubLogin == "" {
		return errors.New("--github-login is required")
	}
	token, err := requiredEnv(*adminTokenEnv)
	if err != nil {
		return err
	}
	body := map[string]any{"pool": *pool, "github_login": *githubLogin}
	if *name != "" {
		body["name"] = *name
	}
	return postJSON(ctx, stdout, apiURL(*url, "/v1/admin/callers"), token, body)
}

func runAdminIdentity(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("admin identity", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	url := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	adminTokenEnv := fs.String("admin-token-env", "OCTOPOOL_ADMIN_TOKEN", "admin token env var")
	id := fs.String("id", "", "identity id")
	login := fs.String("login", "", "GitHub login")
	secretRef := fs.String("secret-ref", "", "Worker secret binding name")
	kind := fs.String("kind", "pat", "identity kind")
	installationID := fs.Int64("installation-id", 0, "GitHub App installation id")
	privateScopes := fs.Bool("private-scopes", false, "allow owner-wide scopes to access private repositories")
	scopeValues := multiFlag{}
	fs.Var(&scopeValues, "scope", "owner/repo or owner, repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *id == "" || *login == "" || *secretRef == "" {
		return errors.New("--id, --login, and --secret-ref are required")
	}
	if *kind == "github_app" && *installationID <= 0 {
		return errors.New("--installation-id is required for github_app identities")
	}
	token, err := requiredEnv(*adminTokenEnv)
	if err != nil {
		return err
	}
	scopes := make([]map[string]any, 0, len(scopeValues))
	for _, scope := range scopeValues {
		owner, repo, ok := strings.Cut(scope, "/")
		item := map[string]any{"owner": owner, "allow_private": *privateScopes && !ok}
		if ok && repo != "" {
			item["repo"] = repo
			item["allow_private"] = true
		}
		scopes = append(scopes, item)
	}
	body := map[string]any{
		"id":         *id,
		"login":      *login,
		"secret_ref": *secretRef,
		"kind":       *kind,
		"scopes":     scopes,
	}
	if *installationID > 0 {
		body["installation_id"] = *installationID
	}
	return postJSON(ctx, stdout, apiURL(*url, "/v1/admin/pools/"+urlPath(*pool)+"/identities"), token, body)
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
	return httpClient.Do(req)
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
	return httpClient.Do(req)
}

func do(stdout io.Writer, req *http.Request) error {
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	return writeJSONResponse(stdout, resp)
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

type multiFlag []string

func (m *multiFlag) String() string {
	return strings.Join(*m, ",")
}

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}

func valuesMap(values []string) map[string]string {
	out := make(map[string]string, len(values))
	for _, value := range values {
		key, item, ok := strings.Cut(value, "=")
		if !ok {
			out[value] = ""
			continue
		}
		out[key] = item
	}
	return out
}

func envDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is not set", name)
	}
	return value, nil
}

func callerToken(envName string) (string, error) {
	if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
		return value, nil
	}
	auth, err := loadAuth()
	if err != nil {
		return "", err
	}
	if auth.Token == "" {
		return "", errors.New("not logged in; run: octopool login")
	}
	return auth.Token, nil
}

func defaultAuthURL(auth authFile) string {
	return envDefault("OCTOPOOL_URL", firstNonEmpty(auth.URL, defaultURL))
}

func defaultAuthPool(auth authFile) string {
	return envDefault("OCTOPOOL_POOL", firstNonEmpty(auth.Pool, "maintainers"))
}

func validateAuthURLForRequest(auth authFile, effectiveURL string, tokenEnvName string) error {
	if strings.TrimSpace(os.Getenv(tokenEnvName)) != "" {
		return nil
	}
	effective := strings.TrimRight(strings.TrimSpace(firstNonEmpty(effectiveURL, defaultURL)), "/")
	stored := strings.TrimRight(strings.TrimSpace(firstNonEmpty(auth.URL, defaultURL)), "/")
	if effective != stored {
		return fmt.Errorf("URL override requires %s or a fresh octopool login for that URL", tokenEnvName)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func isGHArgv(argv0 string) bool {
	base := filepath.Base(argv0)
	return base == "gh" || base == "octopool-gh"
}

func urlPath(value string) string {
	return strings.ReplaceAll(value, "/", "%2F")
}

func apiURL(base string, path string) string {
	return strings.TrimRight(base, "/") + path
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: octopool <login|gh|health|stats|request|admin> [flags]")
}
