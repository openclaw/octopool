package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

func handleGHRun(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) == 0 {
		return ghDelegated()
	}
	if args[0] == "watch" {
		return handleGHRunWatch(ctx, args[1:], stdout)
	}
	opts, early, ok := prepareGHTopOptions("run "+args[0], args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "list":
		if (opts.read.has("--commit") || opts.read.has("--event") || opts.read.has("--created")) && !machineReadable(opts) {
			return ghDelegated()
		}
		repo, ok, err := repoOnly(opts)
		if err != nil {
			return ghFailed(err)
		}
		if !ok {
			return ghDelegated()
		}
		query := listQueryDefault(opts, 20)
		if opts.branch != "" {
			query["branch"] = opts.branch
		}
		if opts.status != "" {
			query["status"] = opts.status
		}
		if commit := opts.read.values["--commit"].raw; commit != "" {
			query["head_sha"] = commit
		}
		if event := opts.read.values["--event"].raw; event != "" {
			query["event"] = event
		}
		if created := opts.read.values["--created"].raw; created != "" {
			query["created"] = created
		}
		path := repoPath(repo, "actions", "runs")
		if opts.workflow != "" {
			if !supportedWorkflowRef(opts.workflow) {
				return ghDelegated()
			}
			path = repoPath(repo, "actions", "workflows", opts.workflow, "runs")
		}
		if limitOverOnePage(opts) {
			return ghDelegated()
		}
		request := ghAPIRequest{
			method:  "GET",
			path:    path,
			query:   query,
			headers: map[string]string{"x-octopool-public-shape": publicShapeActionsSummary},
		}
		if nativeHumanFormat(opts) {
			return ghCompleted(relayHumanRunList(ctx, stdout, request))
		}
		if !machineReadable(opts) || !supportedJSONFields(opts, supportedRunListFields) {
			return ghDelegated()
		}
		request.headers = nil
		return ghCompleted(relayMachineRunList(ctx, stdout, request, repo, opts))
	case "view":
		if len(opts.positionals) != 1 || !isDigits(opts.positionals[0]) || hasRunViewModifiers(opts) {
			return ghDelegated()
		}
		repo, ok, err := repoFromOptionOrCurrent(opts.repo)
		if err != nil {
			return ghFailed(err)
		}
		if !ok {
			return ghDelegated()
		}
		if !nativeHumanFormat(opts) && (!machineReadable(opts) || !supportedJSONFields(opts, supportedRunViewFields)) {
			return ghDelegated()
		}
		if nativeHumanFormat(opts) {
			return ghCompleted(relayHumanRunView(ctx, stdout, repo, opts.positionals[0], opts))
		}
		return ghCompleted(relayMachineRunView(ctx, stdout, repo, opts.positionals[0], opts))
	default:
		return ghDelegated()
	}
}

func relayHumanRunView(ctx context.Context, stdout io.Writer, repo string, id string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	run := map[string]any{}
	runPath := repoPath(repo, "actions", "runs", id)
	if opts.attemptSet && opts.attempt != 0 {
		runPath = repoPath(repo, "actions", "runs", id, "attempts", strconv.Itoa(opts.attempt))
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    runPath,
		headers: map[string]string{"x-octopool-public-shape": publicShapeActionsSummary},
	})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, &run); err != nil {
		return err
	}
	attempt, ok := positiveJSONInt(run["run_attempt"])
	if !ok {
		return localFallbackError{Reason: "workflow run response did not include run_attempt"}
	}
	jobs, err := relayHumanRunJobs(ctx, client, repo, runJobOwner{id: id, headSHA: firstString(run, "head_sha")}, attempt, nil)
	if err != nil {
		return err
	}
	run["jobs"] = jobs
	return renderHumanRunView(stdout, run, jobs)
}

func positiveJSONInt(value any) (int, bool) {
	parsed, ok := value.(float64)
	if !ok || parsed < 1 || parsed != float64(int(parsed)) {
		return 0, false
	}
	return int(parsed), true
}

func relayHumanRunJobs(ctx context.Context, client ghRelayClient, repo string, owner runJobOwner, attempt int, extraHeaders map[string]string) ([]any, error) {
	headers := map[string]string{"x-octopool-public-shape": publicShapeActionsJobs}
	for key, value := range extraHeaders {
		headers[key] = value
	}
	return relayRunJobs(ctx, client, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "actions", "runs", owner.id, "attempts", strconv.Itoa(attempt), "jobs"),
		headers: headers,
	}, func(envelope relayEnvelope, seen map[int64]bool) ([]any, int, error) {
		return runJobsPage(envelope, owner, seen)
	})
}

func runJobsPage(envelope relayEnvelope, owner runJobOwner, seen map[int64]bool) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response struct {
		Total any               `json:"total_count"`
		Jobs  []json.RawMessage `json:"jobs"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	if response.Jobs == nil {
		return nil, 0, errors.New("workflow jobs response did not include jobs")
	}
	total, ok := jsonNumericInt(response.Total)
	if !ok {
		return nil, 0, localFallbackError{Reason: "workflow jobs response did not include a valid total_count"}
	}
	if len(response.Jobs) > relayPageSize || len(response.Jobs) > total {
		return nil, 0, localFallbackError{Reason: "workflow jobs pagination contradicts total_count or page size"}
	}
	jobs := make([]any, 0, len(response.Jobs))
	for _, rawJob := range response.Jobs {
		var identity runJobIdentity
		if err := json.Unmarshal(rawJob, &identity); err != nil {
			return nil, 0, localFallbackError{Reason: "workflow jobs response included invalid identity metadata"}
		}
		if err := identity.validate(owner, seen); err != nil {
			return nil, 0, localFallbackError{Reason: err.Error()}
		}
		var job map[string]any
		if err := json.Unmarshal(rawJob, &job); err != nil {
			return nil, 0, err
		}
		mapped := map[string]any{"databaseId": float64(identity.ID)}
		for field, path := range map[string][]string{
			"name":        {"name"},
			"status":      {"status"},
			"conclusion":  {"conclusion"},
			"startedAt":   {"started_at"},
			"completedAt": {"completed_at"},
			"url":         {"html_url"},
		} {
			if value, ok := valueAtPath(job, path...); ok {
				mapped[field] = value
			}
		}
		if rawSteps, ok := job["steps"].([]any); ok {
			steps := make([]any, 0, len(rawSteps))
			for _, rawStep := range rawSteps {
				step, ok := rawStep.(map[string]any)
				if !ok {
					return nil, 0, errors.New("workflow jobs response included an invalid step")
				}
				mappedStep := map[string]any{}
				for field, path := range map[string][]string{
					"name":        {"name"},
					"number":      {"number"},
					"status":      {"status"},
					"conclusion":  {"conclusion"},
					"startedAt":   {"started_at"},
					"completedAt": {"completed_at"},
				} {
					if value, ok := valueAtPath(step, path...); ok {
						mappedStep[field] = value
					}
				}
				steps = append(steps, mappedStep)
			}
			mapped["steps"] = steps
		}
		jobs = append(jobs, mapped)
	}
	return jobs, total, nil
}

func hasJSONField(fields []string, expected string) bool {
	for _, field := range fields {
		if field == expected {
			return true
		}
	}
	return false
}
