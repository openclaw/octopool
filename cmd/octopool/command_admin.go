package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
)

func runAdmin(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("missing admin subcommand")
	}
	switch args[0] {
	case "string-rewrites":
		return runAdminStringRewrites(ctx, args[1:], stdout)
	case "caller":
		return runAdminCaller(ctx, args[1:], stdout)
	case "identity":
		return runAdminIdentity(ctx, args[1:], stdout)
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, "usage: octopool admin <caller|identity|string-rewrites> [flags]")
		return nil
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
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool admin caller [flags]"); err != nil {
		return err
	} else if handled {
		return nil
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
	fs.Var(&scopeValues, "scope", "owner/repo, owner, or * for public repos; repeatable")
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool admin identity [flags]"); err != nil {
		return err
	} else if handled {
		return nil
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
