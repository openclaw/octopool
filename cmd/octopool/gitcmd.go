package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func runGit(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("missing git subcommand")
	}
	switch args[0] {
	case "clone":
		return runGitClone(ctx, args[1:], stdout, stderr)
	case "credential":
		return runGitCredential(args[1:], os.Stdin, stdout)
	default:
		return fmt.Errorf("unknown git subcommand %q", args[0])
	}
}

func runGitClone(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("git clone", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	baseURL := fs.String("url", defaultAuthURL(auth), "Octopool base URL")
	gitPath := fs.String("git-path", envDefault("OCTOPOOL_GIT_PATH", "git"), "Git binary path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 || fs.NArg() > 2 {
		return errors.New("usage: octopool git clone owner/repo [dir]")
	}
	if auth.Token == "" && strings.TrimSpace(os.Getenv("OCTOPOOL_TOKEN")) == "" {
		return errors.New("not logged in; run: octopool login")
	}
	cloneURL, err := gitCloneURL(*baseURL, fs.Arg(0))
	if err != nil {
		return err
	}
	targetDir := gitCloneDir(fs.Arg(0), fs.Args()[1:])
	helper, err := credentialHelperCommand()
	if err != nil {
		return err
	}
	credentialKey, err := gitCredentialConfigKey(*baseURL)
	if err != nil {
		return err
	}
	cloneArgs := []string{
		"-c",
		credentialKey + ".helper=" + helper,
		"clone",
		cloneURL,
	}
	if fs.NArg() == 2 {
		cloneArgs = append(cloneArgs, fs.Arg(1))
	}
	cmd := exec.CommandContext(ctx, *gitPath, cloneArgs...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	configCmd := exec.CommandContext(
		ctx,
		*gitPath,
		"-C",
		targetDir,
		"config",
		credentialKey+".helper",
		helper,
	)
	configCmd.Stdout = stdout
	configCmd.Stderr = stderr
	return configCmd.Run()
}

func runGitCredential(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) > 1 {
		return errors.New("usage: octopool git credential [get|store|erase]")
	}
	if len(args) == 1 && args[0] != "get" {
		return nil
	}
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	token, err := callerToken("OCTOPOOL_TOKEN")
	if err != nil {
		return err
	}
	values := readCredentialInput(stdin)
	if !credentialRequestMatches(auth, values) {
		return nil
	}
	fmt.Fprintln(stdout, "username=x-octopool")
	fmt.Fprintf(stdout, "password=%s\n\n", token)
	return nil
}

func runAdminGitPolicy(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("admin git-policy", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	baseURL := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	pool := fs.String("pool", envDefault("OCTOPOOL_POOL", "maintainers"), "pool id")
	adminTokenEnv := fs.String("admin-token-env", "OCTOPOOL_ADMIN_TOKEN", "admin token env var")
	githubLogin := fs.String("github-login", "", "GitHub login to configure")
	repo := fs.String("repo", "", "GitHub repo owner/repo")
	fetch := fs.Bool("fetch", false, "allow clone/fetch")
	push := fs.Bool("push", false, "allow push")
	expiresAt := fs.String("expires-at", "", "optional ISO expiry timestamp")
	deletePolicy := fs.Bool("delete", false, "delete policy")
	pushBranches := multiFlag{}
	fs.Var(&pushBranches, "push-branch", "allowed push branch glob, repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *githubLogin == "" || *repo == "" {
		return errors.New("--github-login and --repo are required")
	}
	token, err := requiredEnv(*adminTokenEnv)
	if err != nil {
		return err
	}
	endpoint := apiURL(*baseURL, "/v1/admin/pools/"+urlPath(*pool)+"/git-policies")
	if *deletePolicy {
		separator := "?"
		if strings.Contains(endpoint, "?") {
			separator = "&"
		}
		endpoint += separator + "github_login=" + url.QueryEscape(*githubLogin) + "&repo=" + url.QueryEscape(*repo)
		return deleteJSON(ctx, stdout, endpoint, token)
	}
	body := map[string]any{
		"github_login":  *githubLogin,
		"repo":          *repo,
		"fetch":         *fetch,
		"push":          *push,
		"push_branches": []string(pushBranches),
	}
	if *expiresAt != "" {
		body["expires_at"] = *expiresAt
	}
	return putJSON(ctx, stdout, endpoint, token, body)
}

func gitCloneURL(baseURL string, repo string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return "", errors.New("git clone URL must use HTTPS unless targeting localhost")
	}
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", errors.New("repo must be owner/repo")
	}
	if !safeGitPathPart(owner) || !safeGitPathPart(strings.TrimSuffix(name, ".git")) {
		return "", errors.New("repo must contain only GitHub owner/repo path characters")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/git/" + urlPath(owner) + "/" + urlPath(strings.TrimSuffix(name, ".git")) + ".git"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func gitCloneDir(repo string, extra []string) string {
	if len(extra) > 0 && extra[0] != "" {
		return extra[0]
	}
	_, name, ok := strings.Cut(repo, "/")
	if !ok {
		return repo
	}
	return strings.TrimSuffix(name, ".git")
}

func safeGitPathPart(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '.' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func credentialHelperCommand() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return "!" + shellQuote(executable) + " git credential", nil
}

func gitCredentialConfigKey(baseURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("Octopool URL is invalid")
	}
	return "credential." + parsed.Scheme + "://" + parsed.Host + "/git/", nil
}

func credentialRequestMatches(auth authFile, values map[string]string) bool {
	if values["protocol"] == "" || values["host"] == "" {
		return false
	}
	base := defaultAuthURL(auth)
	parsed, err := url.Parse(base)
	if err != nil {
		return false
	}
	return values["protocol"] == parsed.Scheme &&
		strings.EqualFold(values["host"], parsed.Host) &&
		strings.HasPrefix(values["path"], "git/")
}

func readCredentialInput(stdin io.Reader) map[string]string {
	out := map[string]string{}
	scanner := bufio.NewScanner(stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			out[key] = value
		}
	}
	return out
}

func shellQuote(value string) string {
	if runtime.GOOS == "windows" {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
