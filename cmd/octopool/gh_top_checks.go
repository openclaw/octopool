package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

// prChecksMaxPRAgeSeconds bounds the shared PR head lookup's staleness.
const prChecksMaxPRAgeSeconds = 60

type prCheckHead struct {
	SHA string `json:"sha"`
	Ref string `json:"ref"`
}

type prChecksEmptyError struct{ head prCheckHead }

func (err prChecksEmptyError) Error() string {
	return fmt.Sprintf("no checks reported on the '%s' branch", watchSafeText(err.head.Ref))
}

// Keep the REST source discriminator until each consumer projects its own shape.
// In particular, status created_at is not a check's startedAt.
type prCheckContext struct {
	raw      map[string]any
	isStatus bool
}

type prCheckRow struct {
	Name, State, Link, Bucket, Event, Workflow, Description string
	StartedAt, CompletedAt                                  time.Time
	isStatus                                                bool
}

func relayPRChecks(ctx context.Context, stdout io.Writer, repo, number string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	items, head, err := relayPRCheckItemsWithHead(ctx, client, repo, number)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return prChecksEmptyError{head: head}
	}
	if len(opts.json) == 0 {
		if err := renderHumanPRChecks(stdout, items); err != nil {
			return err
		}
		return checkExitCode(items)
	}
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, item.export(opts.json))
	}
	raw, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	// Export success is independent of check outcomes. Include the terminator in
	// the write so a writer failure cannot be lost on a second newline write.
	return writeBytes(ctx, stdout, append(raw, '\n'), opts.jq)
}

func (row prCheckRow) export(fields []string) map[string]any {
	values := map[string]any{
		"name": row.Name, "state": row.State, "link": row.Link, "bucket": row.Bucket,
		"event": row.Event, "workflow": row.Workflow, "description": row.Description,
		"startedAt": row.StartedAt, "completedAt": row.CompletedAt,
	}
	out := make(map[string]any, len(fields))
	for _, field := range fields {
		out[field] = values[field]
	}
	return out
}

func relayPRHead(ctx context.Context, client ghRelayClient, repo, number string, maxAgeSeconds int) (prCheckHead, error) {
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET", path: repoPath(repo, "pulls", number),
		headers: map[string]string{
			"cache-control":           "max-age=" + strconv.Itoa(maxAgeSeconds),
			"x-octopool-public-shape": publicShapePullRequestSummary,
		},
	})
	if err != nil {
		return prCheckHead{}, err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return prCheckHead{}, err
	}
	var pr struct {
		Head map[string]json.RawMessage `json:"head"`
	}
	if err := json.Unmarshal(body, &pr); err != nil {
		return prCheckHead{}, err
	}
	var head prCheckHead
	// Each caller validates the identity it needs; an unrelated PR-view SHA
	// verification must not acquire the checks-only branch requirement.
	_ = json.Unmarshal(pr.Head["sha"], &head.SHA)
	_ = json.Unmarshal(pr.Head["ref"], &head.Ref)
	return head, nil
}

// PR-view's final SHA verification does not need checks' branch diagnostic.
func relayPRHeadSHA(ctx context.Context, client ghRelayClient, repo, number string, maxAgeSeconds int) (string, error) {
	head, err := relayPRHead(ctx, client, repo, number, maxAgeSeconds)
	if err != nil {
		return "", err
	}
	if head.SHA == "" {
		return "", errors.New("pull request response did not include head.sha")
	}
	return head.SHA, nil
}

func relayPRChecksHead(ctx context.Context, client ghRelayClient, repo, number string, maxAgeSeconds int) (prCheckHead, error) {
	head, err := relayPRHead(ctx, client, repo, number, maxAgeSeconds)
	if err != nil {
		return prCheckHead{}, err
	}
	if head.SHA == "" || head.Ref == "" {
		return prCheckHead{}, localFallbackError{Reason: "pull request response did not include checks head identity"}
	}
	return head, nil
}

func relayPRCheckItemsWithHead(ctx context.Context, client ghRelayClient, repo, number string) ([]prCheckRow, prCheckHead, error) {
	head, err := relayPRChecksHead(ctx, client, repo, number, prChecksMaxPRAgeSeconds)
	if err != nil {
		return nil, prCheckHead{}, err
	}
	items, err := prCheckItemsForSHAWithHeaders(ctx, client, repo, head.SHA, nil)
	return items, head, err
}

// Every page, including Actions metadata, bypasses cached staleness in a fresh
// sweep. Each acquisition builds its own associations, including same-SHA reruns.
func prCheckItemsForSHAFresh(ctx context.Context, client ghRelayClient, repo, sha string) ([]prCheckRow, error) {
	return prCheckItemsForSHAWithHeaders(ctx, client, repo, sha, watchFreshHeaders())
}

func prCheckItemsForSHAWithHeaders(ctx context.Context, client ghRelayClient, repo, sha string, headers map[string]string) ([]prCheckRow, error) {
	contexts, err := prCheckContextsForSHA(ctx, client, repo, sha, headers)
	if err != nil {
		return nil, err
	}
	metadata, err := verifiedPRCheckMetadata(ctx, client, repo, sha, headers, contexts)
	if err != nil {
		return nil, err
	}
	rows := make([]prCheckRow, 0, len(contexts))
	for _, item := range contexts {
		row, err := normalizePRCheck(item, metadata)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return deduplicatePRChecks(rows), nil
}

func prCheckContextsForSHA(ctx context.Context, client ghRelayClient, repo, sha string, headers map[string]string) ([]prCheckContext, error) {
	checks, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "commits", sha, "check-runs"), headers: headers,
	}, "check_runs")
	if err != nil {
		return nil, err
	}
	statuses, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "commits", sha, "status"), headers: headers,
	}, "statuses")
	if err != nil {
		return nil, err
	}
	items := make([]prCheckContext, 0, len(checks)+len(statuses))
	for _, raw := range checks {
		items = append(items, prCheckContext{raw: raw.(map[string]any)})
	}
	return append(items, statusItems(statuses)...), nil
}

func statusItems(items []any) []prCheckContext {
	out := make([]prCheckContext, 0, len(items))
	for _, raw := range items {
		out = append(out, prCheckContext{raw: raw.(map[string]any), isStatus: true})
	}
	return out
}

func normalizePRCheck(context prCheckContext, metadata map[int64]prCheckMetadata) (prCheckRow, error) {
	item := context.raw
	row := prCheckRow{isStatus: context.isStatus}
	if context.isStatus {
		row.Name = firstString(item, "context")
		row.State = strings.ToUpper(firstString(item, "state"))
		row.Link = firstString(item, "target_url")
		row.Description = firstString(item, "description")
	} else {
		row.Name = firstString(item, "name")
		row.State = strings.ToUpper(firstString(item, "status"))
		if row.State == "COMPLETED" {
			row.State = strings.ToUpper(firstString(item, "conclusion"))
		}
		row.Link = firstString(item, "details_url")
		var err error
		row.StartedAt, err = prCheckTime(item["started_at"])
		if err != nil {
			return prCheckRow{}, err
		}
		row.CompletedAt, err = prCheckTime(item["completed_at"])
		if err != nil {
			return prCheckRow{}, err
		}
		if nestedStringValue(item, "app", "slug") == "github-actions" {
			suite, _ := valueAtPath(item, "check_suite", "id")
			id, _ := prCheckID(suite)
			association := metadata[id]
			row.Workflow, row.Event = association.workflowName, association.event
		}
	}
	row.Bucket = ghCheckBucket(row.State)
	return row, nil
}

func prCheckTime(raw any) (time.Time, error) {
	if raw == nil || raw == "" {
		return time.Time{}, nil
	}
	if value, ok := raw.(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, localFallbackError{Reason: "invalid check timestamp"}
}

func deduplicatePRChecks(rows []prCheckRow) []prCheckRow {
	// Literal native aggregation: unstable descending start time, with no
	// created_at/ID tiebreaker and separate status and slash-joined check keys.
	sort.Slice(rows, func(i, j int) bool { return rows[i].StartedAt.After(rows[j].StartedAt) })
	checks, statuses := map[string]bool{}, map[string]bool{}
	out := make([]prCheckRow, 0, len(rows))
	for _, row := range rows {
		seen, key := checks, row.Name+"/"+row.Workflow+"/"+row.Event
		if row.isStatus {
			seen, key = statuses, row.Name
		}
		if !seen[key] {
			seen[key] = true
			out = append(out, row)
		}
	}
	return out
}

func ghCheckBucket(state string) string {
	switch strings.ToLower(state) {
	case "success":
		return "pass"
	case "failure", "error", "timed_out", "action_required":
		return "fail"
	case "cancelled":
		return "cancel"
	case "skipped", "neutral":
		return "skipping"
	default:
		return "pending"
	}
}

func checkExitCode(items []prCheckRow) error {
	code := 0
	for _, item := range items {
		switch item.Bucket {
		case "fail":
			return exitCodeError{Code: 1}
		case "pending":
			code = 8
		}
	}
	if code != 0 {
		return exitCodeError{Code: code}
	}
	return nil
}
