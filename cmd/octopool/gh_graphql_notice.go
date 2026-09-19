package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

type ghGraphQLQuota struct {
	Remaining int64 `json:"remaining"`
	Limit     int64 `json:"limit"`
	Reset     int64 `json:"reset"`
}

func delegatedGHUsesGraphQL(args []string) bool {
	if len(args) < 2 || rewriteBootstrapInvocation(args) {
		return false
	}
	switch args[0] {
	case "pr", "issue":
		switch args[1] {
		case "view", "list", "status", "checks", "diff", "create", "edit", "comment", "review", "ready", "merge", "close", "reopen":
			return true
		}
	case "repo":
		return args[1] == "view"
	case "api":
		declaration, err := describeBestEffortInput(args)
		if err != nil {
			return false
		}
		return declaration.subcommand == "graphql" || declaration.subcommand == "/graphql"
	}
	return false
}

func graphQLQuotaUsesGitHub(args, env []string) bool {
	// An empty policy can retain native Enterprise routing. Never label the
	// GitHub.com credential's quota as that other host's observation.
	knownHost, selectedRepo, qualifiedRepo := false, false, false
	for _, entry := range env {
		name, value, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "GH_HOST") && value != "" && value != "github.com" {
			return false
		}
		if strings.EqualFold(name, "GH_HOST") && value == "github.com" {
			knownHost = true
		}
		if strings.EqualFold(name, "GH_REPO") && value != "" && !githubQuotaRepo(value) {
			return false
		}
		if strings.EqualFold(name, "GH_REPO") && value != "" {
			selectedRepo = true
			qualifiedRepo = explicitGitHubRepoHost(value)
		}
	}
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return false
	}
	for _, arg := range declaration.args {
		if arg.name == "--header" {
			name, _, _ := strings.Cut(arg.value, ":")
			switch strings.ToLower(strings.TrimSpace(name)) {
			case "authorization", "proxy-authorization", "cookie":
				return false
			}
		}
		if arg.name == "--hostname" && arg.value != "github.com" || arg.name == "--repo" && !githubQuotaRepo(arg.value) {
			return false
		}
		if arg.name == "--repo" {
			selectedRepo = true
			qualifiedRepo = qualifiedRepo || explicitGitHubRepoHost(arg.value)
		}
		if arg.name == "--hostname" {
			knownHost = true
		}
		if arg.name == "" {
			for _, value := range declaration.argv[arg.start:arg.end] {
				if !strings.HasPrefix(value, "-") && strings.Contains(value, "://") {
					parsed, err := url.Parse(value)
					if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil {
						return false
					}
					qualifiedRepo = true
				}
			}
		}
	}
	if declaration.command == "repo" && len(args) >= 3 && !strings.HasPrefix(args[2], "-") {
		return githubQuotaRepo(args[2]) && (knownHost || explicitGitHubRepoHost(args[2]))
	}
	if declaration.command == "api" {
		return knownHost
	}
	return qualifiedRepo || selectedRepo && knownHost
}

func explicitGitHubRepoHost(repo string) bool {
	return strings.HasPrefix(repo, "github.com/") || strings.HasPrefix(repo, "https://github.com/")
}

func githubQuotaRepo(repo string) bool {
	repo = strings.TrimPrefix(strings.TrimPrefix(repo, "https://github.com/"), "github.com/")
	return rewriteRepoPattern.MatchString(repo)
}

func readPersonalGraphQLQuota(ctx context.Context, path string, env []string, policy stringRewritePolicy) *ghGraphQLQuota {
	child, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var output prReadGitOutput
	args := []string{"api", "rate_limit", "--hostname=github.com", "--cache=60s"}
	for _, arg := range append(append([]string(nil), args...), "https://api.github.com/rate_limit") {
		if policy.checkStructural(arg) != nil {
			return nil
		}
	}
	if policy.guardRequest(ghAPIRequest{method: "GET", path: "/rate_limit"}) != nil {
		return nil
	}
	// Native gh owns credential-sensitive cache keys and a 60-second TTL. This
	// fixed REST endpoint is rate-limit exempt and never goes through the pool.
	cmd := exec.CommandContext(child, path, args...)
	cmd.Env = env
	cmd.Stdout = &output
	cmd.WaitDelay = 100 * time.Millisecond
	if cmd.Run() != nil {
		return nil
	}
	var response struct {
		Resources struct {
			GraphQL struct {
				Remaining *int64 `json:"remaining"`
				Limit     *int64 `json:"limit"`
				Reset     *int64 `json:"reset"`
			} `json:"graphql"`
		} `json:"resources"`
	}
	if json.Unmarshal(output.data.Bytes(), &response) != nil {
		return nil
	}
	fields := response.Resources.GraphQL
	if fields.Remaining == nil || fields.Limit == nil || fields.Reset == nil {
		return nil
	}
	quota := &ghGraphQLQuota{Remaining: *fields.Remaining, Limit: *fields.Limit, Reset: *fields.Reset}
	if quota.Remaining < 0 || quota.Limit <= 0 || quota.Remaining > quota.Limit || quota.Reset <= 0 {
		return nil
	}
	return quota
}

// Buffer only bounded diagnostic lines; prompts and watch progress stay live.
type ghGraphQLStderr struct {
	writer      io.Writer
	pending     []byte
	exhausted   bool
	longLine    bool
	graphQLOnly bool
}

func newGHGraphQLStderr(writer io.Writer, probe func() *ghGraphQLQuota, graphQLOnly bool) *ghGraphQLStderr {
	output := &ghGraphQLStderr{writer: writer, graphQLOnly: graphQLOnly}
	suffix := ""
	if quota := probe(); quota != nil && quota.Remaining < 500 {
		suffix = fmt.Sprintf(" (REST /rate_limit estimate: remaining %d/%d, resets %s UTC; cached up to 60s, not a retry deadline)", quota.Remaining, quota.Limit, time.Unix(quota.Reset, 0).UTC().Format("15:04"))
	}
	fmt.Fprintln(writer, "octopool: graphql delegated to personal token"+suffix)
	return output
}

func (output *ghGraphQLStderr) Write(data []byte) (int, error) {
	size := len(data)
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		complete := end >= 0
		if complete {
			end++
		} else {
			end = len(data)
		}
		part := data[:end]
		data = data[end:]
		if output.longLine || len(output.pending)+len(part) > 16384 {
			if _, err := output.writer.Write(output.pending); err != nil {
				return 0, err
			}
			output.pending = nil
			if _, err := output.writer.Write(part); err != nil {
				return 0, err
			}
			output.longLine = !complete
			continue
		}
		output.pending = append(output.pending, part...)
		if complete {
			if err := output.flush(); err != nil {
				return 0, err
			}
		} else if !output.exhausted && !graphQLErrorLinePrefix(output.pending) {
			if _, err := output.writer.Write(output.pending); err != nil {
				return 0, err
			}
			output.pending = nil
			output.longLine = true
		}
	}
	return size, nil
}

func graphQLErrorLinePrefix(line []byte) bool {
	lower := strings.ToLower(string(line))
	for _, prefix := range []string{"gh:", "graphql:", "http ", "error:"} {
		if strings.HasPrefix(lower, prefix) || strings.HasPrefix(prefix, lower) {
			return true
		}
	}
	return false
}

func (output *ghGraphQLStderr) flush() error {
	line := string(output.pending)
	output.pending = nil
	lower := strings.ToLower(line)
	primaryLimit := !strings.Contains(lower, "secondary") && !strings.Contains(lower, "abuse")
	graphQLFailure := strings.Contains(lower, "graphql:") || output.graphQLOnly && (strings.Contains(lower, "http 403") || strings.HasPrefix(strings.TrimSpace(lower), "gh:"))
	if primaryLimit && graphQLFailure && (strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit")) {
		output.exhausted = true
		if _, err := io.WriteString(output.writer, line); err != nil {
			return err
		}
		if !strings.HasSuffix(line, "\n") {
			if _, err := io.WriteString(output.writer, "\n"); err != nil {
				return err
			}
		}
		_, err := fmt.Fprintln(output.writer, "octopool: graphql rate limit; retry time unavailable; inspect the failed response's headers; do not re-authenticate")
		return err
	}
	if output.exhausted && (strings.Contains(lower, "token") && strings.Contains(lower, "invalid") || strings.Contains(lower, "gh auth login")) {
		return nil
	}
	_, err := io.WriteString(output.writer, line)
	return err
}
