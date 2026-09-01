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
	branch := ""
	if request.method == "GET" {
		for _, pattern := range nativeReadBranchPathPatterns {
			if match := pattern.FindStringSubmatch(request.path); match != nil {
				branch = match[1]
				break
			}
		}
	}
	for _, segment := range strings.Split(request.path, "/") {
		if err := policy.checkStructural(segment); err != nil {
			return err
		}
		decoded, err := url.PathUnescape(segment)
		if err != nil || decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "?#%") {
			return errRewriteBlocked
		}
		// A slash is data only in the generated native-read branch parameter.
		// Inspect every decoded component as well as the whole path and parameter.
		if branch != "" && segment == branch {
			if strings.ContainsAny(decoded, "{}:*[]\t") {
				return errRewriteBlocked
			}
			for _, part := range strings.Split(decoded, "/") {
				if part == "" || part == "." || part == ".." {
					return errRewriteBlocked
				}
				if err := policy.checkStructural(part); err != nil {
					return err
				}
			}
		} else if strings.Contains(decoded, "/") {
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
	case "run watch":
		values += " --interval,-i"
		booleans = "--exit-status --compact"
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
	specs := typedReadSpecs(command, values, booleans)
	// Retain the guard's existing attached aliases, including native-only filters.
	for alias, spec := range specs {
		spec.attached = len(alias) == 2
		specs[alias] = spec
	}
	parsed, unsupported, err := parseReadOptions(args[2:], specs)
	if unsupported {
		return errRewriteUnsupported
	}
	if err != nil {
		return errRewriteBlocked
	}
	flags := rewriteFlags{values: map[string]string{}, positionals: parsed.positionals}
	for name, value := range parsed.values {
		flags.values[name] = value.raw
	}
	if spec := specs["--repo"]; spec.kind == readSlice && parsed.has("--repo") {
		repos := parsed.values["--repo"].strings
		count := 0
		for _, occurrence := range parsed.ordered {
			if occurrence.name == "--repo" {
				count++
			}
		}
		if count > 1 || len(repos) != 1 {
			return errRewriteUnsupported
		}
		flags.values["--repo"] = repos[0]
	}
	// Validate original material too: overwritten scalars and ignored CSV records
	// do not erase structural/host policy input.
	for _, occurrence := range parsed.ordered {
		if occurrence.name == "--jq" {
			continue
		}
		if err := policy.checkStructural(occurrence.raw); err != nil {
			return err
		}
		if occurrence.name == "--repo" && specs["--repo"].kind != readSlice {
			original := rewriteFlags{values: map[string]string{"--repo": occurrence.raw}}
			if err := rewriteRepo(&original, policy); err != nil {
				return err
			}
		}
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
	if command == "repo view" {
		if err := policy.checkStructural("github.com/" + flags.values["--repo"]); err != nil {
			return err
		}
		// Native repo view owns a positional repository, not a --repo flag.
		prepared.args = []string{"repo", "view", flags.values["--repo"]}
		for _, occurrence := range parsed.ordered {
			if occurrence.name != "--repo" {
				prepared.args = append(prepared.args, parsed.argv[occurrence.start:occurrence.end]...)
			}
		}
		if parsed.delimiter < len(parsed.argv) {
			prepared.args = append(prepared.args, "--")
		}
		prepared.stdin = strings.NewReader("")
		return nil
	}
	prepared.args = append([]string(nil), args[:2]...)
	occurrenceIndex := 0
	for i := 0; i < len(parsed.argv); {
		if occurrenceIndex < len(parsed.ordered) && parsed.ordered[occurrenceIndex].start == i {
			occurrence := parsed.ordered[occurrenceIndex]
			if occurrence.name == "--repo" {
				repo := flags.values["--repo"]
				if specs["--repo"].kind != readSlice && strings.TrimSpace(occurrence.raw) != "" {
					repo = normalizeRepo(occurrence.raw)
				}
				prepared.args = append(prepared.args, "--repo="+repo)
			} else {
				prepared.args = append(prepared.args, parsed.argv[i:occurrence.end]...)
			}
			i = occurrence.end
			occurrenceIndex++
			continue
		}
		if i == parsed.delimiter && !parsed.has("--repo") {
			prepared.args = append(prepared.args, "--repo="+flags.values["--repo"])
		}
		prepared.args = append(prepared.args, parsed.argv[i])
		i++
	}
	if parsed.delimiter == len(parsed.argv) && !parsed.has("--repo") {
		prepared.args = append(prepared.args, "--repo="+flags.values["--repo"])
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
		// Auth leaves own -h as a hostname value. Failed suffix checks stay
		// terminal so value-bearing auth invocations cannot fall through here.
		if len(args) == 3 && args[0] == "auth" && (args[1] == "login" || args[1] == "status") && args[2] == "-h" {
			return false
		}
		return rewriteBootstrapHelpTopic(args[:len(args)-1])
	}
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version" || args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
		return true
	}
	if len(args) >= 2 && args[0] == "help" {
		return rewriteBootstrapHelpTopic(args[1:])
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

// Match complete registered topic paths: a root extension or a permutation of
// built-in words does not inherit a built-in command's help exception.
func rewriteBootstrapHelpTopic(topic []string) bool {
	if len(topic) == 1 {
		return slices.Contains([]string{"api", "pr", "issue", "release", "auth", "status"}, topic[0])
	}
	if len(topic) != 2 {
		return false
	}
	switch topic[0] {
	case "pr":
		return slices.Contains([]string{"create", "edit", "comment", "review", "view", "list", "status", "merge", "ready"}, topic[1])
	case "issue":
		return slices.Contains([]string{"create", "edit", "comment", "view", "list", "status"}, topic[1])
	case "release":
		return slices.Contains([]string{"create", "edit", "view", "list"}, topic[1])
	case "auth":
		return topic[1] == "login" || topic[1] == "status"
	default:
		return false
	}
}

func prepareProtectedGH(ctx context.Context, args []string, stdin io.Reader) (*rewritePreparation, error) {
	prepared := &rewritePreparation{ctx: ctx, args: args, stdin: stdin}
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
		err = prepareRewritePRLifecycle(policy, args, stdin, prepared)
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
