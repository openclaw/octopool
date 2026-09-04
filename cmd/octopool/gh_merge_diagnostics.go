package main

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type ghMergeRoute uint8

const (
	ghMergeUndetermined ghMergeRoute = iota
	ghMergeNative
	ghMergeREST
)

// Only final preparation owns these facts. A server revision does not identify
// locally merged rules; captureHeaders marks our generated silent REST request.
type ghMergePreparation struct {
	route          ghMergeRoute
	policyKnown    bool
	serverRevision int64
	effectiveRules int
	captureHeaders bool
}

func ghMergeDiagnosticsEnabled(args []string) bool {
	return os.Getenv("OCTOPOOL_DIAGNOSTICS") == "1" && len(args) >= 2 &&
		args[0] == "pr" && args[1] == "merge" && !rewriteBootstrapInvocation(args)
}

const ghMergeIncludeFlag = "--include=true"

func ghMergeArgBytes(args []string) int {
	total := 0
	for _, arg := range args {
		total += len(arg)
	}
	return total
}

func ghMergeIncludeAllowed(policy stringRewritePolicy, original, generated []string) bool {
	// Check the name, semantic value, and exact spelling emitted by the API owner.
	for _, text := range []string{"--include", "true", ghMergeIncludeFlag} {
		if policy.checkStructural(text) != nil {
			return false
		}
	}
	return ghMergeArgBytes(original)+len(ghMergeIncludeFlag) <= rewriteMaxContent &&
		ghMergeArgBytes(generated)+len(ghMergeIncludeFlag) <= rewriteMaxContent
}

type ghMergeOutcome uint8

const (
	ghMergePreparationFailed ghMergeOutcome = iota
	ghMergeStartFailed
	ghMergeCanceledBeforeStart
	ghMergeSucceeded
	ghMergeExited
	ghMergeWaitFailed
	ghMergeCanceled
)

func (outcome ghMergeOutcome) String() string {
	switch outcome {
	case ghMergePreparationFailed:
		return "preparation_failed"
	case ghMergeStartFailed:
		return "start_failed"
	case ghMergeCanceledBeforeStart:
		return "canceled_before_start"
	case ghMergeSucceeded:
		return "succeeded"
	case ghMergeExited:
		return "exited"
	case ghMergeWaitFailed:
		return "wait_failed"
	case ghMergeCanceled:
		return "canceled"
	default:
		return "unknown"
	}
}

type ghMergeDiagnostic struct {
	attempt      time.Time
	preparation  *ghMergePreparation
	outcome      ghMergeOutcome
	childStarted bool
	exitCode     *int
	headers      *ghMergeHeaderCollector
}

func (diagnostic *ghMergeDiagnostic) writeTo(stderr io.Writer) {
	if stderr == nil {
		return
	}
	var line strings.Builder
	fmt.Fprintf(&line, "octopool: merge_diagnostics attempt_utc=%s elapsed_ms=%d child_started=%t outcome=%s",
		diagnostic.attempt.UTC().Format(time.RFC3339Nano), max(0, time.Since(diagnostic.attempt).Milliseconds()),
		diagnostic.childStarted, diagnostic.outcome)
	if prepared := diagnostic.preparation; prepared != nil {
		switch prepared.route {
		case ghMergeNative:
			line.WriteString(" route=native")
		case ghMergeREST:
			line.WriteString(" route=rest_put")
		}
		if prepared.policyKnown && prepared.serverRevision >= 0 && prepared.effectiveRules >= 0 && prepared.effectiveRules <= rewriteMaxRules {
			fmt.Fprintf(&line, " server_policy_revision=%d effective_rule_count=%d", prepared.serverRevision, prepared.effectiveRules)
		}
	}
	if diagnostic.exitCode != nil {
		fmt.Fprintf(&line, " exit_code=%d", *diagnostic.exitCode)
	}
	if headers, ok := diagnostic.headers.result(); ok {
		fmt.Fprintf(&line, " headers=available http_status=%d", headers.status)
		if headers.requestID != "" {
			fmt.Fprintf(&line, " request_id=%s", headers.requestID)
		}
		if headers.resource != "" {
			fmt.Fprintf(&line, " resource=%s", headers.resource)
		}
		for i, name := range ghMergeNumericFields {
			if value := headers.numbers[i]; value != nil {
				fmt.Fprintf(&line, " %s=%d", name, *value)
			}
		}
	} else {
		line.WriteString(" headers=unavailable")
	}
	line.WriteByte('\n')
	// Observability cannot change the native result or cause a second attempt.
	_, _ = io.WriteString(stderr, line.String())
}

const (
	ghMergeHeaderLineLimit  = 4 * 1024
	ghMergeHeaderBlockLimit = 32 * 1024
)

var ghMergeStatusLine = regexp.MustCompile(`^HTTP/(?:1\.[01]|2\.0) ([1-5][0-9]{2}) [\x20-\x7e]+$`)
var ghMergeRequestID = regexp.MustCompile(`^[0-9A-Fa-f]+(?::[0-9A-Fa-f]+)+$`)
var ghMergeHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
var ghMergeNumericFields = [...]string{"limit", "remaining", "used", "reset", "retry_after"}

// All fields are withheld on any invalid framing or selected value. Nothing in
// this buffer ever falls through to stdout, including after overflow or EOF.
type ghMergeHeaders struct {
	status    int
	requestID string
	resource  string
	numbers   [5]*int64
}

type ghMergeHeaderCollector struct {
	line    [ghMergeHeaderLineLimit]byte
	length  int
	total   int
	started bool
	done    bool
	invalid bool
	seen    [7]bool
	fields  ghMergeHeaders
}

func (collector *ghMergeHeaderCollector) Write(data []byte) (int, error) {
	for _, b := range data {
		if collector.invalid {
			break
		}
		collector.total++
		if collector.done || collector.total > ghMergeHeaderBlockLimit || collector.length == len(collector.line) {
			collector.invalid = true
			break
		}
		collector.line[collector.length] = b
		collector.length++
		if b == '\n' {
			collector.readLine(string(collector.line[:collector.length]))
			collector.length = 0
		}
	}
	// Always drain, even after rejection: a pipe error must not affect a write.
	return len(data), nil
}

func (collector *ghMergeHeaderCollector) readLine(line string) {
	if !collector.started {
		match := ghMergeStatusLine.FindStringSubmatch(strings.TrimSuffix(line, "\n"))
		if match == nil {
			collector.invalid = true
			return
		}
		collector.fields.status, _ = strconv.Atoi(match[1])
		collector.started = true
		return
	}
	if !strings.HasSuffix(line, "\r\n") {
		collector.invalid = true
		return
	}
	line = strings.TrimSuffix(line, "\r\n")
	if line == "" {
		collector.done = true
		return
	}
	name, value, ok := strings.Cut(line, ": ")
	// Only the header-name wrapper proven by the opt-in native protocol fixture.
	if strings.HasPrefix(name, "\x1b[1;34m") && strings.HasSuffix(name, "\x1b[m") {
		name = strings.TrimSuffix(strings.TrimPrefix(name, "\x1b[1;34m"), "\x1b[m")
	}
	if !ok || !ghMergeHeaderName.MatchString(name) {
		collector.invalid = true
		return
	}
	for _, b := range []byte(value) {
		if b < 32 || b > 126 {
			collector.invalid = true
			return
		}
	}
	index := -1
	switch strings.ToLower(name) {
	case "x-ratelimit-limit":
		index = 0
	case "x-ratelimit-remaining":
		index = 1
	case "x-ratelimit-used":
		index = 2
	case "x-ratelimit-reset":
		index = 3
	case "retry-after":
		index = 4
	case "x-github-request-id":
		index = 5
	case "x-ratelimit-resource":
		index = 6
	}
	if index < 0 {
		return
	}
	if collector.seen[index] {
		collector.invalid = true
		return
	}
	collector.seen[index] = true
	switch index {
	case 5:
		if len(value) > 128 || !ghMergeRequestID.MatchString(value) {
			collector.invalid = true
			return
		}
		collector.fields.requestID = value
	case 6:
		switch value {
		case "core", "search", "graphql", "integration_manifest", "code_search":
			collector.fields.resource = value
		default:
			collector.invalid = true
		}
	default:
		if len(value) == 0 || len(value) > 19 || !isDigits(value) {
			collector.invalid = true
			return
		}
		number, err := strconv.ParseInt(value, 10, 64)
		if err != nil || number < 0 {
			collector.invalid = true
			return
		}
		collector.fields.numbers[index] = &number
	}
}

func (collector *ghMergeHeaderCollector) result() (ghMergeHeaders, bool) {
	if collector == nil || collector.invalid || !collector.done || collector.length != 0 {
		return ghMergeHeaders{}, false
	}
	return collector.fields, true
}
