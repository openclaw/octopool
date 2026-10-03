package main

import (
	"net/url"
	"regexp"
	"slices"
	"strings"
)

type nativeShape struct {
	text, command, method string
	graphql               *bool
	write, include        bool
}

var nativeJournalCommands = map[string]string{
	"api": "", "auth": "login logout refresh setup-git status switch token",
	"pr":    "checkout checks close comment create diff edit list lock merge ready reopen review status unlock view",
	"issue": "close comment create delete develop edit list lock pin reopen status transfer unlock unpin view",
	"repo":  "archive autolink clone create delete deploy-key edit fork list rename set-default sync unarchive view",
	"run":   "cancel delete download list rerun view watch", "workflow": "disable enable list run view",
	"release": "create delete delete-asset download edit list upload verify verify-asset view",
	"search":  "code commits issues prs repos", "gist": "clone create delete edit list rename view",
	"label": "clone create delete edit list", "project": "close copy create delete edit field-create field-delete field-list item-add item-archive item-create item-delete item-edit item-list link list mark-template unlink view",
	"cache": "delete list", "variable": "delete get list set", "secret": "delete list set",
	"extension": "browse create exec install list remove search upgrade", "alias": "delete import list set",
	"config": "clear-cache get list set", "ssh-key": "add delete list", "gpg-key": "add delete list",
	"codespace": "code cp create delete edit jupyter list logs ports rebuild ssh stop view",
	"status":    "", "browse": "", "completion": "", "help": "", "version": "",
	"repo autolink": "create delete list view", "repo deploy-key": "add delete list",
	"codespace ports": "forward visibility",
}

var nativeJournalValueFlags = strings.Fields("--repo --json --jq --template --hostname --method --input --field --raw-field --header --cache --preview --body --body-file --title --base --head --label --assignee --reviewer --milestone --project --state --search --limit --author --app --branch --commit --event --status --workflow --job --attempt --interval --ref --comment --match-head-commit --subject --email --reason --add-label --remove-label --add-assignee --remove-assignee --add-reviewer --remove-reviewer --add-project --remove-project --add-milestone --remove-milestone --notes --notes-file --target --pattern --dir --filename --name --description --visibility --scopes --git-protocol --editor --level --color --sort --order --owner --language --topic --q")
var nativeJournalBoolFlags = strings.Fields("--help --version --include --paginate --slurp --silent --verbose --web --watch --exit-status --fail-fast --required --patch --color --comments --log --log-failed --failed --draft --fill --fill-first --fill-verbose --recover --delete-branch --squash --merge --rebase --auto --disable-auto --admin --approve --request-changes --edit-last --create-if-none --yes --force --with-token --active --show-token --insecure-storage --all --dry-run --confirm --latest --prerelease --verify-tag")
var nativeJournalShortFlags = map[byte]string{
	'R': "--repo", 'q': "--jq", 't': "--title", 'b': "--body", 'F': "--body-file", 'B': "--base", 'H': "--head",
	'L': "--limit", 's': "--state", 'S': "--search", 'l': "--label", 'a': "--assignee", 'r': "--reviewer",
	'm': "--milestone", 'P': "--project", 'w': "--web", 'h': "--help",
}

func journalFlagSpec(command, name string) (string, bool, bool) {
	if len(name) == 2 && name[0] == '-' {
		if command == "api" {
			name = map[byte]string{'X': "--method", 'F': "--field", 'f': "--raw-field", 'H': "--header", 'q': "--jq", 't': "--template", 'p': "--preview", 'i': "--include", 'h': "--help"}[name[1]]
		} else if command == "auth" && name == "-h" {
			name = "--hostname"
		} else {
			name = nativeJournalShortFlags[name[1]]
		}
	}
	if slices.Contains(nativeJournalValueFlags, name) {
		return name, true, true
	}
	return name, false, slices.Contains(nativeJournalBoolFlags, name)
}

func describeNativeShape(args []string) nativeShape {
	out := nativeShape{}
	path, flags := []string{"gh"}, []string{}
	endpoint, query, method := "", "", ""
	body, commandDone := false, false
	subcommands := ""
	for i := 0; i < len(args); i++ {
		if i >= 128 {
			break
		}
		arg := args[i]
		if arg == "--" {
			if out.command == "api" && endpoint == "" && i+1 < len(args) {
				endpoint = args[i+1]
			}
			// Everything after the delimiter is positional, even flag-looking text.
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			if out.command == "" {
				if _, ok := nativeJournalCommands[arg]; !ok {
					path = append(path, ":command")
					break
				}
				out.command = arg
				path = append(path, arg)
				subcommands = nativeJournalCommands[arg]
				commandDone = subcommands == ""
			} else if out.command == "api" && endpoint == "" {
				endpoint = arg
			} else if !commandDone {
				if slices.Contains(strings.Fields(subcommands), arg) {
					path = append(path, arg)
				} else {
					path = append(path, ":command")
				}
				subcommands = nativeJournalCommands[strings.Join(path[1:], " ")]
				commandDone = subcommands == ""
			}
			continue
		}
		name, value, assigned := strings.Cut(arg, "=")
		if !strings.HasPrefix(arg, "--") && len(arg) > 2 {
			// API's Boolean -i can precede a value shorthand, e.g. -iHAccept:...
			if out.command == "api" {
				for strings.HasPrefix(arg, "-i") && len(arg) > 2 && arg[2] != '=' {
					flags = append(flags, "--include")
					out.include = true
					arg = "-" + arg[2:]
				}
			}
			name = arg[:2]
			value, assigned = strings.TrimPrefix(arg[2:], "="), len(arg) > 2
		}
		canonical, takesValue, known := journalFlagSpec(out.command, name)
		// Read grammar owns shorthand meanings such as -t (template vs title).
		if len(path) == 3 {
			if spec, ok := topReadSpecs(strings.Join(path[1:], " "))[name]; ok {
				canonical, takesValue, known = spec.name, spec.kind != readBool, true
			}
		}
		if len(path) == 3 && path[1] == "workflow" && path[2] == "run" && canonical == "--json" {
			takesValue = false
		}
		if !known {
			flags = append(flags, "--unknown")
			break // unknown ownership must not turn a value into a flag or command
		}
		if takesValue && !assigned {
			i++
			if i < len(args) {
				value = args[i]
			}
		}
		flag := canonical
		if canonical == "--json" && takesValue {
			flag += "=" + journalJSONFields(value)
		}
		flags = append(flags, flag)
		if out.command == "api" {
			switch canonical {
			case "--method":
				method = strings.ToUpper(value)
			case "--include":
				out.include = !assigned || value == "true" || value == "1" || value == "t" || value == "TRUE" || value == "True" || value == "T"
			case "--input":
				body = true
			case "--field", "--raw-field":
				body = true
				if text, ok := strings.CutPrefix(value, "query="); ok {
					query = text
				}
			}
		}
	}
	if out.command == "api" {
		apiPath := journalAPIPath(endpoint)
		isGraphQL := apiPath == "/graphql"
		out.graphql = &isGraphQL
		if method == "" {
			method = "GET"
			if body || isGraphQL {
				method = "POST"
			}
		}
		if !slices.Contains([]string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}, method) {
			method = ":method"
		}
		out.method = method
		out.write = method != "GET" && method != "HEAD" && method != ":method"
		if isGraphQL {
			operation, mutation := journalGraphQLOperation(query)
			path = append(path, method, operation)
			out.write = mutation
		} else {
			path = append(path, method, apiPath)
		}
	} else {
		if delegatedGHUsesGraphQL(args) || len(path) == 3 && path[1] == "auth" && path[2] == "status" {
			uses := true
			out.graphql = &uses
		}
		if len(path) >= 3 {
			out.write = slices.Contains(strings.Fields("add archive cancel close comment copy create delete delete-asset disable edit enable fork import install item-add item-archive item-create item-delete item-edit label link lock login logout mark-template merge pin ready rebuild refresh remove rename reopen rerun review run set stop sync transfer unarchive unlink unlock unpin upgrade upload"), path[len(path)-1])
		}
	}
	slices.Sort(flags)
	flags = slices.Compact(flags)
	out.text = strings.Join(append(path, flags...), " ")
	if len(out.text) > 8192 {
		out.text = out.text[:8192]
	}
	return out
}

func (shape nativeShape) category(args []string) string {
	if shape.write {
		return "write"
	}
	if shape.include {
		return "include"
	}
	if nativeReadRoutingNotice(args) == ghNativeJSONNotice {
		return "native-json-fields"
	}
	if shape.graphql != nil && *shape.graphql {
		return "graphql-delegated"
	}
	return "unsupported-command"
}

func journalJSONFields(value string) string {
	fields := []string{}
	for _, field := range strings.SplitN(value, ",", 128) {
		known := false
		for _, allowed := range []map[string]bool{supportedPRFields, supportedIssueFields, supportedRepoFields, supportedRunViewFields, supportedReleaseFields, supportedCheckRunFields, supportedWorkflowFields, supportedLabelFields, supportedGistFields} {
			known = known || allowed[field]
		}
		known = known || slices.Contains(strings.Fields("mergeStateStatus reviewDecision reviewRequests latestReviews potentialMergeCommit isInMergeQueue isMergeQueueEnabled licenseInfo assets participants reactionGroups totalCount viewerCanUpdate viewerDidAuthor viewerSubscription viewerCanAdminister viewerCanDelete viewerCanReact closed diskUsage forkCount homepageUrl isArchived isEmpty isFork isTemplate languages parent primaryLanguage projects projectItems repositoryTopics sshUrl stargazerCount watchers"), field)
		if !known {
			field = ":field"
		}
		fields = append(fields, field)
	}
	slices.Sort(fields)
	return strings.Join(slices.Compact(fields), ",")
}

var journalOperationPattern = regexp.MustCompile(`^\s*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z_0-9]{0,79})\s*[(\{@]`)

func journalGraphQLOperation(query string) (string, bool) {
	// Do not read query files, stdin, variables, aliases, or operationName values.
	for {
		query = strings.TrimLeft(query, " \t\r\n,\ufeff")
		if !strings.HasPrefix(query, "#") {
			break
		}
		_, rest, ok := strings.Cut(query, "\n")
		if !ok {
			return "graphql", false
		}
		query = rest
	}
	match := journalOperationPattern.FindStringSubmatch(query)
	mutation := strings.HasPrefix(strings.TrimSpace(query), "mutation")
	if len(match) == 0 {
		return "graphql", mutation
	}
	lower := strings.ToLower(match[2])
	for _, prefix := range []string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk_", "token_", "secret_"} {
		if strings.HasPrefix(lower, prefix) {
			return "graphql", mutation
		}
	}
	return "graphql:" + match[2], mutation
}

var journalRouteTemplates = strings.Fields(`
/repos/:owner/:repo/pulls/:number/reviews/:id/comments
/repos/:owner/:repo/pulls/:number/requested_reviewers
/repos/:owner/:repo/pulls/:number/files /repos/:owner/:repo/pulls/:number/commits
/repos/:owner/:repo/pulls/:number/comments /repos/:owner/:repo/pulls/:number/merge
/repos/:owner/:repo/pulls/comments/:id/reactions
/repos/:owner/:repo/issues/:number/comments /repos/:owner/:repo/issues/:number/labels
/repos/:owner/:repo/issues/:number/reactions /repos/:owner/:repo/issues/:number/events
/repos/:owner/:repo/issues/comments/:id/reactions
/repos/:owner/:repo/actions/runs/:id/attempts/:number/jobs
/repos/:owner/:repo/actions/runs/:id/jobs /repos/:owner/:repo/actions/runs/:id/logs
/repos/:owner/:repo/actions/runs/:id/rerun /repos/:owner/:repo/actions/runs/:id/rerun-failed-jobs
/repos/:owner/:repo/actions/jobs/:id/logs /repos/:owner/:repo/actions/workflows/:id/runs
/repos/:owner/:repo/commits/:id/check-runs /repos/:owner/:repo/commits/:id/status
/repos/:owner/:repo/check-runs/:id /repos/:owner/:repo/check-suites/:id
/repos/:owner/:repo/releases/tags/:id /repos/:owner/:repo/releases/assets/:id
/repos/:owner/:repo/releases/:id/assets /repos/:owner/:repo/branches/:id/protection
/repos/:owner/:repo/rulesets/:id /repos/:owner/:repo/rules/branches/:id
/repos/:owner/:repo/contents /repos/:owner/:repo/compare/:id /repos/:owner/:repo/labels/:id
/repos/:owner/:repo/git/refs /repos/:owner/:repo/git/trees/:id /repos/:owner/:repo/readme
/user/repos /user/orgs /user /users/:id/repos /users/:id /orgs/:id/repos /orgs/:id
/search/issues /search/repositories /search/code /search/commits /gists/:id
/rate_limit /notifications /graphql /meta /emojis
`)

func journalAPIPath(endpoint string) string {
	if strings.Contains(endpoint, "://") {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return "/:segment"
		}
		endpoint = parsed.EscapedPath()
	}
	endpoint, _, _ = strings.Cut(endpoint, "?")
	endpoint, _, _ = strings.Cut(endpoint, "#")
	segments := strings.Split(strings.Trim(endpoint, "/"), "/")
	if len(segments) > 16 {
		segments = segments[:16]
	}
	best := []string{}
	for _, template := range journalRouteTemplates {
		parts := strings.Split(strings.TrimPrefix(template, "/"), "/")
		matched := 0
		for matched < len(parts) && matched < len(segments) {
			if parts[matched] != segments[matched] && !strings.HasPrefix(parts[matched], ":") {
				break
			}
			matched++
		}
		if matched > len(best) {
			best = parts[:matched]
		}
	}
	result := append([]string(nil), best...)
	for len(result) < len(segments) {
		result = append(result, ":segment")
	}
	return "/" + strings.Join(result, "/")
}
