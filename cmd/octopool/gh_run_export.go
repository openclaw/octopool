package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The relay's JS transport may already have rounded upstream numbers. This is
// an observed-response eligibility bound, not a lossless transport guarantee.
const runExportMaxInteger = 1<<53 - 1

// Keep native acquisition fields typed even when they are not exportable.
type machineRun struct {
	ID             int64
	Name           string
	DisplayTitle   string    `json:"display_title"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	StartedAt      time.Time `json:"run_started_at"`
	Status         string
	Conclusion     string
	Event          string
	WorkflowID     int64                    `json:"workflow_id"`
	Number         int64                    `json:"run_number"`
	Attempt        uint64                   `json:"run_attempt"`
	HeadBranch     string                   `json:"head_branch"`
	HeadSha        string                   `json:"head_sha"`
	JobsURL        string                   `json:"jobs_url"`
	URL            string                   `json:"html_url"`
	HeadCommit     struct{ Message string } `json:"head_commit"`
	HeadRepository struct {
		Owner struct{ Login string }
		Name  string
	} `json:"head_repository"`
	workflowName string
	jobs         []machineJobExport
}

// Null is a no-op for native primitive fields, including after a duplicate
// non-null assignment. A pointer would incorrectly erase association evidence.
type runAssociation[T int64 | string] struct {
	value   T
	present bool
}

func (a *runAssociation[T]) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	if err := json.Unmarshal(raw, &a.value); err != nil {
		return err
	}
	a.present = true
	return nil
}

type machineJob struct {
	ID          int64
	Name        string
	Status      string
	Conclusion  string
	StartedAt   time.Time              `json:"started_at"`
	CompletedAt time.Time              `json:"completed_at"`
	URL         string                 `json:"html_url"`
	RunID       runAssociation[int64]  `json:"run_id"`
	HeadSha     runAssociation[string] `json:"head_sha"`
	Steps       []machineStep
}

type machineStep struct {
	Name        string
	Status      string
	Conclusion  string
	Number      int
	StartedAt   time.Time `json:"started_at"`
	CompletedAt time.Time `json:"completed_at"`
}

func (s *machineStep) UnmarshalJSON(raw []byte) error {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return errors.New("workflow jobs response included an invalid step")
	}
	type step machineStep
	return json.Unmarshal(raw, (*step)(s))
}

type machineJobExport struct {
	DatabaseID  int64               `json:"databaseId"`
	Name        string              `json:"name"`
	Status      string              `json:"status"`
	Conclusion  string              `json:"conclusion"`
	StartedAt   time.Time           `json:"startedAt"`
	CompletedAt time.Time           `json:"completedAt"`
	URL         string              `json:"url"`
	Steps       []machineStepExport `json:"steps"`
}

type machineStepExport struct {
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Conclusion  string    `json:"conclusion"`
	Number      int       `json:"number"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt"`
}

func unsupportedRunExport() error {
	return localFallbackError{Reason: "unsupported_run_export"}
}

func safeRunExportInteger(value int64) bool {
	return value >= -runExportMaxInteger && value <= runExportMaxInteger
}

func decodeMachineRun(raw []byte) (machineRun, error) {
	var run machineRun
	if err := json.Unmarshal(raw, &run); err != nil {
		return run, err
	}
	return run, validateMachineRun(run)
}

func validateMachineRun(run machineRun) error {
	if run.ID <= 0 || !safeRunExportInteger(run.ID) || !safeRunExportInteger(run.Number) ||
		!safeRunExportInteger(run.WorkflowID) || run.Attempt > runExportMaxInteger {
		return unsupportedRunExport()
	}
	return nil
}

func relayMachineRunList(ctx context.Context, stdout io.Writer, request ghAPIRequest, repo string, opts ghTopOptions) error {
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
	var response struct {
		TotalCount int             `json:"total_count"`
		Runs       json.RawMessage `json:"workflow_runs"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return err
	}
	raw := bytes.TrimSpace(response.Runs)
	if len(raw) == 0 || raw[0] != '[' || !safeRunExportInteger(int64(response.TotalCount)) {
		return unsupportedRunExport()
	}
	var runs []machineRun
	if err := json.Unmarshal(raw, &runs); err != nil {
		return err
	}
	if len(runs) > desiredLimitDefault(opts, 20) {
		return unsupportedRunExport()
	}
	for _, run := range runs {
		if err := validateMachineRun(run); err != nil {
			return err
		}
	}
	if hasJSONField(opts.json, "workflowName") && len(runs) > 0 {
		if err := resolveRunListWorkflowNames(ctx, client, repo, opts.workflow, runs); err != nil {
			return err
		}
	}
	result := make([]map[string]any, 0, len(runs))
	for _, run := range runs {
		result = append(result, run.export(opts.json))
	}
	return writeRunExport(ctx, stdout, result, opts.jq)
}

func relayMachineRunView(ctx context.Context, stdout io.Writer, repo, id string, opts ghTopOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	runPath := repoPath(repo, "actions", "runs", id)
	if opts.attemptSet && opts.attempt != 0 {
		runPath = repoPath(repo, "actions", "runs", id, "attempts", strconv.Itoa(opts.attempt))
	}
	envelope, err := client.do(ctx, ghAPIRequest{method: "GET", path: runPath})
	if err != nil {
		return err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return err
	}
	run, err := decodeMachineRun(body)
	if err != nil {
		return err
	}
	if strings.TrimLeft(id, "0") != strconv.FormatInt(run.ID, 10) {
		return errors.New("workflow run response did not match requested run")
	}
	if hasJSONField(opts.json, "workflowName") && run.WorkflowID <= 0 {
		return unsupportedRunExport()
	}
	if opts.attemptSet && opts.attempt != 0 {
		run.URL, err = url.JoinPath(run.URL, fmt.Sprintf("/attempts/%d", opts.attempt))
		if err != nil {
			return err
		}
	}
	if hasJSONField(opts.json, "jobs") {
		if run.Attempt == 0 {
			return localFallbackError{Reason: "workflow run response did not include run_attempt"}
		}
		envelope, err := client.do(ctx, ghAPIRequest{
			method: "GET",
			path:   repoPath(repo, "actions", "runs", id, "attempts", strconv.FormatUint(run.Attempt, 10), "jobs"),
			query:  map[string]any{"per_page": "100"},
		})
		if err != nil {
			return err
		}
		run.jobs, err = machineRunJobs(envelope, run)
		if err != nil {
			return err
		}
	}
	if hasJSONField(opts.json, "workflowName") {
		workflow, _, err := lookupRunWorkflow(ctx, client, repo, strconv.FormatInt(run.WorkflowID, 10), false)
		if err != nil {
			return err
		}
		if workflow.ID != run.WorkflowID {
			return errors.New("workflow metadata did not match run workflow")
		}
		run.workflowName = workflow.Name
	}
	return writeRunExport(ctx, stdout, run.export(opts.json), opts.jq)
}

func machineRunJobs(envelope relayEnvelope, run machineRun) ([]machineJobExport, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var response struct {
		Total json.RawMessage `json:"total_count"`
		Jobs  json.RawMessage `json:"jobs"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	var total int64
	if len(response.Total) == 0 || bytes.Equal(response.Total, []byte("null")) || json.Unmarshal(response.Total, &total) != nil || total < 0 {
		return nil, localFallbackError{Reason: "workflow jobs response did not include a valid total_count"}
	}
	raw := bytes.TrimSpace(response.Jobs)
	if len(raw) == 0 || raw[0] != '[' {
		return nil, unsupportedRunExport()
	}
	var records []json.RawMessage
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, err
	}
	if len(records) > 100 || total > int64(len(records)) {
		return nil, localFallbackError{Reason: "workflow jobs response requires pagination"}
	}
	_, next := relayNextLink(envelope.Headers["link"])
	if total != int64(len(records)) || next {
		return nil, unsupportedRunExport()
	}
	jobs := make([]machineJobExport, 0, len(records))
	seen := map[int64]bool{}
	for _, record := range records {
		if bytes.TrimSpace(record)[0] != '{' {
			return nil, unsupportedRunExport()
		}
		var job machineJob
		if err := json.Unmarshal(record, &job); err != nil {
			return nil, err
		}
		if job.ID <= 0 || !safeRunExportInteger(job.ID) || seen[job.ID] || !safeRunExportInteger(job.RunID.value) {
			return nil, unsupportedRunExport()
		}
		seen[job.ID] = true
		if job.RunID.present && job.RunID.value != run.ID {
			return nil, errors.New("workflow job did not match owned run")
		}
		if job.HeadSha.present && job.HeadSha.value != "" {
			if run.HeadSha == "" {
				return nil, unsupportedRunExport()
			}
			if job.HeadSha.value != run.HeadSha {
				return nil, errors.New("workflow job did not match historical run head")
			}
		}
		steps := make([]machineStepExport, 0, len(job.Steps))
		for _, step := range job.Steps {
			if !safeRunExportInteger(int64(step.Number)) {
				return nil, unsupportedRunExport()
			}
			completed := step.CompletedAt
			if completed.IsZero() {
				completed = time.Time{}
			}
			steps = append(steps, machineStepExport{step.Name, step.Status, step.Conclusion, step.Number, step.StartedAt, completed})
		}
		completed := job.CompletedAt
		if completed.IsZero() {
			completed = time.Time{}
		}
		jobs = append(jobs, machineJobExport{job.ID, job.Name, job.Status, job.Conclusion, job.StartedAt, completed, job.URL, steps})
	}
	return jobs, nil
}

func (run machineRun) export(fields []string) map[string]any {
	result := make(map[string]any, len(fields))
	for _, field := range fields {
		switch field {
		case "databaseId":
			result[field] = run.ID
		case "name":
			result[field] = run.Name
		case "workflowName":
			result[field] = run.workflowName
		case "displayTitle":
			result[field] = run.DisplayTitle
		case "headBranch":
			result[field] = run.HeadBranch
		case "headSha":
			result[field] = run.HeadSha
		case "status":
			result[field] = run.Status
		case "conclusion":
			result[field] = run.Conclusion
		case "event":
			result[field] = run.Event
		case "url":
			result[field] = run.URL
		case "createdAt":
			result[field] = run.CreatedAt
		case "updatedAt":
			result[field] = run.UpdatedAt
		case "number":
			result[field] = run.Number
		case "attempt":
			result[field] = run.Attempt
		case "jobs":
			result[field] = run.jobs
		}
	}
	return result
}

func writeRunExport(ctx context.Context, stdout io.Writer, value any, jq string) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	return writeBytes(ctx, stdout, buffer.Bytes(), jq)
}
