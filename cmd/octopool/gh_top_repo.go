package main

import (
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

func repoNumber(opts ghTopOptions) (string, string, bool) {
	if len(opts.positionals) != 1 {
		return "", "", false
	}
	repo, number := repoAndNumber(opts.repo, opts.positionals[0])
	if repo == "" {
		if strings.TrimSpace(opts.repo) != "" {
			return "", "", false
		}
		repo = currentGitHubRepo()
	}
	if repo == "" || number == "" {
		return "", "", false
	}
	return repo, number, true
}

func repoOnly(opts ghTopOptions) (string, bool) {
	if len(opts.positionals) != 0 {
		return "", false
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok {
		return "", false
	}
	if repo == "" {
		return "", false
	}
	return repo, true
}

func repoFromOptionOrCurrent(raw string) (string, bool) {
	if strings.TrimSpace(raw) != "" {
		repo := normalizeRepo(raw)
		return repo, repo != ""
	}
	repo := currentGitHubRepo()
	return repo, repo != ""
}

func repoAndNumber(repo string, raw string) (string, string) {
	if parsedRepo, number := repoNumberFromURL(raw); parsedRepo != "" && number != "" {
		return parsedRepo, number
	}
	if before, after, ok := strings.Cut(raw, "#"); ok {
		return normalizeRepo(before), after
	}
	if isDigits(raw) {
		return normalizeRepo(repo), raw
	}
	return "", ""
}

func repoNumberFromURL(raw string) (string, string) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", ""
	}
	if parsed.Host != "github.com" && parsed.Host != "www.github.com" {
		return "", ""
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 4 {
		return "", ""
	}
	if (parts[2] != "pull" && parts[2] != "issues") || !isDigits(parts[3]) {
		return "", ""
	}
	return normalizeRepo(parts[0] + "/" + parts[1]), parts[3]
}

func currentGitHubRepo() string {
	if repo := strings.TrimSpace(os.Getenv("GH_REPO")); repo != "" {
		return normalizeRepo(repo)
	}
	out, err := exec.Command("git", "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return ""
	}
	return normalizeRepo(strings.TrimSpace(string(out)))
}

func isHex(raw string) bool {
	return regexp.MustCompile(`^[0-9A-Fa-f]+$`).MatchString(raw)
}

func normalizeRepo(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	raw = strings.TrimSuffix(raw, ".git")
	if parsed, err := url.Parse(raw); err == nil && parsed.Scheme == "ssh" && parsed.Hostname() == "github.com" && parsed.RawQuery == "" && parsed.Fragment == "" {
		hasPassword := false
		if parsed.User != nil {
			_, hasPassword = parsed.User.Password()
		}
		if parsed.User == nil || (parsed.User.Username() == "git" && !hasPassword) {
			raw = parsed.Path
		}
	}
	raw = strings.TrimPrefix(raw, "git@github.com:")
	raw = strings.TrimPrefix(raw, "https://github.com/")
	parts := strings.Split(strings.Trim(raw, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return ""
	}
	return strings.ToLower(parts[0]) + "/" + parts[1]
}

func repoPath(repo string, parts ...string) string {
	items := append([]string{"repos"}, strings.Split(repo, "/")...)
	items = append(items, parts...)
	for index, item := range items {
		items[index] = url.PathEscape(item)
	}
	return "/" + strings.Join(items, "/")
}
