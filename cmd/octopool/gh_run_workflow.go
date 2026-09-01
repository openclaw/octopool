package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

type runWorkflow struct {
	ID    int64
	Name  string
	Path  string
	State string
}

func decodeRunWorkflow(raw []byte) (runWorkflow, error) {
	var workflow runWorkflow
	if err := json.Unmarshal(raw, &workflow); err != nil {
		return workflow, err
	}
	if workflow.ID <= 0 || !safeRunExportInteger(workflow.ID) {
		return workflow, unsupportedRunExport()
	}
	return workflow, nil
}

func lookupRunWorkflow(ctx context.Context, client ghRelayClient, repo, selector string, allowMissing bool) (runWorkflow, bool, error) {
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET", path: repoPath(repo, "actions", "workflows", selector),
	})
	if err != nil {
		return runWorkflow{}, false, err
	}
	// Only an upstream 404 on the unfiltered list's missing-ID lookup is
	// native empty-name evidence. A relay HTTP 404 already returned above.
	if allowMissing && envelope.Status == http.StatusNotFound {
		return runWorkflow{}, true, nil
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return runWorkflow{}, false, err
	}
	workflow, err := decodeRunWorkflow(body)
	return workflow, false, err
}

func resolveRunListWorkflowNames(ctx context.Context, client ghRelayClient, repo, selector string, runs []machineRun) error {
	for _, run := range runs {
		if run.WorkflowID <= 0 {
			return unsupportedRunExport()
		}
	}
	if selector != "" {
		if isDigits(selector) {
			for _, run := range runs {
				if strings.TrimLeft(selector, "0") != strconv.FormatInt(run.WorkflowID, 10) {
					return errors.New("workflow run did not match requested workflow")
				}
			}
		}
		workflow, _, err := lookupRunWorkflow(ctx, client, repo, selector, false)
		if err != nil {
			return err
		}
		if isDigits(selector) {
			if strings.TrimLeft(selector, "0") != strconv.FormatInt(workflow.ID, 10) {
				return errors.New("workflow metadata did not match requested workflow")
			}
		} else {
			if workflow.Path == "" {
				return unsupportedRunExport()
			}
			if workflow.Path != ".github/workflows/"+selector {
				return errors.New("workflow metadata did not match requested workflow file")
			}
		}
		for i := range runs {
			if runs[i].WorkflowID != workflow.ID {
				return errors.New("workflow run did not match selector metadata")
			}
			runs[i].workflowName = workflow.Name
		}
		return nil
	}

	items, err := relayCompleteCollection(ctx, client, ghAPIRequest{
		method: "GET", path: repoPath(repo, "actions", "workflows"),
	}, "workflows")
	if err != nil {
		return err
	}
	names := make(map[int64]string, len(items))
	for _, item := range items {
		// The unchanged complete collector retains json.Number, not float64.
		raw, err := json.Marshal(item)
		if err != nil {
			return err
		}
		workflow, err := decodeRunWorkflow(raw)
		if err != nil {
			return err
		}
		names[workflow.ID] = workflow.Name
	}
	for i := range runs {
		id := runs[i].WorkflowID
		name, found := names[id]
		if !found {
			workflow, missing, err := lookupRunWorkflow(ctx, client, repo, strconv.FormatInt(id, 10), true)
			if err != nil {
				return err
			}
			if !missing && workflow.ID != id {
				return errors.New("workflow metadata did not match run workflow")
			}
			name = workflow.Name
			names[id] = name
		}
		runs[i].workflowName = name
	}
	return nil
}
