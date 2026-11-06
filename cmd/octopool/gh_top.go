package main

import (
	"context"
	"errors"
	"io"
)

const (
	relayPageSize = 100
	maxRelayPages = 10
)

type ghAction uint8

const (
	ghDelegate ghAction = iota
	ghComplete
	ghFail
	ghHandoffAfterOutput
)

type ghResult struct {
	action ghAction
	err    error
}

// Handlers receive only options admitted by their command-specific read specs.
type ghTopHandler func(context.Context, string, ghTopOptions, io.Writer) ghResult

var ghTopHandlers = map[string]ghTopHandler{
	"pr":       handleGHPR,
	"issue":    handleGHIssue,
	"run":      handleGHRun,
	"repo":     handleGHRepo,
	"release":  handleGHRelease,
	"workflow": handleGHWorkflow,
	"label":    handleGHLabel,
	"gist":     handleGHGist,
	"search":   handleGHSearch,
}

func runGHTopLevel(ctx context.Context, args []string, stdout io.Writer) ghResult {
	if len(args) < 2 {
		return ghDelegated()
	}
	handler, ok := ghTopHandlers[args[0]]
	if !ok {
		return ghDelegated()
	}
	resource, command := args[0], args[1]
	if resource == "run" && command == "watch" {
		return handleGHRunWatch(ctx, args[2:], stdout)
	}
	if resource == "pr" && command == "checks" && hasWatchFlag(args[2:]) {
		return handleGHPRChecksWatch(ctx, args[2:], stdout)
	}
	if resource == "search" && (len(args) < 3 || (command != "issues" && command != "prs" && command != "repos")) {
		return ghDelegated()
	}
	opts, early, ok := prepareGHTopOptions(resource+" "+command, args[2:])
	if !ok {
		return early
	}
	return handler(ctx, command, opts, stdout)
}

func ghDelegated() ghResult {
	return ghResult{action: ghDelegate}
}

func ghCompleted(err error) ghResult {
	if err != nil {
		return ghFailed(err)
	}
	return ghResult{action: ghComplete}
}

func ghFailed(err error) ghResult {
	return ghResult{action: ghFail, err: err}
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
	return writeBytes(ctx, stdout, filtered, opts.jq)
}
