package main

import (
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type rewriteAPIOptions struct {
	endpoint string
	method   string
	input    string
	inputSet bool
	fields   []rewriteFlag
	output   []string
	headers  map[string]string
}

func parseRewriteAPI(args []string) (rewriteAPIOptions, error) {
	result := rewriteAPIOptions{headers: map[string]string{}}
	seen := map[string]bool{}
	values := rewriteFlagNames("--method,-X --input --field,-F --raw-field,-f --header,-H --jq,-q")
	booleans := rewriteFlagNames("--include,-i --silent --paginate --slurp")
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			if result.endpoint != "" {
				return result, errRewriteBlocked
			}
			result.endpoint = arg
			continue
		}
		// Parse one flag while retaining repeated field and header occurrences.
		name, _, equal := strings.Cut(arg, "=")
		if !strings.HasPrefix(name, "--") && len(name) > 2 {
			name = name[:2]
			equal = true
		}
		count := 1
		if _, ok := values[name]; ok && !equal {
			count = 2
		}
		if i+count > len(args) {
			return result, errRewriteBlocked
		}
		parsed, err := parseRewriteFlags(args[i:i+count], values, booleans)
		if err != nil || len(parsed.ordered) != 1 {
			return result, errRewriteUnsupported
		}
		flag := parsed.ordered[0]
		i += count - 1
		if flag.name != "--field" && flag.name != "--raw-field" && flag.name != "--header" {
			if seen[flag.name] {
				return result, errRewriteBlocked
			}
			seen[flag.name] = true
		}
		switch flag.name {
		case "--method":
			if flag.value == "" {
				return result, errRewriteBlocked
			}
			result.method = strings.ToUpper(flag.value)
		case "--input":
			if flag.value == "" {
				return result, errRewriteBlocked
			}
			result.input = flag.value
			result.inputSet = true
		case "--field", "--raw-field":
			result.fields = append(result.fields, flag)
		case "--header":
			key, value, ok := strings.Cut(flag.value, ":")
			key = strings.ToLower(strings.TrimSpace(key))
			value = strings.TrimSpace(value)
			if !ok || !safeRelayHeader(key) {
				return result, errRewriteBlocked
			}
			if _, exists := result.headers[key]; exists {
				return result, errRewriteBlocked
			}
			result.headers[key] = value
			result.output = append(result.output, "--header="+key+": "+value)
		default:
			result.output = append(result.output, flag.name+"="+flag.value)
		}
	}
	if result.endpoint == "" {
		return result, errRewriteBlocked
	}
	if result.method == "" {
		result.method = "GET"
		if len(result.fields) > 0 || result.inputSet {
			result.method = "POST"
		}
	}
	if result.inputSet && len(result.fields) > 0 {
		return result, errRewriteBlocked
	}
	return result, nil
}

func prepareRewriteAPI(policy stringRewritePolicy, args []string, stdin io.Reader, prepared *rewritePreparation) error {
	opts, err := parseRewriteAPI(args[1:])
	if err != nil {
		return err
	}
	request, err := rewriteAPIRequest(opts)
	if err != nil {
		return err
	}
	if err := policy.guardRequest(request); err != nil {
		return err
	}
	if err := policy.checkStructural("github.com"); err != nil {
		return err
	}
	if opts.method == "GET" {
		if opts.inputSet || len(opts.fields) > 0 || !rewriteReadPath(request.path) {
			return errRewriteUnsupported
		}
		prepared.args = append([]string{"api", opts.endpoint, "--method=GET", "--hostname=github.com"}, opts.output...)
		prepared.stdin = strings.NewReader("")
		return nil
	}
	if opts.method != "POST" && opts.method != "PATCH" && opts.method != "PUT" {
		return errRewriteUnsupported
	}
	if len(request.query) > 0 {
		return errRewriteUnsupported
	}
	for _, flag := range opts.output {
		if strings.HasPrefix(flag, "--paginate") || strings.HasPrefix(flag, "--slurp") {
			return errRewriteUnsupported
		}
	}
	schema, err := rewriteMutationSchema(request.path, opts.method)
	if err != nil {
		return err
	}
	payload := map[string]any{}
	if len(opts.fields) > rewriteMaxRules {
		return errRewriteBlocked
	}
	snapshotBytes := 0
	if opts.inputSet {
		data, err := readRewriteFile(opts.input, stdin, rewriteMaxContent)
		if err != nil {
			return err
		}
		value, err := strictRewriteJSON(data, rewriteMaxContent)
		if err != nil {
			return errRewriteBlocked
		}
		var ok bool
		payload, ok = value.(map[string]any)
		if !ok {
			return errRewriteBlocked
		}
	} else {
		for _, field := range opts.fields {
			key, text, ok := strings.Cut(field.value, "=")
			if !ok || key == "" {
				return errRewriteBlocked
			}
			// Only the exact assignees[] shape has unambiguous array semantics.
			if strings.ContainsAny(key, "[]") {
				if schema != "assignees" || key != "assignees[]" || field.name != "--raw-field" || text == "" {
					return errRewriteBlocked
				}
				values, ok := payload["assignees"].([]any)
				if _, exists := payload["assignees"]; exists && !ok {
					return errRewriteBlocked
				}
				payload["assignees"] = append(values, text)
				snapshotBytes += len(key) + len(text)
				if snapshotBytes > rewriteMaxContent {
					return errRewriteBlocked
				}
				continue
			}
			if _, exists := payload[key]; exists {
				return errRewriteBlocked
			}
			var value any = text
			if field.name == "--field" {
				if strings.HasPrefix(text, "@") {
					data, err := readRewriteFile(text[1:], stdin, rewriteMaxContent)
					if err != nil {
						return err
					}
					value = string(data)
				} else {
					if strings.ContainsAny(text, "{}") {
						return errRewriteBlocked
					}
					switch text {
					case "true":
						value = true
					case "false":
						value = false
					case "null":
						value = nil
					default:
						if number, err := strconv.ParseInt(text, 10, 64); err == nil {
							value = json.Number(strconv.FormatInt(number, 10))
						}
					}
				}
			}
			payload[key] = value
			if text, ok := value.(string); ok {
				snapshotBytes += len(key) + len(text)
				if snapshotBytes > rewriteMaxContent {
					return errRewriteBlocked
				}
			}
		}
	}
	if err := rewriteAPIPayload(policy, prepared, payload, schema); err != nil {
		return err
	}
	encoded, err := json.Marshal(payload)
	if err != nil || len(encoded) > rewriteMaxContent {
		return errRewriteBlocked
	}
	// Marshal and decode again for the final structural/content scan, including
	// every nested string. Child gh only receives this immutable JSON snapshot.
	if err := checkRewriteJSONStrings(policy, payload); err != nil {
		return err
	}
	path, err := prepared.snapshot(encoded)
	if err != nil {
		return err
	}
	prepared.args = append([]string{"api", opts.endpoint, "--method=" + opts.method, "--hostname=github.com", "--input=" + path}, opts.output...)
	prepared.stdin = strings.NewReader("")
	if schema == "release-create" {
		tag := payload["tag_name"].(string)
		prepared.preflight = []string{"api", strings.TrimSuffix(request.path, "/releases") + "/git/ref/tags/" + url.PathEscape(tag), "--method=GET"}
	}
	return nil
}

func rewriteAPIRequest(opts rewriteAPIOptions) (ghAPIRequest, error) {
	// Native gh expands placeholders anywhere in the original endpoint, including
	// query keys/values and embedded legacy :branch forms, after this guard runs.
	if rewriteEndpointPlaceholder.MatchString(opts.endpoint) {
		return ghAPIRequest{}, errRewriteBlocked
	}
	endpoint := opts.endpoint
	if !strings.HasPrefix(endpoint, "/") {
		endpoint = "/" + endpoint
	}
	path, rawQuery, _ := strings.Cut(endpoint, "?")
	request := ghAPIRequest{method: opts.method, path: path, headers: opts.headers, query: map[string]any{}}
	if !safeRelayPath(path) || strings.ContainsAny(path, "{}") || strings.Contains(path, "//") {
		return request, errRewriteBlocked
	}
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return request, errRewriteBlocked
	}
	for key, values := range query {
		if len(values) != 1 {
			return request, errRewriteBlocked
		}
		request.query[key] = values[0]
	}
	return request, nil
}

var rewriteEndpointPlaceholder = regexp.MustCompile(`(:(owner|repo|branch)\b|\{[a-z]+\})`)

var rewriteMutationPath = regexp.MustCompile(`^/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(.+)$`)
var rewriteIssueNumber = regexp.MustCompile(`^issues/[0-9]+$`)
var rewriteCommentCreate = regexp.MustCompile(`^issues/[0-9]+/comments$`)
var rewriteCommentEdit = regexp.MustCompile(`^(issues|pulls)/comments/[0-9]+$`)
var rewritePullNumber = regexp.MustCompile(`^pulls/[0-9]+$`)
var rewritePullMerge = regexp.MustCompile(`^pulls/[0-9]+/merge$`)
var rewriteReviewCreate = regexp.MustCompile(`^pulls/[0-9]+/reviews$`)
var rewriteReviewEdit = regexp.MustCompile(`^pulls/[0-9]+/reviews/[0-9]+$`)
var rewriteReleaseNumber = regexp.MustCompile(`^releases/[0-9]+$`)
var rewriteAssignees = regexp.MustCompile(`^issues/[0-9]+/assignees$`)

func rewriteMutationSchema(path, method string) (string, error) {
	match := rewriteMutationPath.FindStringSubmatch(path)
	if match == nil {
		return "", errRewriteUnsupported
	}
	tail := match[1]
	switch {
	case method == "POST" && tail == "issues":
		return "issue-create", nil
	case method == "POST" && tail == "pulls":
		return "pull-create", nil
	case method == "POST" && tail == "releases":
		return "release-create", nil
	case method == "PATCH" && rewriteIssueNumber.MatchString(tail):
		return "issue-edit", nil
	case method == "PATCH" && rewritePullNumber.MatchString(tail):
		return "pull-edit", nil
	case method == "PUT" && rewritePullMerge.MatchString(tail):
		return "pull-merge", nil
	case method == "POST" && rewriteCommentCreate.MatchString(tail):
		return "comment", nil
	case method == "PATCH" && rewriteCommentEdit.MatchString(tail):
		return "comment", nil
	case method == "POST" && rewriteReviewCreate.MatchString(tail):
		return "review", nil
	case method == "PUT" && rewriteReviewEdit.MatchString(tail):
		return "comment", nil
	case method == "PATCH" && rewriteReleaseNumber.MatchString(tail):
		return "release-edit", nil
	case method == "POST" && rewriteAssignees.MatchString(tail):
		return "assignees", nil
	}
	return "", errRewriteUnsupported
}

func rewriteAPIPayload(policy stringRewritePolicy, prepared *rewritePreparation, payload map[string]any, schema string) error {
	spec := "body:text"
	required := "body"
	switch schema {
	case "issue-create":
		spec = "title:text body:text labels:strings assignees:strings milestone:integer"
		required = "title body"
	case "issue-edit":
		spec = "title:text body:text"
		required = ""
	case "pull-create":
		spec = "title:text body:text head:string base:string draft:bool maintainer_can_modify:bool"
		required = "title body head base"
	case "pull-edit":
		spec = "title:text body:text"
		required = ""
	case "pull-merge":
		spec = "sha:string merge_method:squash commit_message:text"
		required = "sha merge_method"
	case "release-create":
		spec = "name:text body:text tag_name:string draft:bool prerelease:bool make_latest:string"
		required = "name body tag_name"
	case "release-edit":
		spec = "name:text body:text draft:bool prerelease:bool make_latest:string"
		required = ""
	case "review":
		spec = "body:text event:string commit_id:string comments:comments"
		required = "body event"
	case "review-comment":
		spec = "body:text path:string line:integer side:string start_line:integer start_side:string position:integer"
		required = "body path"
	case "assignees":
		spec = "assignees:strings"
		required = "assignees"
	}
	allowed := map[string]string{}
	for _, entry := range strings.Fields(spec) {
		key, kind, _ := strings.Cut(entry, ":")
		allowed[key] = kind
	}
	if len(payload) == 0 {
		return errRewriteBlocked
	}
	for _, key := range strings.Fields(required) {
		if _, ok := payload[key]; !ok {
			return errRewriteBlocked
		}
	}
	if schema == "review" {
		event, ok := payload["event"].(string)
		if !ok || (event != "APPROVE" && event != "COMMENT" && event != "REQUEST_CHANGES") {
			return errRewriteBlocked
		}
	}
	for key, value := range payload {
		if err := policy.checkStructural(key); err != nil {
			return err
		}
		switch allowed[key] {
		case "text":
			text, ok := value.(string)
			if !ok {
				return errRewriteBlocked
			}
			rewritten, err := prepared.text(policy, text)
			if err != nil {
				return err
			}
			if strings.HasSuffix(schema, "-create") && strings.TrimSpace(rewritten) == "" {
				return errRewriteBlocked
			}
			payload[key] = rewritten
		case "string":
			text, ok := value.(string)
			if !ok || text == "" || (schema == "pull-merge" && key == "sha" && !rewriteCommitSHA.MatchString(text)) {
				return errRewriteBlocked
			}
			if err := policy.checkStructural(text); err != nil {
				return err
			}
		case "squash":
			text, ok := value.(string)
			if !ok || text != "squash" {
				return errRewriteBlocked
			}
		case "strings":
			values, ok := value.([]any)
			if !ok {
				return errRewriteBlocked
			}
			for _, value := range values {
				text, ok := value.(string)
				if !ok || (schema == "assignees" && !rewriteGitHubLogin.MatchString(text)) {
					return errRewriteBlocked
				}
				if err := policy.checkStructural(text); err != nil {
					return err
				}
			}
		case "integer":
			if _, ok := rewriteInteger(value); !ok {
				return errRewriteBlocked
			}
		case "bool":
			if _, ok := value.(bool); !ok {
				return errRewriteBlocked
			}
		case "comments":
			values, ok := value.([]any)
			if !ok {
				return errRewriteBlocked
			}
			for _, value := range values {
				comment, ok := value.(map[string]any)
				if !ok {
					return errRewriteBlocked
				}
				if err := rewriteAPIPayload(policy, prepared, comment, "review-comment"); err != nil {
					return err
				}
			}
		default:
			return errRewriteBlocked
		}
	}
	return nil
}
func checkRewriteJSONStrings(policy stringRewritePolicy, value any) error {
	switch value := value.(type) {
	case string:
		if policy.containsRuleMaterial(value) {
			return errRewriteBlocked
		}
		return policy.check(value)
	case map[string]any:
		for key, item := range value {
			if policy.containsRuleMaterial(key) {
				return errRewriteBlocked
			}
			if err := policy.check(key); err != nil {
				return err
			}
			if err := checkRewriteJSONStrings(policy, item); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range value {
			if err := checkRewriteJSONStrings(policy, item); err != nil {
				return err
			}
		}
	}
	return nil
}
