package main

import (
	"regexp"
	"strconv"
	"strings"
)

var rewriteCIRetryPath = regexp.MustCompile(`^/repos/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/actions/(runs/[1-9][0-9]*/rerun(?:-failed-jobs)?|jobs/[1-9][0-9]*/rerun)$`)
var rewriteWorkflowRunsPath = regexp.MustCompile(`^/repos/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/actions/workflows/([A-Za-z0-9_][A-Za-z0-9_.-]*)/runs$`)

func ciRetryPath(path string) bool {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	return len(parts) >= 7 && parts[0] == "repos" && parts[3] == "actions" &&
		(parts[4] == "runs" || parts[4] == "jobs") && strings.HasPrefix(parts[6], "rerun")
}

func modeledCIAPI(args []string) bool {
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return false
	}
	path, _, _ := strings.Cut("/"+strings.TrimPrefix(declaration.subcommand, "/"), "?")
	return ciRetryPath(path) || rewriteWorkflowRunsPath.MatchString(path)
}

func prepareRewriteCIRetry(policy stringRewritePolicy, args []string, prepared *rewritePreparation) error {
	flags, err := parseRewriteFlags(args[2:], rewriteFlagNames("--repo,-R"), rewriteFlagNames("--failed"))
	if err != nil || len(flags.positionals) != 1 || !validCIRetryID(flags.positionals[0]) {
		return errRewriteBlocked
	}
	if err := rewriteRepo(&flags, policy); err != nil {
		return err
	}
	action := "rerun"
	if flags.values["--failed"] == "true" {
		action = "rerun-failed-jobs"
	}
	// A literal REST target prevents native selection, prompts, or extra payloads.
	return prepareRewriteAPI(policy, []string{"api", "repos/" + flags.values["--repo"] + "/actions/runs/" + flags.positionals[0] + "/" + action, "--method=POST"}, nil, prepared)
}

func validCIRetryID(value string) bool {
	n, err := strconv.ParseInt(value, 10, 64)
	return err == nil && n > 0 && isDigits(value) && value[0] != '0'
}

func prepareRewriteCIRetryAPI(policy stringRewritePolicy, opts rewriteAPIOptions, request ghAPIRequest, prepared *rewritePreparation) error {
	match := rewriteCIRetryPath.FindStringSubmatch(request.path)
	if match == nil || strings.Contains(match[1], "..") || !validCIRetryID(strings.Split(match[2], "/")[1]) || opts.method != "POST" || opts.inputSet || len(opts.fields) != 0 || len(request.query) != 0 {
		return errRewriteBlocked
	}
	for _, flag := range opts.output {
		if strings.HasPrefix(flag, "--paginate") || strings.HasPrefix(flag, "--slurp") {
			return errRewriteBlocked
		}
	}
	prepared.args = append([]string{"api", opts.endpoint, "--method=POST", "--hostname=github.com"}, opts.output...)
	prepared.stdin = strings.NewReader("")
	return nil
}

func workflowRunsQuery(opts rewriteAPIOptions, request ghAPIRequest) (ghAPIRequest, error) {
	match := rewriteWorkflowRunsPath.FindStringSubmatch(request.path)
	if match == nil || strings.Contains(match[1], "..") || strings.Contains(match[2], "..") || opts.method != "GET" || opts.inputSet {
		return request, errRewriteBlocked
	}
	for _, field := range opts.fields {
		key, value, ok := strings.Cut(field.value, "=")
		if _, duplicate := request.query[key]; !ok || duplicate || strings.HasPrefix(value, "@") || strings.ContainsAny(value, "{}") {
			return request, errRewriteBlocked
		}
		request.query[key] = value
	}
	for key, raw := range request.query {
		value, ok := raw.(string)
		if !ok || value == "" {
			return request, errRewriteBlocked
		}
		switch key {
		case "event", "branch", "status":
		case "head_sha":
			if !rewriteCommitSHA.MatchString(value) {
				return request, errRewriteBlocked
			}
		case "per_page":
			n, err := strconv.Atoi(value)
			if err != nil || !isDigits(value) || n < 1 || n > 100 {
				return request, errRewriteBlocked
			}
		default:
			return request, errRewriteBlocked
		}
	}
	return request, nil
}
