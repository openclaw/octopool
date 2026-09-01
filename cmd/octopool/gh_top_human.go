package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

var stdoutIsTTY = func() bool {
	// GH_FORCE_TTY explicitly requests terminal formatting; honor it by
	// delegating like any interactive session.
	if os.Getenv("GH_FORCE_TTY") != "" {
		return true
	}
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

// prHeadLabel qualifies fork branches as owner:branch like gh's HeadLabel.
func prHeadLabel(pr map[string]any) string {
	ref := nestedStringValue(pr, "head", "ref")
	headOwner := headRepoOwner(pr, "head")
	baseOwner := headRepoOwner(pr, "base")
	if headOwner != "" && headOwner != baseOwner {
		return headOwner + ":" + ref
	}
	return ref
}

func headRepoOwner(pr map[string]any, side string) string {
	half, _ := pr[side].(map[string]any)
	if half == nil {
		return ""
	}
	repo, _ := half["repo"].(map[string]any)
	if repo == nil {
		return ""
	}
	return nestedStringValue(repo, "owner", "login")
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
		{"reviewers", latestReviewers(pr, reviews)},
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
			watchSafeText(prHeadLabel(item)),
			watchSafeText(humanPRState(item)),
			iso8601UTC(firstString(item, "created_at")),
		); err != nil {
			return err
		}
	}
	return nil
}

func renderHumanPRChecks(stdout io.Writer, items []prCheckRow) error {
	items = append([]prCheckRow(nil), items...)
	// Keep gh's literal comparator, including "success" (not "pass"). This
	// presentation sort must never reorder the JSON aggregation result.
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Bucket == b.Bucket {
			if a.Name == b.Name {
				return a.Link < b.Link
			}
			return a.Name < b.Name
		}
		return a.Bucket == "fail" || (a.Bucket == "pending" && b.Bucket == "success")
	})
	for _, item := range items {
		bucket := item.Bucket
		if bucket == "cancel" {
			bucket = "fail"
		}
		elapsed := "0"
		if !item.StartedAt.IsZero() && !item.CompletedAt.IsZero() {
			if duration := item.CompletedAt.Sub(item.StartedAt); duration > 0 {
				elapsed = duration.String()
			}
		}
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\t%s\n",
			watchSafeText(item.Name), bucket, elapsed,
			watchSafeText(item.Link), watchSafeText(item.Description),
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
			runElapsed(item),
			iso8601UTC(firstString(item, "run_started_at", "created_at")),
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
	if _, err := fmt.Fprintf(stdout, "\n%s %s · %s\nTriggered via %s %s\n",
		runGlyph(run),
		watchSafeText(display),
		watchSafeText(id),
		watchSafeText(firstString(run, "event")),
		relativeHumanTime(firstString(run, "run_started_at", "created_at")),
	); err != nil {
		return err
	}
	// Workflow-file problems fail with zero jobs; match real gh's diagnostic
	// instead of an unexplained empty JOBS section. Cancelled-while-queued
	// runs also have zero jobs and must not get this label.
	conclusion := strings.ToLower(firstString(run, "conclusion"))
	if len(jobs) == 0 && (conclusion == "failure" || conclusion == "startup_failure") {
		_, err := fmt.Fprintf(stdout, "\nThis run likely failed because of a workflow file issue.\n\nView this run on GitHub: %s\n", watchSafeText(firstString(run, "html_url")))
		return err
	}
	if _, err := fmt.Fprint(stdout, "\nJOBS\n"); err != nil {
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
		if !strings.EqualFold(firstString(job, "conclusion"), "failure") {
			continue
		}
		steps, _ := job["steps"].([]any)
		for _, rawStep := range steps {
			step, ok := rawStep.(map[string]any)
			if !ok || !strings.EqualFold(firstString(step, "conclusion"), "failure") {
				continue
			}
			if _, err := fmt.Fprintf(stdout, "  %s %s\n",
				statusGlyph(firstString(step, "status"), firstString(step, "conclusion")),
				watchSafeText(firstString(step, "name")),
			); err != nil {
				return err
			}
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
	// real gh prints the body record with one unconditional trailing newline,
	// including for empty bodies.
	_, err := fmt.Fprintln(stdout, bodySafeText(body))
	return err
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

func latestReviewers(pr map[string]any, reviews []any) string {
	type review struct {
		login string
		state string
	}
	ordered := []review{}
	positions := map[string]int{}
	upsert := func(login string, state string) {
		if index, ok := positions[login]; ok {
			ordered[index].state = state
			return
		}
		positions[login] = len(ordered)
		ordered = append(ordered, review{login: login, state: state})
	}
	author := nestedStringValue(pr, "user", "login")
	for _, raw := range reviews {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		login := watchSafeText(nestedStringValue(item, "user", "login"))
		// real gh omits the author's own comment reviews and unsubmitted
		// PENDING drafts from the reviewer summary.
		if login == "" || login == author || strings.EqualFold(firstString(item, "state"), "PENDING") {
			continue
		}
		upsert(login, reviewStateTitle(firstString(item, "state")))
	}
	// Outstanding requests (including re-requests) override any prior
	// submitted state, matching real gh's reviewer summary.
	if requested, ok := pr["requested_reviewers"].([]any); ok {
		for _, raw := range requested {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if login := watchSafeText(firstString(item, "login")); login != "" {
				upsert(login, "Requested")
			}
		}
	}
	if teams, ok := pr["requested_teams"].([]any); ok {
		for _, raw := range teams {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if slug := watchSafeText(firstString(item, "slug", "name")); slug != "" {
				upsert(slug, "Requested")
			}
		}
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
	// Divide as time.Duration before narrowing: int(time.Minute) overflows
	// 32-bit ints.
	hours := int(duration / time.Hour)
	minutes := int((duration % time.Hour) / time.Minute)
	seconds := int((duration % time.Minute) / time.Second)
	if hours > 0 {
		return fmt.Sprintf("%dh%dm%ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm%ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}

// runElapsed measures active runs through now; updated_at can sit still
// while work continues.
func runElapsed(run map[string]any) string {
	start := firstString(run, "run_started_at", "created_at")
	end := firstString(run, "updated_at")
	if !strings.EqualFold(firstString(run, "status"), "completed") {
		end = humanNow().UTC().Format(time.RFC3339)
	}
	return humanDuration(start, end)
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

// statusGlyph mirrors gh's completed-conclusion mapping: tick only for
// success, dash for skipped/neutral, X for every other terminal conclusion.
func statusGlyph(status string, conclusion string) string {
	if lowered := strings.ToLower(conclusion); lowered != "" {
		switch lowered {
		case "success":
			return "✓"
		case "neutral", "skipped":
			return "-"
		default:
			return "X"
		}
	}
	switch strings.ToLower(status) {
	case "queued", "in_progress", "pending", "requested", "waiting":
		return "*"
	default:
		return "-"
	}
}
