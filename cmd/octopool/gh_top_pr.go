package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
)

func supportedPRListState(state string) bool {
	switch state {
	case "", "open", "all":
		return true
	default:
		return false
	}
}

// Fields whose value is a merge-gate decision: a stale answer here reads as a
// confident fact ("branch still at the old SHA", "PR still open") seconds after
// a push or merge, so these reads skip the shared cache.
func needsLivePRRead(fields []string) bool {
	for _, field := range fields {
		switch field {
		case "headRefOid", "baseRefOid", "state", "merged", "mergedAt", "mergeable",
			"mergeStateStatus", "closedAt", "statusCheckRollup":
			return true
		}
	}
	return false
}

func handleGHPR(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	if args[0] == "checks" && hasWatchFlag(args[1:]) {
		return handleGHPRChecksWatch(ctx, args[1:], stdout)
	}
	opts, early, ok := prepareGHTopOptions("pr "+args[0], args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "view":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) {
			return ghDelegated()
		}
		if nativeHumanFormat(opts) {
			return ghCompleted(relayHumanPRView(ctx, stdout, repo, number))
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedPRFields) {
			return ghDelegated()
		}
		return ghCompleted(relayPRView(ctx, stdout, repo, number, opts))
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !supportedPRListState(opts.state) || limitOverOnePage(opts) || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 {
			return ghDelegated()
		}
		query := listQuery(opts)
		if opts.state != "" {
			query["state"] = opts.state
		}
		if nativeHumanFormat(opts) {
			return ghCompleted(relayHumanPRList(ctx, stdout, ghAPIRequest{
				method: "GET",
				path:   repoPath(repo, "pulls"),
				query:  query,
			}))
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedPRListFields) {
			return ghDelegated()
		}
		return ghCompleted(relayPRList(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "pulls"),
			query:   query,
			headers: publicShapeHeaders(opts, supportedPublicPRListFields, publicShapePullRequestList),
		}, opts))
	case "diff":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiersExceptPatch(opts) || machineReadable(opts) || opts.jq != "" {
			return ghDelegated()
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
		return ghCompleted(relayTop(ctx, stdout, request, ghTopOptions{}, nil))
	case "checks":
		repo, number, ok := repoNumber(opts)
		if !ok || hasTopModifiers(opts) {
			return ghDelegated()
		}
		if !nativeHumanFormat(opts) && (!machineReadable(opts) || !supportedJSONFields(opts, supportedCheckRunFields)) {
			return ghDelegated()
		}
		return ghCompleted(relayPRChecks(ctx, stdout, repo, number, opts))
	default:
		return ghDelegated()
	}
}

func relayPRList(ctx context.Context, stdout io.Writer, request ghAPIRequest, opts ghTopOptions) error {
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
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	var items []map[string]any
	if err := json.Unmarshal(body, &items); err != nil {
		return err
	}
	for _, pr := range items {
		normalizePRViewState(pr)
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(raw, opts.json, fieldMapPR)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, filtered, opts.jq)
}

func relayPRView(ctx context.Context, stdout io.Writer, repo string, number string, opts ghTopOptions) error {
	headers := prViewHeaders(opts)
	if hasJSONField(opts.json, "files") || needsLivePRRead(opts.json) || freshReadRequested() {
		if headers == nil {
			headers = map[string]string{}
		}
		headers["cache-control"] = "max-age=0"
	}
	request := ghAPIRequest{
		method: "GET", path: repoPath(repo, "pulls", number), headers: headers,
	}
	if !safeRelayRequest(request) {
		return errors.New("internal error: top-level gh command built an unsupported relay request")
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	prEnvelope, err := client.do(ctx, request)
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(prEnvelope)
	if err != nil {
		return err
	}
	var pr map[string]any
	if err := json.Unmarshal(body, &pr); err != nil {
		return err
	}
	normalizePRViewState(pr)
	normalizePRViewMergeable(pr)
	hydratedHeadSHA := ""
	users := map[string]map[string]any{}
	for _, field := range opts.json {
		switch field {
		case "author":
			author, present := pr["user"]
			if !present {
				return localFallbackError{Reason: "pull request response did not include author"}
			}
			mapped, err := relayPRViewAuthor(ctx, client, author, users)
			if err != nil {
				return err
			}
			pr["user"] = mapped
		case "labels":
			labels, err := mapPRViewLabels(pr["labels"])
			if err != nil {
				return err
			}
			pr[field] = labels
		case "headRepository":
			repository, present := valueAtPath(pr, "head", "repo")
			if !present {
				return errors.New("pull request response did not include head.repo")
			}
			pr[field] = nil
			if repository != nil {
				repository, ok := repository.(map[string]any)
				if !ok || firstString(repository, "node_id") == "" || firstString(repository, "name") == "" || firstString(repository, "full_name") == "" {
					return errors.New("pull request response did not include head repository identity")
				}
				pr[field] = map[string]any{
					"id": firstString(repository, "node_id"), "name": firstString(repository, "name"),
					"nameWithOwner": firstString(repository, "full_name"),
				}
			}
		case "headRepositoryOwner":
			owner, present := valueAtPath(pr, "head", "user")
			if !present {
				return errors.New("pull request response did not include head.user")
			}
			if owner == nil {
				// gh's Owner zero value retains login when a deleted owner is null.
				pr[field] = map[string]any{"login": ""}
				continue
			}
			profile, err := relayPRUser(ctx, client, owner, users)
			if err != nil {
				return err
			}
			mapped := map[string]any{"id": profile["node_id"], "login": profile["login"]}
			if profile["type"] == "User" && firstString(profile, "name") != "" {
				mapped["name"] = profile["name"]
			}
			pr[field] = mapped
		case "assignees":
			assignees, ok := pr[field].([]any)
			if !ok {
				return errors.New("pull request response did not include assignees array")
			}
			mapped := make([]any, 0, len(assignees))
			for _, assignee := range assignees {
				profile, err := relayPRUser(ctx, client, assignee, users)
				if err != nil {
					return err
				}
				mapped = append(mapped, map[string]any{"id": profile["node_id"], "login": profile["login"], "name": firstString(profile, "name"), "databaseId": profile["id"]})
			}
			pr[field] = mapped
		case "statusCheckRollup":
			sha := nestedStringValue(pr, "head", "sha")
			if sha == "" {
				return errors.New("pull request response did not include head.sha")
			}
			rollup, err := relayPRStatusCheckRollup(ctx, client, repo, sha)
			if err != nil {
				return err
			}
			hydratedHeadSHA = sha
			pr[field] = rollup
		case "files":
			sha := nestedStringValue(pr, "head", "sha")
			if sha == "" {
				return localFallbackError{Reason: "pull request response did not include head.sha"}
			}
			files, err := relayPagedArrayWithHeaders(
				ctx,
				client,
				repoPath(repo, "pulls", number, "files"),
				map[string]string{"pr_head_sha": sha},
				map[string]string{"x-octopool-public-shape": publicShapePullRequestFiles},
			)
			if err != nil {
				return err
			}
			mapped, err := mapPRFiles(files)
			if err != nil {
				return err
			}
			hydratedHeadSHA = sha
			pr["files"] = mapped
		case "commits":
			commits, err := relayPagedArray(ctx, client, repoPath(repo, "pulls", number, "commits"), nil)
			if err != nil {
				return err
			}
			pr["commits"] = mapPRCommits(commits)
		case "comments":
			comments, err := relayPagedArray(ctx, client, repoPath(repo, "issues", number, "comments"), nil)
			if err != nil {
				return err
			}
			pr["comments"] = mapPRComments(comments)
		case "reviews":
			reviews, err := relayPagedArray(ctx, client, repoPath(repo, "pulls", number, "reviews"), nil)
			if err != nil {
				return err
			}
			pr["reviews"] = mapPRReviews(reviews)
		}
	}
	if hydratedHeadSHA != "" {
		currentSHA, err := relayPRHeadSHA(ctx, client, repo, number, 0)
		if err != nil {
			return err
		}
		if currentSHA != hydratedHeadSHA {
			return localFallbackError{Reason: "pull request head changed during metadata hydration"}
		}
	}
	raw, err := json.Marshal(pr)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(raw, opts.json, fieldMapPR)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, filtered, opts.jq)
}

func normalizePRViewState(pr map[string]any) {
	state, ok := pr["state"].(string)
	if !ok {
		return
	}
	state = strings.ToUpper(state)
	merged, _ := pr["merged"].(bool)
	switch {
	case merged || firstString(pr, "merged_at") != "" || state == "MERGED":
		state = "MERGED"
	case firstString(pr, "closed_at") != "" || state == "CLOSED":
		state = "CLOSED"
	case state == "DRAFT":
		// pr-summary-v1 includes the page's display state, including in existing cache entries.
		state = "OPEN"
	}
	pr["state"] = state
}

func normalizePRViewMergeable(pr map[string]any) {
	if pr == nil {
		return
	}
	switch pr["mergeable"] {
	case true:
		pr["mergeable"] = "MERGEABLE"
	case false:
		pr["mergeable"] = "CONFLICTING"
	default:
		pr["mergeable"] = "UNKNOWN"
	}
}

func prViewHeaders(opts ghTopOptions) map[string]string {
	for _, field := range opts.json {
		switch field {
		case "files", "commits", "comments", "reviews", "statusCheckRollup":
			continue
		}
		if !supportedPublicPRViewFields[field] {
			return nil
		}
	}
	return map[string]string{"x-octopool-public-shape": publicShapePullRequestSummary}
}

func relayPagedArray(ctx context.Context, client ghRelayClient, path string, routeHint map[string]string) ([]any, error) {
	return relayPagedArrayWithHeaders(ctx, client, path, routeHint, nil)
}

func relayPagedArrayWithHeaders(
	ctx context.Context,
	client ghRelayClient,
	path string,
	routeHint map[string]string,
	headers map[string]string,
) ([]any, error) {
	items := []any{}
	complete := false
	for page := 1; page <= maxRelayPages; page++ {
		envelope, err := client.do(ctx, ghAPIRequest{
			method:    "GET",
			path:      path,
			query:     map[string]any{"per_page": strconv.Itoa(relayPageSize), "page": strconv.Itoa(page)},
			headers:   headers,
			routeHint: routeHint,
		})
		if err != nil {
			return nil, err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return nil, err
		}
		var pageItems []any
		if err := json.Unmarshal(body, &pageItems); err != nil {
			return nil, err
		}
		items = append(items, pageItems...)
		if len(pageItems) < relayPageSize {
			complete = true
			break
		}
	}
	if !complete {
		return nil, localFallbackError{Reason: "pagination_exhausted"}
	}
	return items, nil
}

func mapPRFiles(items []any) ([]any, error) {
	changeTypes := map[string]string{
		"added": "ADDED", "removed": "DELETED", "modified": "MODIFIED",
		"renamed": "RENAMED", "copied": "COPIED", "changed": "CHANGED",
	}
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		changeType := changeTypes[firstString(item, "status")]
		additions, addOK := item["additions"].(float64)
		deletions, delOK := item["deletions"].(float64)
		if changeType == "" || firstString(item, "filename") == "" || !addOK || !delOK ||
			additions < 0 || deletions < 0 || additions != math.Trunc(additions) || deletions != math.Trunc(deletions) {
			return nil, localFallbackError{Reason: "unsupported pull request file shape"}
		}
		// Native PullRequestFile has no originalPath, including for renames.
		out = append(out, map[string]any{
			"path": firstString(item, "filename"), "additions": additions,
			"deletions": deletions, "changeType": changeType,
		})
	}
	return out, nil
}

func mapPRCommits(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		commit, _ := item["commit"].(map[string]any)
		message := firstString(commit, "message")
		headline, body, _ := strings.Cut(message, "\n\n")
		if headline == "" {
			headline = message
		}
		return map[string]any{
			"oid":             firstString(item, "sha"),
			"messageHeadline": headline,
			"messageBody":     body,
			"committedDate":   nestedStringValue(item, "commit", "committer", "date"),
			"authoredDate":    nestedStringValue(item, "commit", "author", "date"),
			"url":             firstString(item, "html_url"),
			"authors":         commitAuthors(item),
		}
	})
}

func mapPRComments(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		return map[string]any{
			"author":    item["user"],
			"body":      item["body"],
			"createdAt": item["created_at"],
			"updatedAt": item["updated_at"],
			"url":       item["html_url"],
		}
	})
}

func mapPRReviews(items []any) []any {
	return mapObjects(items, func(item map[string]any) map[string]any {
		return map[string]any{
			"author":      item["user"],
			"body":        item["body"],
			"state":       item["state"],
			"submittedAt": item["submitted_at"],
			"url":         item["html_url"],
		}
	})
}

func mapObjects(items []any, mapper func(map[string]any) map[string]any) []any {
	out := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, mapper(item))
	}
	return out
}

func commitAuthors(item map[string]any) []any {
	login := nestedStringValue(item, "author", "login")
	if login == "" {
		login = nestedStringValue(item, "commit", "author", "name")
	}
	if login == "" {
		return []any{}
	}
	return []any{map[string]any{"login": login}}
}
