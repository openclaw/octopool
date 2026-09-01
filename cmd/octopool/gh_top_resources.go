package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

func handleGHRepo(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("repo "+args[0], args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "view":
		if hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedRepoFields) {
			return ghDelegated()
		}
		if opts.repo == "" && len(opts.positionals) == 1 {
			opts.repo = opts.positionals[0]
			opts.positionals = nil
		}
		repo, ok := repoOnly(opts)
		if !ok {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo)}, opts, fieldMapRepo))
	case "list":
		return ghDelegated()
	default:
		return ghDelegated()
	}
}

func handleGHRelease(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("release "+args[0], args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "list":
		repo, ok := repoOnly(opts)
		if !ok || !machineReadable(opts) || !supportedJSONFields(opts, supportedReleaseFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: repoPath(repo, "releases"), query: listQuery(opts)}, opts, fieldMapRelease))
	case "view":
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedReleaseViewFields) {
			return ghDelegated()
		}
		path := repoPath(repo, "releases", "latest")
		if len(opts.positionals) == 1 {
			path = repoPath(repo, "releases", "tags", opts.positionals[0])
		} else if len(opts.positionals) > 1 {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    path,
			headers: map[string]string{"x-octopool-public-shape": publicShapeReleaseSummary},
		}, opts, fieldMapRelease))
	default:
		return ghDelegated()
	}
}

func handleGHWorkflow(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("workflow "+args[0], args[1:])
	if !ok {
		return early
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok || repo == "" {
		return ghDelegated()
	}
	switch args[0] {
	case "list":
		if len(opts.positionals) != 0 || opts.patch || opts.state != "" || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedWorkflowFields) || limitOverOnePage(opts) {
			return ghDelegated()
		}
		return ghCompleted(relayWorkflowList(ctx, stdout, repo, opts))
	case "view":
		if len(opts.positionals) != 1 || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedWorkflowFields) || !supportedWorkflowRef(opts.positionals[0]) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
			method:  "GET",
			path:    repoPath(repo, "actions", "workflows", opts.positionals[0]),
			headers: map[string]string{"x-octopool-public-shape": publicShapeWorkflowView},
		}, opts, fieldMapWorkflow))
	default:
		return ghDelegated()
	}
}

func handleGHLabel(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("label "+args[0], args[1:])
	if !ok {
		return early
	}
	if args[0] != "list" || opts.patch || opts.state != "" || opts.branch != "" || opts.workflow != "" || opts.status != "" || opts.author != "" || opts.assignee != "" || len(opts.labels) > 0 || !machineReadable(opts) || !supportedJSONFields(opts, supportedLabelFields) || limitOverOnePage(opts) {
		return ghDelegated()
	}
	repo, ok := repoOnly(opts)
	if !ok {
		return ghDelegated()
	}
	return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "labels"),
		query:   listQuery(opts),
		headers: map[string]string{"x-octopool-public-shape": publicShapeLabelList},
	}, opts, fieldMapLabel))
}

func handleGHGist(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions("gist "+args[0], args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "list":
		return ghDelegated()
	case "view":
		if len(opts.positionals) != 1 || hasTopModifiers(opts) || !machineReadable(opts) || !supportedJSONFields(opts, supportedGistFields) || !isHex(opts.positionals[0]) {
			return ghDelegated()
		}
		return ghCompleted(relayTop(ctx, stdout, ghAPIRequest{method: "GET", path: "/gists/" + opts.positionals[0]}, opts, fieldMapGist))
	default:
		return ghDelegated()
	}
}

func relayWorkflowList(ctx context.Context, stdout io.Writer, repo string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	limit := desiredLimitDefault(opts, 50)
	items := make([]any, 0, limit)
	// Native gh fetches one page at --limit, then drops disabled workflows without backfilling.
	envelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "actions", "workflows"),
		query:   map[string]any{"per_page": strconv.Itoa(limit), "page": "1"},
		headers: map[string]string{"x-octopool-public-shape": publicShapeWorkflowList},
	})
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
	workflows, ok := response["workflows"].([]any)
	if !ok {
		return errors.New("workflow list response did not include workflows")
	}
	for _, item := range workflows {
		if workflowActive(item) {
			items = append(items, item)
		}
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	if len(opts.json) > 0 {
		raw, err = filterJSONFields(raw, opts.json, fieldMapWorkflow)
		if err != nil {
			return err
		}
	}
	return writeBytes(ctx, stdout, raw, opts.jq)
}

func workflowActive(item any) bool {
	workflow, ok := item.(map[string]any)
	return ok && workflow["state"] == "active"
}
