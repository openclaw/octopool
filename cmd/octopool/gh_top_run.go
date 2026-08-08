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
	opts, early, ok := prepareGHTopOptions(args[1:])
	if !ok {
		return early
	}
	switch args[0] {
	case "list":
		repo, ok := repoOnly(opts)
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
		return ghCompleted(relayTop(ctx, stdout, request, opts, fieldMapRun))
	case "view":
		if len(opts.positionals) != 1 || !isDigits(opts.positionals[0]) || hasRunViewModifiers(opts) {
			return ghDelegated()
		}
		repo, ok := repoFromOptionOrCurrent(opts.repo)
		if !ok {
			return ghDelegated()
		}
		if !nativeHumanFormat(opts) && (!machineReadable(opts) || !supportedJSONFields(opts, supportedRunViewFields)) {
			return ghDelegated()
		}
		return ghCompleted(relayRunView(ctx, stdout, repo, opts.positionals[0], opts))
	default:
		return ghDelegated()
	}
}

func relayRunView(ctx context.Context, stdout io.Writer, repo string, id string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	run := map[string]any{}
	human := len(opts.json) == 0
	runPath := repoPath(repo, "actions", "runs", id)
	if opts.attemptSet {
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
	if human || hasJSONField(opts.json, "jobs") {
		attempt, ok := positiveJSONInt(run["run_attempt"])
		if !ok {
			return localFallbackError{Reason: "workflow run response did not include run_attempt"}
		}
		// per_page=100 with runJobs' incomplete-total fallback: >100-job runs
		// delegate to real gh rather than truncating.
		envelope, err := client.do(ctx, ghAPIRequest{
			method: "GET",
			path:   repoPath(repo, "actions", "runs", id, "attempts", strconv.Itoa(attempt), "jobs"),
			query:  map[string]any{"per_page": "100"},
			headers: map[string]string{
				"x-octopool-public-shape": publicShapeActionsJobs,
			},
		})
		if err != nil {
			return err
		}
		jobs, err := runJobs(envelope)
		if err != nil {
			return err
		}
		run["jobs"] = jobs
	}
	if human {
		jobs, _ := run["jobs"].([]any)
		return renderHumanRunView(stdout, run, jobs)
	}
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	filtered, err := filterJSONFields(raw, opts.json, fieldMapRun)
	if err != nil {
		return err
	}
	return writeBytes(ctx, stdout, filtered, opts.jq)
}

func positiveJSONInt(value any) (int, bool) {
	parsed, ok := value.(float64)
	if !ok || parsed < 1 || parsed != float64(int(parsed)) {
		return 0, false
	}
	return int(parsed), true
}

func runJobs(envelope relayEnvelope) ([]any, error) {
	jobs, total, err := runJobsPage(envelope)
	if err != nil {
		return nil, err
	}
	if total > len(jobs) {
		return nil, localFallbackError{Reason: "workflow jobs response requires pagination"}
	}
	return jobs, nil
}

func runJobsPage(envelope relayEnvelope) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	rawJobs, ok := response["jobs"].([]any)
	if !ok {
		return nil, 0, errors.New("workflow jobs response did not include jobs")
	}
	total := len(rawJobs)
	if value, ok := response["total_count"].(float64); ok {
		total = int(value)
	}
	jobs := make([]any, 0, len(rawJobs))
	for _, rawJob := range rawJobs {
		job, ok := rawJob.(map[string]any)
		if !ok {
			return nil, 0, errors.New("workflow jobs response included an invalid job")
		}
		mapped := map[string]any{}
		for field, path := range map[string][]string{
			"databaseId":  {"id"},
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
