package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

var stdoutIsTTY = func() bool {
	info, err := os.Stdout.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

var humanNow = time.Now

func nativeHumanFormat(opts ghTopOptions) bool {
	return !machineReadable(opts) && opts.jq == "" && !stdoutIsTTY()
}

func relayHumanPRView(ctx context.Context, stdout io.Writer, repo string, number string) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, ghAPIRequest{method: "GET", path: repoPath(repo, "pulls", number)})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var pr map[string]any
	if err := json.Unmarshal(body, &pr); err != nil {
		return err
	}
	reviews, err := relayPagedArray(ctx, client, repoPath(repo, "pulls", number, "reviews"), nil)
	if err != nil {
		return err
	}
	return renderHumanPRView(stdout, pr, reviews)
}

func humanPRState(pr map[string]any) string {
	if firstString(pr, "merged_at") != "" {
		return "MERGED"
	}
	state := strings.ToUpper(firstString(pr, "state"))
	if draft, _ := pr["draft"].(bool); draft && state == "OPEN" {
		return "DRAFT"
	}
	return state
}

func renderHumanPRView(stdout io.Writer, pr map[string]any, reviews []any) error {
	state := humanPRState(pr)
	autoMerge := "disabled"
	if value, ok := pr["auto_merge"]; ok && value != nil {
		autoMerge = "enabled"
	}
	lines := [][2]string{
		{"title", firstString(pr, "title")},
		{"state", state},
		{"author", nestedStringValue(pr, "user", "login")},
		{"labels", joinedObjectStrings(pr["labels"], "name")},
		{"assignees", joinedObjectStrings(pr["assignees"], "login")},
		{"reviewers", latestReviewers(reviews)},
		{"projects", ""},
		{"milestone", nestedStringValue(pr, "milestone", "title")},
		{"number", numberText(pr["number"])},
		{"url", firstString(pr, "html_url")},
		{"additions", numberText(pr["additions"])},
		{"deletions", numberText(pr["deletions"])},
		{"auto-merge", autoMerge},
	}
	if err := writeHumanFields(stdout, lines); err != nil {
		return err
	}
	return writeHumanBody(stdout, firstString(pr, "body"))
}

func relayHumanPRList(ctx context.Context, stdout io.Writer, request ghAPIRequest) error {
	items, err := relayArray(ctx, request)
	if err != nil {
		return err
	}
	for _, item := range items {
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\t%s\n",
			watchSafeText(numberText(item["number"])),
			watchSafeText(firstString(item, "title")),
			watchSafeText(nestedStringValue(item, "head", "ref")),
			watchSafeText(humanPRState(item)),
			iso8601UTC(firstString(item, "updated_at")),
		); err != nil {
			return err
		}
	}
	return nil
}

func renderHumanPRChecks(stdout io.Writer, items []any) error {
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\t%s\n",
			watchSafeText(firstString(item, "name")),
			watchSafeText(firstString(item, "bucket")),
			humanDuration(firstString(item, "startedAt"), firstString(item, "completedAt")),
			watchSafeText(firstString(item, "link")),
			watchSafeText(firstString(item, "description")),
		); err != nil {
			return err
		}
	}
	return nil
}

func relayHumanRunList(ctx context.Context, stdout io.Writer, request ghAPIRequest) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	rawItems, ok := response["workflow_runs"].([]any)
	if !ok {
		return errors.New("workflow runs response did not include workflow_runs")
	}
	for _, raw := range rawItems {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			watchSafeText(firstString(item, "status")),
			watchSafeText(firstString(item, "conclusion")),
			watchSafeText(firstString(item, "display_title")),
			watchSafeText(firstString(item, "name")),
			watchSafeText(firstString(item, "head_branch")),
			watchSafeText(firstString(item, "event")),
			watchSafeText(numberText(item["id"])),
			humanDuration(firstString(item, "run_started_at", "created_at"), firstString(item, "updated_at")),
			iso8601UTC(firstString(item, "created_at")),
		); err != nil {
			return err
		}
	}
	return nil
}

func renderHumanRunView(stdout io.Writer, run map[string]any, jobs []any) error {
	id := numberText(run["id"])
	display := strings.TrimSpace(firstString(run, "head_branch") + " " + firstString(run, "name"))
	if display == "" {
		display = firstString(run, "display_title")
	}
	if _, err := fmt.Fprintf(stdout, "\n%s %s · %s\nTriggered via %s %s\n\nJOBS\n",
		runGlyph(run),
		watchSafeText(display),
		watchSafeText(id),
		watchSafeText(firstString(run, "event")),
		relativeHumanTime(firstString(run, "created_at")),
	); err != nil {
		return err
	}
	firstJobID := ""
	for _, raw := range jobs {
		job, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		jobID := numberText(job["databaseId"])
		if firstJobID == "" {
			firstJobID = jobID
		}
		duration := humanDuration(firstString(job, "startedAt"), firstString(job, "completedAt"))
		inDuration := ""
		if duration != "" {
			inDuration = " in " + duration
		}
		if _, err := fmt.Fprintf(stdout, "%s %s%s (ID %s)\n",
			jobGlyph(job),
			watchSafeText(firstString(job, "name")),
			inDuration,
			watchSafeText(jobID),
		); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(stdout); err != nil {
		return err
	}
	if firstJobID != "" {
		if _, err := fmt.Fprintf(stdout, "For more information about the job, try: gh run view --job=%s\n", watchSafeText(firstJobID)); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(stdout, "View this run on GitHub: %s\n", watchSafeText(firstString(run, "html_url")))
	return err
}

func relayHumanIssueView(ctx context.Context, stdout io.Writer, repo string, number string) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, ghAPIRequest{method: "GET", path: repoPath(repo, "issues", number)})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var issue map[string]any
	if err := json.Unmarshal(body, &issue); err != nil {
		return err
	}
	// REST /issues/{n} also returns pull requests; real gh refuses those, so
	// let it produce its canonical error instead of a plausible issue view.
	if _, isPR := issue["pull_request"]; isPR {
		return localFallbackError{Reason: "issue_number_is_pull_request"}
	}
	lines := [][2]string{
		{"title", firstString(issue, "title")},
		{"state", strings.ToUpper(firstString(issue, "state"))},
		{"author", nestedStringValue(issue, "user", "login")},
		{"labels", joinedObjectStrings(issue["labels"], "name")},
		{"comments", numberText(issue["comments"])},
		{"assignees", joinedObjectStrings(issue["assignees"], "login")},
		{"projects", ""},
		{"milestone", nestedStringValue(issue, "milestone", "title")},
		{"issue-type", ""},
		{"parent", ""},
		{"sub-issues", ""},
		{"sub-issues-completed", ""},
		{"blocked-by", ""},
		{"blocking", ""},
		{"number", numberText(issue["number"])},
	}
	if err := writeHumanFields(stdout, lines); err != nil {
		return err
	}
	return writeHumanBody(stdout, firstString(issue, "body"))
}

func renderHumanIssueList(stdout io.Writer, items []map[string]any) error {
	for _, item := range items {
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\t%s\n",
			watchSafeText(numberText(item["number"])),
			watchSafeText(strings.ToUpper(firstString(item, "state"))),
			watchSafeText(firstString(item, "title")),
			joinedObjectStrings(item["labels"], "name"),
			iso8601UTC(firstString(item, "updated_at")),
		); err != nil {
			return err
		}
	}
	return nil
}

func relayArray(ctx context.Context, request ghAPIRequest) ([]map[string]any, error) {
	client, err := newGHRelayClient()
	if err != nil {
		return nil, err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return nil, err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var items []map[string]any
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, err
	}
	return items, nil
}

func writeHumanFields(stdout io.Writer, fields [][2]string) error {
	for _, field := range fields {
		if _, err := fmt.Fprintf(stdout, "%s:\t%s\n", field[0], watchSafeText(field[1])); err != nil {
			return err
		}
	}
	return nil
}

func writeHumanBody(stdout io.Writer, body string) error {
	if _, err := fmt.Fprintln(stdout, "--"); err != nil {
		return err
	}
	clean := bodySafeText(body)
	if clean == "" {
		return nil
	}
	if _, err := io.WriteString(stdout, clean); err != nil {
		return err
	}
	if !strings.HasSuffix(clean, "\n") {
		_, err := fmt.Fprintln(stdout)
		return err
	}
	return nil
}

func joinedObjectStrings(raw any, key string) string {
	items, _ := raw.([]any)
	values := make([]string, 0, len(items))
	for _, rawItem := range items {
		item, ok := rawItem.(map[string]any)
		if !ok {
			continue
		}
		if value := watchSafeText(firstString(item, key)); value != "" {
			values = append(values, value)
		}
	}
	return strings.Join(values, ", ")
}

func latestReviewers(reviews []any) string {
	type review struct {
		login string
		state string
	}
	ordered := []review{}
	positions := map[string]int{}
	for _, raw := range reviews {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		login := watchSafeText(nestedStringValue(item, "user", "login"))
		if login == "" {
			continue
		}
		state := reviewStateTitle(firstString(item, "state"))
		if index, ok := positions[login]; ok {
			ordered[index].state = state
			continue
		}
		positions[login] = len(ordered)
		ordered = append(ordered, review{login: login, state: state})
	}
	values := make([]string, 0, len(ordered))
	for _, item := range ordered {
		if item.state == "" {
			values = append(values, item.login)
		} else {
			values = append(values, fmt.Sprintf("%s (%s)", item.login, item.state))
		}
	}
	return strings.Join(values, ", ")
}

func reviewStateTitle(raw string) string {
	parts := strings.Split(strings.ToLower(watchSafeText(raw)), "_")
	for index, part := range parts {
		if part != "" {
			parts[index] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}

func numberText(value any) string {
	switch typed := value.(type) {
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	case float32:
		return strconv.FormatInt(int64(typed), 10)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case json.Number:
		return typed.String()
	case string:
		return typed
	default:
		return ""
	}
}

func iso8601UTC(raw string) string {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return watchSafeText(raw)
	}
	return parsed.UTC().Format(time.RFC3339)
}

func humanDuration(startRaw string, endRaw string) string {
	if startRaw == "" || endRaw == "" {
		return ""
	}
	start, startErr := time.Parse(time.RFC3339, startRaw)
	end, endErr := time.Parse(time.RFC3339, endRaw)
	if startErr != nil || endErr != nil || end.Before(start) {
		return ""
	}
	duration := end.Sub(start).Truncate(time.Second)
	hours := int(duration / time.Hour)
	minutes := int(duration%time.Hour) / int(time.Minute)
	seconds := int(duration%time.Minute) / int(time.Second)
	if hours > 0 {
		return fmt.Sprintf("%dh%dm%ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm%ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}

func relativeHumanTime(raw string) string {
	created, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return ""
	}
	age := humanNow().Sub(created)
	if age < 0 {
		age = 0
	}
	minutes := int(age / time.Minute)
	if minutes < 1 {
		return "less than a minute ago"
	}
	if minutes < 60 {
		return fmt.Sprintf("about %d %s ago", minutes, plural(minutes, "minute"))
	}
	hours := int(age / time.Hour)
	if hours < 24 {
		return fmt.Sprintf("about %d %s ago", hours, plural(hours, "hour"))
	}
	days := int(age / (24 * time.Hour))
	return fmt.Sprintf("about %d %s ago", days, plural(days, "day"))
}

func plural(count int, unit string) string {
	if count == 1 {
		return unit
	}
	return unit + "s"
}

func runGlyph(run map[string]any) string {
	return statusGlyph(firstString(run, "status"), firstString(run, "conclusion"))
}

func jobGlyph(job map[string]any) string {
	return statusGlyph(firstString(job, "status"), firstString(job, "conclusion"))
}

func statusGlyph(status string, conclusion string) string {
	switch strings.ToLower(conclusion) {
	case "success", "neutral":
		return "✓"
	case "failure", "timed_out", "action_required", "startup_failure":
		return "X"
	case "cancelled", "skipped":
		return "-"
	}
	switch strings.ToLower(status) {
	case "queued", "in_progress", "pending", "requested", "waiting":
		return "*"
	default:
		return "-"
	}
}
