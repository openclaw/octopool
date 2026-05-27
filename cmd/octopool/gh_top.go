package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type ghTopOptions struct {
	repo        string
	json        []string
	jq          string
	patch       bool
	limit       string
	limitSet    bool
	state       string
	branch      string
	workflow    string
	status      string
	author      string
	assignee    string
	labels      []string
	positionals []string
}

func runGHTopLevel(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) < 2 {
		return false, nil
	}
	switch args[0] {
	case "pr":
		return runGHPR(ctx, args[1:], stdout)
	case "issue":
		return runGHIssue(ctx, args[1:], stdout)
	case "run":
		return runGHRun(ctx, args[1:], stdout)
	case "repo":
		return runGHRepo(ctx, args[1:], stdout)
	case "release":
		return runGHRelease(ctx, args[1:], stdout)
	default:
		return false, nil
	}
}

func runGHPR(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "view":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedPRFields) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "pulls", number)}, opts, fieldMapPR)
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedPRListFields) || !supportedPRListState(opts.state) || limitOverOnePage(opts) || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 {
			return false, nil
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "pulls"), query: query}, opts, fieldMapPR)
	case "diff":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiersExceptPatch(opts) || machineReadable(opts) || opts.jq != "" {
			return false, nil
		}
		accept := "application/vnd.github.v3.diff"
		if opts.patch {
			accept = "application/vnd.github.v3.patch"
		}
		request := ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls", number),
			headers: map[string]string{"accept": accept},
		}
		return true, relayTop(ctx, stdout, request, ghTopOptions{}, nil)
	case "checks":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedCheckRunFields) {
			return false, nil
		}
		return true, relayPRChecks(ctx, stdout, repo, number, opts)
	default:
		return false, nil
	}
}

func runGHIssue(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "view":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedIssueFields) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "issues", number)}, opts, fieldMapIssue)
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedIssueFields) || limitOverOnePage(opts) || hasCurrentUserFilter(opts) {
			return false, nil
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		if opts.author != "" {
			query["creator"] = opts.author
		}
		if opts.assignee != "" {
			query["assignee"] = opts.assignee
		}
		if len(opts.labels) > 0 {
			query["labels"] = strings.Join(opts.labels, ",")
		}
		return true, relayIssueList(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "issues"), query: query}, opts)
	default:
		return false, nil
	}
}

func runGHRun(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "list":
		repo, ok := repoOnly(opts)
		if !ok {
			return false, nil
		}
		query := listQueryDefault(opts, 20)
		if opts.branch != "" {
			query["branch"] = opts.branch
		}
		if opts.status != "" {
			query["status"] = opts.status
		}
		path := repoPath(repo, "actions", "runs")
		if opts.workflow != "" {
			if !supportedWorkflowRef(opts.workflow) {
				return false, nil
			}
			path = repoPath(repo, "actions", "workflows", opts.workflow, "runs")
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedRunFields) || limitOverOnePage(opts) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: path, query: query}, opts, fieldMapRun)
	case "view":
		if len(opts.positionals) != 1 || !isDigits(opts.positionals[0]) || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRunFields) {
			return false, nil
		}
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok || !localAllowedRelayOwner(strings.Split(repo, "/")[0]) {
			return false, nil
		}
		return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "actions", "runs", opts.positionals[0])}, opts, fieldMapRun)
	default:
		return false, nil
	}
}

func runGHRepo(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	if args[0] != "view" || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) {
		return false, nil
	}
	if opts.repo == "" && len(opts.positionals) == 1 {
		opts.repo = opts.positionals[0]
		opts.positionals = nil
	}
	repo, ok := repoOnly(opts)
	if !ok {
		return false, nil
	}
	return true, relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo)}, opts, fieldMapRepo)
}

func runGHRelease(ctx context.Context, args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	opts, fallback, err := parseGHTopOptions(args[1:])
	if err != nil || fallback {
		return !fallback, err
	}
	if topJQFallback(opts) {
		return false, nil
	}
	switch args[0] {
	case "list":
		return false, nil
	case "view":
		return false, nil
	default:
		return false, nil
	}
}

func parseGHTopOptions(args []string) (ghTopOptions, bool, error) {
	opts := ghTopOptions{limit: "30"}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		valueFlag := func(name string) (string, bool, error) {
			if arg == name {
				index++
				if index >= len(args) {
					return "", false, fmt.Errorf("%s requires a value", name)
				}
				return args[index], true, nil
			}
			if strings.HasPrefix(arg, name+"=") {
				return strings.TrimPrefix(arg, name+"="), true, nil
			}
			return "", false, nil
		}
		for _, item := range []struct {
			name string
			set  func(string)
		}{
			{"-R", func(value string) { opts.repo = value }},
			{"--repo", func(value string) { opts.repo = value }},
			{"--json", func(value string) { opts.json = splitFields(value) }},
			{"--jq", func(value string) { opts.jq = value }},
			{"-q", func(value string) { opts.jq = value }},
			{"--limit", func(value string) { opts.limit = value; opts.limitSet = true }},
			{"-L", func(value string) { opts.limit = value; opts.limitSet = true }},
			{"--state", func(value string) { opts.state = value }},
			{"--branch", func(value string) { opts.branch = value }},
			{"--workflow", func(value string) { opts.workflow = value }},
			{"--status", func(value string) { opts.status = value }},
			{"--author", func(value string) { opts.author = value }},
			{"--assignee", func(value string) { opts.assignee = value }},
			{"--label", func(value string) { opts.labels = append(opts.labels, value) }},
		} {
			value, ok, err := valueFlag(item.name)
			if err != nil {
				return opts, false, err
			}
			if ok {
				item.set(value)
				goto nextArg
			}
		}
		switch arg {
		case "--patch":
			opts.patch = true
		case "--web", "--comments", "--template", "--paginate", "--slurp":
			return opts, true, nil
		default:
			if strings.HasPrefix(arg, "-") && arg != "--patch" {
				return opts, true, nil
			}
			opts.positionals = append(opts.positionals, arg)
		}
	nextArg:
	}
	return opts, false, nil
}

func relayTop(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions, fieldMap map[string][]string) error {
	if request.query == nil {
		request.query = map[string]any{}
	}
	if request.headers == nil {
		request.headers = map[string]string{}
	}
	if !safeRelayRequest(request) {
		return errors.New("internal error: top-level gh command built an unsupported relay request")
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return err
	}
	if len(opts.json) == 0 {
		return writeGHBody(ctx, stdout, envelope, opts.jq)
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(body, opts.json, fieldMap)
	if err != nil {
		return err
	}
	if opts.jq != "" {
		return writeBytes(ctx, stdout, filtered, opts.jq)
	}
	return writeBytes(ctx, stdout, filtered, "")
}

func relayPRChecks(ctx context.Context, stdout io.Writer, repo string, number string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	liveHeaders := map[string]string{"if-none-match": `"octopool-live"`}
	prEnvelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "pulls", number),
		headers: liveHeaders,
	})
	if err != nil {
		return err
	}
	prBody, err := envelopeBodyBytes(prEnvelope)
	if err != nil {
		return err
	}
	var pr map[string]any
	if err := json.Unmarshal(prBody, &pr); err != nil {
		return err
	}
	sha, ok := nestedString(pr, "head", "sha")
	if !ok || sha == "" {
		return errors.New("pull request response did not include head.sha")
	}
	checkRuns := []any{}
	totalCheckRuns := 0
	for page := 1; page <= 10; page++ {
		request := ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "commits", sha, "check-runs"),
			query:   map[string]any{"per_page": "100", "page": strconv.Itoa(page)},
			headers: liveHeaders,
		}
		checkRunsEnvelope, err := client.do(ctx, request)
		if err != nil {
			return err
		}
		items, total, err := checkRunItems(checkRunsEnvelope)
		if err != nil {
			return err
		}
		if page == 1 {
			totalCheckRuns = total
		}
		checkRuns = append(checkRuns, items...)
		if len(checkRuns) >= totalCheckRuns || len(items) < 100 {
			break
		}
	}
	statusEnvelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "commits", sha, "status"),
		headers: liveHeaders,
	})
	if err != nil {
		return err
	}
	statuses, err := statusItems(statusEnvelope)
	if err != nil {
		return err
	}
	items := ghCheckItems(append(checkRuns, statuses...))
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapCheckRun)
		if err != nil {
			return err
		}
	}
	if err := writeBytes(ctx, stdout, raw, opts.jq); err != nil {
		return err
	}
	return checkExitCode(items)
}

func relayIssueList(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	limit := desiredLimit(opts)
	perPage := 100
	filtered := make([]map[string]any, 0, limit)
	for page := 1; page <= 10 && len(filtered) < limit; page++ {
		paged := request
		paged.query = cloneQuery(request.query)
		paged.query["per_page"] = strconv.Itoa(perPage)
		paged.query["page"] = strconv.Itoa(page)
		envelope, err := client.do(ctx, paged)
		if err != nil {
			return err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return err
		}
		var items []map[string]any
		if err := json.Unmarshal(body, &items); err != nil {
			return err
		}
		for _, item := range items {
			if _, ok := item["pull_request"]; !ok {
				filtered = append(filtered, item)
				if len(filtered) >= limit {
					break
				}
			}
		}
		if len(items) < perPage {
			break
		}
	}
	raw, err := json.Marshal(filtered)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapIssue)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func checkRunItems(envelope relayEnvelope) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	items, ok := response["check_runs"].([]any)
	if !ok {
		return nil, 0, errors.New("check-runs response did not include check_runs")
	}
	total := len(items)
	if value, ok := response["total_count"].(float64); ok {
		total = int(value)
	}
	return items, total, nil
}

func statusItems(envelope relayEnvelope) ([]any, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	rawItems, ok := response["statuses"].([]any)
	if !ok {
		return nil, errors.New("status response did not include statuses")
	}
	items := make([]any, 0, len(rawItems))
	for _, raw := range rawItems {
		status, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state, _ := status["state"].(string)
		displayStatus := "completed"
		if strings.EqualFold(state, "pending") {
			displayStatus = "pending"
		}
		item := map[string]any{
			"name":         status["context"],
			"context":      status["context"],
			"status":       displayStatus,
			"conclusion":   status["state"],
			"details_url":  status["target_url"],
			"started_at":   status["created_at"],
			"completed_at": status["updated_at"],
		}
		items = append(items, item)
	}
	return items, nil
}

func ghCheckItems(items []any) []any {
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		state := ghCheckState(item)
		out = append(out, map[string]any{
			"bucket":      ghCheckBucket(state),
			"completedAt": firstString(item, "completed_at", "completedAt"),
			"description": ghCheckDescription(item),
			"event":       nestedStringValue(item, "check_suite", "event"),
			"link":        firstString(item, "details_url", "target_url", "link"),
			"name":        firstString(item, "name", "context"),
			"startedAt":   firstString(item, "started_at", "created_at", "startedAt"),
			"state":       state,
			"workflow":    ghCheckWorkflow(item),
		})
	}
	return out
}

func ghCheckState(item map[string]any) string {
	status := strings.ToLower(firstString(item, "status"))
	conclusion := strings.ToLower(firstString(item, "conclusion"))
	if status != "" && status != "completed" {
		return strings.ToUpper(status)
	}
	if conclusion == "" {
		return strings.ToUpper(status)
	}
	return strings.ToUpper(conclusion)
}

func ghCheckBucket(state string) string {
	switch strings.ToLower(state) {
	case "success", "neutral":
		return "pass"
	case "failure", "error", "timed_out", "action_required":
		return "fail"
	case "cancelled":
		return "cancel"
	case "skipped":
		return "skipping"
	default:
		return "pending"
	}
}

func ghCheckDescription(item map[string]any) string {
	if description := firstString(item, "description"); description != "" {
		return description
	}
	return nestedStringValue(item, "output", "summary")
}

func ghCheckWorkflow(item map[string]any) string {
	if workflow := firstString(item, "workflow"); workflow != "" {
		return workflow
	}
	return nestedStringValue(item, "check_suite", "workflow_name")
}

func firstString(item map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key].(string); ok {
			return value
		}
	}
	return ""
}

func nestedStringValue(item map[string]any, path ...string) string {
	value, ok := valueAtPath(item, path...)
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}

func checkExitCode(items []any) error {
	exitCode := 0
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		bucket, _ := item["bucket"].(string)
		state, _ := item["state"].(string)
		switch strings.ToLower(bucket) {
		case "fail", "cancel":
			exitCode = 1
		case "pending":
			if exitCode == 0 {
				exitCode = 8
			}
		}
		if bucket == "" && strings.ToLower(state) != "success" && strings.ToLower(state) != "neutral" && exitCode == 0 {
			exitCode = 8
		}
	}
	if exitCode != 0 {
		return exitCodeError{Code: exitCode}
	}
	return nil
}

func writeBytes(ctx context.Context, stdout io.Writer, data []byte, jq string) error {
	if jq != "" {
		return runJQ(ctx, stdout, data, jq)
	}
	_, err := stdout.Write(data)
	if len(data) > 0 && !bytes.HasSuffix(data, []byte("\n")) {
		_, _ = fmt.Fprintln(stdout)
	}
	return err
}

func topJQFallback(opts ghTopOptions) bool {
	return opts.jq != "" && !jqAvailable()
}

func supportedPRListState(state string) bool {
	switch state {
	case "", "open", "all":
		return true
	default:
		return false
	}
}

func machineReadable(opts ghTopOptions) bool {
	return len(opts.json) > 0
}

func hasTopModifiers(opts ghTopOptions) bool {
	return opts.patch ||
		opts.limitSet ||
		opts.state != "" ||
		opts.branch != "" ||
		opts.workflow != "" ||
		opts.status != "" ||
		opts.author != "" ||
		opts.assignee != "" ||
		len(opts.labels) > 0
}

func hasTopModifiersExceptPatch(opts ghTopOptions) bool {
	opts.patch = false
	return hasTopModifiers(opts)
}

func hasCurrentUserFilter(opts ghTopOptions) bool {
	return opts.author == "@me" || opts.assignee == "@me"
}

func supportedWorkflowRef(ref string) bool {
	lower := strings.ToLower(ref)
	return isDigits(ref) || strings.HasSuffix(lower, ".yml") || strings.HasSuffix(lower, ".yaml")
}

func supportedJSONFields(opts ghTopOptions, supported map[string]bool) bool {
	for _, field := range opts.json {
		if !supported[field] {
			return false
		}
	}
	return true
}

func envelopeBodyBytes(envelope relayEnvelope) ([]byte, error) {
	var out bytes.Buffer
	if err := writeGHBody(context.Background(), &out, envelope, ""); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(out.Bytes()), nil
}

func filterJSONFields(raw []byte, fields []string, fieldMap map[string][]string) ([]byte, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	filtered := filterJSONValue(value, fields, fieldMap)
	return json.Marshal(filtered)
}

func filterJSONValue(value any, fields []string, fieldMap map[string][]string) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, filterJSONValue(item, fields, fieldMap))
		}
		return out
	case map[string]any:
		if runs, ok := typed["workflow_runs"].([]any); ok {
			return filterJSONValue(runs, fields, fieldMap)
		}
		if checks, ok := typed["check_runs"].([]any); ok {
			return filterJSONValue(checks, fields, fieldMap)
		}
		out := map[string]any{}
		for _, field := range fields {
			if value, ok := mappedValue(typed, field, fieldMap); ok {
				out[field] = value
			}
		}
		return out
	default:
		return value
	}
}

func mappedValue(input map[string]any, field string, fieldMap map[string][]string) (any, bool) {
	paths := [][]string{{field}}
	if mapped := fieldMap[field]; len(mapped) > 0 {
		paths = append([][]string{mapped}, paths...)
	}
	for _, path := range paths {
		if value, ok := valueAtPath(input, path...); ok {
			if field == "defaultBranchRef" {
				if name, ok := value.(string); ok {
					return map[string]any{"name": name}, true
				}
			}
			return value, true
		}
	}
	return nil, false
}

func valueAtPath(input map[string]any, path ...string) (any, bool) {
	var value any = input
	for _, part := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return value, true
}

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
	if repo == "" || number == "" || !localAllowedRelayOwner(strings.Split(repo, "/")[0]) {
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
	if repo == "" || !localAllowedRelayOwner(strings.Split(repo, "/")[0]) {
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

func normalizeRepo(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	raw = strings.TrimSuffix(raw, ".git")
	if strings.HasPrefix(raw, "git@github.com:") {
		raw = strings.TrimPrefix(raw, "git@github.com:")
	}
	if strings.HasPrefix(raw, "https://github.com/") {
		raw = strings.TrimPrefix(raw, "https://github.com/")
	}
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

func listQuery(opts ghTopOptions) map[string]any {
	return listQueryDefault(opts, 30)
}

func listQueryDefault(opts ghTopOptions, defaultLimit int) map[string]any {
	return map[string]any{"per_page": strconv.Itoa(desiredLimitDefault(opts, defaultLimit))}
}

func desiredLimit(opts ghTopOptions) int {
	return desiredLimitDefault(opts, 30)
}

func desiredLimitDefault(opts ghTopOptions, defaultLimit int) int {
	perPage := "30"
	if !opts.limitSet {
		perPage = strconv.Itoa(defaultLimit)
	}
	if opts.limitSet {
		limit, err := strconv.Atoi(opts.limit)
		if err != nil {
			value, _ := strconv.Atoi(perPage)
			return value
		}
		if limit < 1 {
			perPage = "1"
		} else if limit > 100 {
			perPage = "100"
		} else {
			perPage = strconv.Itoa(limit)
		}
	}
	value, _ := strconv.Atoi(perPage)
	return value
}

func limitOverOnePage(opts ghTopOptions) bool {
	limit, err := strconv.Atoi(opts.limit)
	return err == nil && limit > 100
}

func cloneQuery(input map[string]any) map[string]any {
	out := make(map[string]any, len(input)+2)
	for key, value := range input {
		out[key] = value
	}
	return out
}

func splitFields(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' '
	})
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func isDigits(raw string) bool {
	return regexp.MustCompile(`^[0-9]+$`).MatchString(raw)
}

func nestedString(input map[string]any, path ...string) (string, bool) {
	value, ok := valueAtPath(input, path...)
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

var fieldMapPR = map[string][]string{
	"url":          {"html_url"},
	"author":       {"user"},
	"createdAt":    {"created_at"},
	"updatedAt":    {"updated_at"},
	"closedAt":     {"closed_at"},
	"mergedAt":     {"merged_at"},
	"headRefName":  {"head", "ref"},
	"headRefOid":   {"head", "sha"},
	"baseRefName":  {"base", "ref"},
	"baseRefOid":   {"base", "sha"},
	"isDraft":      {"draft"},
	"changedFiles": {"changed_files"},
}

var fieldMapIssue = map[string][]string{
	"url":       {"html_url"},
	"author":    {"user"},
	"createdAt": {"created_at"},
	"updatedAt": {"updated_at"},
	"closedAt":  {"closed_at"},
}

var fieldMapRun = map[string][]string{
	"databaseId":   {"id"},
	"workflowName": {"name"},
	"url":          {"html_url"},
	"headBranch":   {"head_branch"},
	"headSha":      {"head_sha"},
	"createdAt":    {"created_at"},
	"updatedAt":    {"updated_at"},
}

var fieldMapRepo = map[string][]string{
	"nameWithOwner":    {"full_name"},
	"url":              {"html_url"},
	"isPrivate":        {"private"},
	"defaultBranchRef": {"default_branch"},
	"createdAt":        {"created_at"},
	"updatedAt":        {"updated_at"},
	"pushedAt":         {"pushed_at"},
}

var fieldMapRelease = map[string][]string{
	"tagName":      {"tag_name"},
	"url":          {"html_url"},
	"isDraft":      {"draft"},
	"isPrerelease": {"prerelease"},
	"createdAt":    {"created_at"},
	"publishedAt":  {"published_at"},
}

var fieldMapCheckRun = map[string][]string{
	"databaseId":  {"id"},
	"detailsUrl":  {"details_url"},
	"startedAt":   {"started_at"},
	"completedAt": {"completed_at"},
}

var supportedPRFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"mergedAt", "headRefName", "headRefOid", "baseRefName", "baseRefOid", "isDraft", "labels",
	"additions", "deletions", "changedFiles", "mergeable", "merged",
)

var supportedPRListFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"mergedAt", "headRefName", "headRefOid", "baseRefName", "baseRefOid", "isDraft", "labels",
)

var supportedIssueFields = supportedFields(
	"number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "closedAt",
	"labels", "assignees", "milestone",
)

var supportedRunFields = supportedFields(
	"databaseId", "id", "name", "workflowName", "status", "conclusion", "url", "headBranch",
	"headSha", "event", "createdAt", "updatedAt", "display_title",
)

var supportedRepoFields = supportedFields(
	"name", "full_name", "nameWithOwner", "url", "isPrivate", "defaultBranchRef", "description",
	"visibility", "stargazers_count", "forks_count", "open_issues_count", "createdAt", "updatedAt",
	"pushedAt",
)

var supportedReleaseFields = supportedFields(
	"id", "tagName", "name", "url", "isDraft", "isPrerelease", "createdAt", "publishedAt", "body",
)

var supportedCheckRunFields = supportedFields(
	"bucket", "completedAt", "description", "event", "link", "name", "startedAt", "state", "workflow",
)

func supportedFields(fields ...string) map[string]bool {
	out := make(map[string]bool, len(fields))
	for _, field := range fields {
		out[field] = true
	}
	return out
}
