package main

import (
	"strconv"
	"strings"
)

const ghNativeJSONNotice = "octopool: requested JSON fields require native gh for the entire export; --json alone does not select the relay."
const ghNativeIncludeNotice = "octopool: --include uses native gh and caller credentials; it is not a relay freshness flag."

func nativeReadRoutingNotice(args []string) string {
	if len(args) < 2 || rewriteBootstrapInvocation(args) {
		return ""
	}
	if args[0] == "api" {
		declaration, err := describeBestEffortInput(args)
		if err != nil {
			return ""
		}
		include, body := false, false
		method := ""
		for _, arg := range declaration.args {
			if arg.booleanPrefix != "" {
				include = true
			}
			switch arg.name {
			case "--method":
				method = strings.ToUpper(arg.value)
			case "--input", "--field", "--raw-field":
				body = true
			}
			if arg.name == "--include" {
				include, _ = strconv.ParseBool(arg.value)
			}
		}
		if include && (method == "GET" || method == "" && !body) {
			return ghNativeIncludeNotice
		}
		return ""
	}
	var fields map[string]bool
	switch args[0] + " " + args[1] {
	case "pr view":
		fields = supportedPRFields
	case "pr list":
		fields = supportedPRListFields
	case "issue view", "issue list", "search issues":
		fields = supportedIssueFields
	case "pr checks":
		fields = supportedCheckRunFields
	case "repo view", "search repos":
		fields = supportedRepoFields
	case "search prs":
		fields = supportedPRSearchFields
	case "run view":
		fields = supportedRunViewFields
	case "run list":
		fields = supportedRunListFields
	case "release view":
		fields = supportedReleaseViewFields
	case "release list":
		fields = supportedReleaseFields
	case "workflow view", "workflow list":
		fields = supportedWorkflowFields
	case "label list":
		fields = supportedLabelFields
	case "gist view":
		fields = supportedGistFields
	default:
		return ""
	}
	opts, fallback, err := parseGHTopOptions(args[2:], topReadSpecs(args[0]+" "+args[1]))
	if err == nil && !fallback && machineReadable(opts) && !supportedJSONFields(opts, fields) {
		return ghNativeJSONNotice
	}
	return ""
}
