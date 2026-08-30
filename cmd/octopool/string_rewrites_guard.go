package main

import (
	"context"
	"io"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

func (policy stringRewritePolicy) checkStructural(text string) error {
	// Inspect each bounded decoding layer, then reject residual or malformed
	// encoding. Never change a repository/ref/query to make it pass a policy.
	for depth := 0; depth < 4; depth++ {
		if err := policy.check(text); err != nil {
			return err
		}
		if strings.ContainsAny(text, "\\\x00\r\n") {
			return errRewriteBlocked
		}
		if !strings.Contains(text, "%") {
			return nil
		}
		decoded, err := url.PathUnescape(text)
		if err != nil {
			return errRewriteBlocked
		}
		text = decoded
	}
	return errRewriteBlocked
}
func (policy stringRewritePolicy) guardRequest(request ghAPIRequest) error {
	if len(policy.Rules) == 0 {
		return nil
	}
	if request.method != "GET" && request.method != "POST" && request.method != "PATCH" && request.method != "PUT" {
		return errRewriteBlocked
	}
	if !safeRelayPath(request.path) || strings.ContainsAny(request.path, "{}") || strings.Contains(request.path, "//") {
		return errRewriteBlocked
	}
	if err := policy.checkStructural(request.path); err != nil {
		return err
	}
	for _, segment := range strings.Split(request.path, "/") {
		if err := policy.checkStructural(segment); err != nil {
			return err
		}
		decoded, err := url.PathUnescape(segment)
		if err != nil || decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "/?#%") {
			return errRewriteBlocked
		}
	}
	total := len(request.path)
	check := func(value string) error {
		total += len(value)
		if total > rewriteMaxContent {
			return errRewriteBlocked
		}
		return policy.checkStructural(value)
	}
	for key, value := range request.query {
		if sensitiveQueryKey(key) {
			return errRewriteBlocked
		}
		if err := check(key); err != nil {
			return err
		}
		switch value := value.(type) {
		case string:
			if err := check(value); err != nil {
				return err
			}
		case []string:
			for _, item := range value {
				if err := check(item); err != nil {
					return err
				}
			}
		default:
			return errRewriteBlocked
		}
	}
	for key, value := range request.headers {
		if !safeRelayHeader(strings.ToLower(key)) && !rewriteInternalShapeHeader(key, value) {
			return errRewriteBlocked
		}
		if err := check(key); err != nil {
			return err
		}
		if err := check(value); err != nil {
			return err
		}
	}
	for key, value := range request.routeHint {
		if err := check(key); err != nil {
			return err
		}
		if err := check(value); err != nil {
			return err
		}
	}
	return nil
}

func rewriteInternalShapeHeader(key, value string) bool {
	if key != "x-octopool-public-shape" {
		return false
	}
	return slices.Contains([]string{publicShapeActionsSummary, publicShapeActionsJobs, publicShapeIssueSummary, publicShapeIssueList, publicShapeIssueSearch, publicShapePullRequestList, publicShapePullRequestSummary, publicShapePullRequestFiles, publicShapeLabelList, publicShapeWorkflowList, publicShapeWorkflowView, publicShapeReleaseSummary}, value)
}

var rewriteTagReadPath = regexp.MustCompile(`^/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/git/ref/tags/[A-Za-z0-9_.-]+$`)

func rewriteReadPath(path string) bool {
	return path == "/user" || relayQueryPath(path) || rewriteTagReadPath.MatchString(path)
}

func prepareRewriteRead(policy stringRewritePolicy, args []string, prepared *rewritePreparation) error {
	if len(args) < 2 {
		return errRewriteBlocked
	}
	command := args[0] + " " + args[1]
	values := "--repo,-R --json --jq,-q"
	booleans := ""
	switch command {
	case "pr view", "issue view":
	case "pr diff":
		booleans = "--patch"
	case "pr list":
		values += " --limit,-L --state --author --assignee --label --head,-H"
	case "issue list":
		values += " --limit,-L --state --author --assignee --label"
	case "run view":
		values += " --attempt"
		booleans = "--log --log-failed --exit-status"
	case "run list":
		values += " --limit,-L --branch --workflow --status"
	case "pr checks":
		booleans = "--fail-fast --required"
	case "repo view":
	case "release view":
	case "release list", "workflow list", "label list":
		values += " --limit,-L"
	case "workflow view":
	case "search issues", "search prs":
		values += " --limit,-L --state --author --assignee --label"
	default:
		return errRewriteUnsupported
	}
	flags, err := parseRewriteFlags(args[2:], rewriteFlagNames(values), rewriteFlagNames(booleans))
	if err != nil {
		return errRewriteUnsupported
	}
	if flags.has("--color") {
		return errRewriteBlocked
	}
	if command == "repo view" && len(flags.positionals) == 1 && !flags.has("--repo") {
		flags.values["--repo"] = flags.positionals[0]
		flags.positionals = nil
	}
	if err := rewriteRepo(&flags, policy); err != nil {
		return err
	}
	switch args[1] {
	case "view", "diff", "checks", "watch":
		if args[0] != "repo" {
			if len(flags.positionals) != 1 {
				return errRewriteBlocked
			}
			selector := flags.positionals[0]
			if args[0] == "pr" || args[0] == "issue" || args[0] == "run" {
				if !isDigits(selector) {
					return errRewriteBlocked
				}
			} else if !rewriteRefPattern.MatchString(selector) {
				return errRewriteBlocked
			}
		} else if len(flags.positionals) != 0 {
			return errRewriteBlocked
		}
	case "list":
		if len(flags.positionals) != 0 {
			return errRewriteBlocked
		}
	default:
		if args[0] != "search" {
			return errRewriteBlocked
		}
	}
	for _, value := range flags.positionals {
		if err := policy.checkStructural(value); err != nil {
			return err
		}
	}
	for key, value := range flags.values {
		if key == "--jq" {
			continue // jq evaluates locally after GitHub returns the selected fields.
		}
		if err := policy.checkStructural(value); err != nil {
			return err
		}
	}
	// Check the composed path/query as well as individual values. Relay dispatch
	// checks the actual normalized request again before each network operation.
	path := "/repos/" + flags.values["--repo"]
	resources := map[string]string{"pr": "pulls", "issue": "issues", "run": "actions/runs", "workflow": "actions/workflows", "release": "releases", "label": "labels"}
	if resource := resources[args[0]]; resource != "" {
		path += "/" + resource
	}
	if len(flags.positionals) == 1 && args[0] != "search" {
		path += "/" + flags.positionals[0]
	}
	request := ghAPIRequest{method: "GET", path: path, query: map[string]any{}}
	if args[0] == "search" {
		request.path = "/search/issues"
		request.query["q"] = "repo:" + flags.values["--repo"] + " " + strings.Join(flags.positionals, " ")
	}
	for key, value := range flags.values {
		if key != "--repo" && key != "--jq" && key != "--json" {
			request.query[strings.TrimPrefix(key, "--")] = value
		}
	}
	if err := policy.guardRequest(request); err != nil {
		return err
	}
	prepared.args = append([]string{args[0], args[1]}, flags.positionals...)
	prepared.args = append(prepared.args, "--repo="+flags.values["--repo"])
	for _, flag := range flags.ordered {
		if flag.name != "--repo" {
			if flag.boolean && flag.value == "true" {
				prepared.args = append(prepared.args, flag.name)
			} else {
				prepared.args = append(prepared.args, flag.name+"="+flag.value)
			}
		}
	}
	prepared.stdin = strings.NewReader("")
	return nil
}

// Exceptions are complete invocations, not an auth prefix or an approval bit
// that could accidentally bless different arguments on a later fallback.
func rewriteBootstrapInvocation(args []string) bool {
	if len(args) == 0 {
		return true
	}
	if len(args) >= 2 && (args[len(args)-1] == "--help" || args[len(args)-1] == "-h") {
		return rewriteBootstrapInvocation(append([]string{"help"}, args[:len(args)-1]...))
	}
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version" || args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
		return true
	}
	if len(args) >= 2 && args[0] == "help" {
		for _, arg := range args[1:] {
			if !slices.Contains([]string{"api", "pr", "issue", "release", "auth", "status", "login", "create", "edit", "comment", "review", "view", "list"}, arg) {
				return false
			}
		}
		return true
	}
	if len(args) == 8 && args[0] == "api" && args[1] == "graphql" && args[2] == "--hostname" && args[3] == "github.com" && args[4] == "-f" && args[5] == "query="+authStatusViewerQuery && args[6] == "--jq" && args[7] == ".data.viewer.login" {
		return true
	}
	if len(args) < 2 || args[0] != "auth" {
		return false
	}
	values := "--hostname,-h"
	booleans := ""
	switch args[1] {
	case "status":
		booleans = "--active,-a"
		values += " --json --jq,-q --template,-t"
	case "login":
		booleans = "--with-token --web,-w --insecure-storage --skip-ssh-key"
		values += " --git-protocol,-p --scopes,-s"
	default:
		return false
	}
	flags, err := parseRewriteFlags(args[2:], rewriteFlagNames(values), rewriteFlagNames(booleans))
	if err != nil || len(flags.positionals) != 0 {
		return false
	}
	if flags.has("--hostname") && flags.values["--hostname"] != "github.com" {
		return false
	}
	if flags.has("--git-protocol") && flags.values["--git-protocol"] != "https" && flags.values["--git-protocol"] != "ssh" {
		return false
	}
	if flags.has("--scopes") {
		for _, scope := range strings.Split(flags.values["--scopes"], ",") {
			if !slices.Contains([]string{"repo", "read:org", "gist", "workflow"}, scope) {
				return false
			}
		}
	}
	return true
}

func prepareProtectedGH(ctx context.Context, args []string, stdin io.Reader) (*rewritePreparation, error) {
	prepared := &rewritePreparation{args: args, stdin: stdin}
	if rewriteBootstrapInvocation(args) {
		prepared.forceGitHubHost = true
		return prepared, nil
	}
	policy, err := currentStringRewritePolicy(ctx)
	if err != nil {
		return nil, err
	}
	if len(policy.Rules) == 0 {
		return prepared, nil
	}
	prepared.forceGitHubHost = true
	total := 0
	for _, arg := range args {
		total += len(arg)
		if total > rewriteMaxContent {
			return nil, errRewriteBlocked
		}
	}
	switch {
	case rewriteContentCommand(args):
		err = prepareRewriteContent(policy, args, stdin, prepared)
	case len(args) > 0 && args[0] == "api":
		err = prepareRewriteAPI(policy, args, stdin, prepared)
		if err == errRewriteUnsupported {
			err = prepareRewriteBestEffort(policy, args, stdin, prepared)
		}
	case len(args) >= 2 && args[0] == "pr" && (args[1] == "ready" || args[1] == "merge"):
		err = prepareRewritePRLifecycle(policy, args, prepared)
	default:
		// Modeled reads retain structural pinning. Unknown commands and flag
		// shapes still receive bounded argv/stdin filtering before native gh.
		err = prepareRewriteRead(policy, args, prepared)
		if err == errRewriteUnsupported {
			err = prepareRewriteBestEffort(policy, args, stdin, prepared)
		}
	}
	if err != nil {
		prepared.cleanup()
		return nil, errRewriteBlocked
	}
	return prepared, nil
}
