package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"time"
)

type rewritePolicyClass uint8

const (
	rewritePolicySetup rewritePolicyClass = iota
	rewritePolicyRequest
	rewritePolicyTransport
	rewritePolicyTimeoutClass
	rewritePolicyCanceled
	rewritePolicyHTTPStatus
	rewritePolicyResponseRead
	rewritePolicyResponseSize
	rewritePolicyServerValidation
	rewritePolicyLocalRead
	rewritePolicyLocalValidation
	rewritePolicyMerge
)

func (class rewritePolicyClass) String() string {
	switch class {
	case rewritePolicySetup:
		return "setup"
	case rewritePolicyRequest:
		return "request"
	case rewritePolicyTransport:
		return "transport"
	case rewritePolicyTimeoutClass:
		return "timeout"
	case rewritePolicyCanceled:
		return "canceled"
	case rewritePolicyHTTPStatus:
		return "http_status"
	case rewritePolicyResponseRead:
		return "response_read"
	case rewritePolicyResponseSize:
		return "response_size"
	case rewritePolicyServerValidation:
		return "server_validation"
	case rewritePolicyLocalRead:
		return "local_read"
	case rewritePolicyLocalValidation:
		return "local_validation"
	case rewritePolicyMerge:
		return "merge"
	default:
		return "unknown"
	}
}

// The attempt starts before HTTP validation and continues through local/merge
// checks. Setup failures instead start before client setup; no request occurred.
type rewritePolicyAttempt struct {
	started time.Time
	status  int
	ray     string
}

// Retain only safe metadata, never an underlying error or response document.
type rewritePolicyError struct {
	class rewritePolicyClass
	rewritePolicyAttempt
	elapsed time.Duration
}

func (attempt rewritePolicyAttempt) failure(class rewritePolicyClass) error {
	return &rewritePolicyError{class: class, rewritePolicyAttempt: attempt, elapsed: time.Since(attempt.started)}
}

func (err *rewritePolicyError) Is(target error) bool { return target == errRewritePolicy }

func (err *rewritePolicyError) Error() string {
	text := fmt.Sprintf("%s (class=%s attempt_utc=%s elapsed_ms=%d", errRewritePolicy,
		err.class, err.started.UTC().Format(time.RFC3339Nano), max(0, err.elapsed.Milliseconds()))
	if err.status != 0 {
		text += fmt.Sprintf(" http_status=%d", err.status)
	}
	if err.ray != "" {
		text += " cf_ray=" + err.ray
	}
	return text + ")"
}

func rewritePolicyTransportClass(err error) rewritePolicyClass {
	if errors.Is(err, context.Canceled) {
		return rewritePolicyCanceled
	}
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &network) && network.Timeout() {
		return rewritePolicyTimeoutClass
	}
	return rewritePolicyTransport
}

var rewritePolicyRayPattern = regexp.MustCompile(`\A[0-9a-fA-F]{16}(-[A-Z]{3})?\z`)

func safeRewritePolicyRay(header http.Header) string {
	values := header.Values("CF-Ray")
	if len(values) != 1 || (len(values[0]) != 16 && len(values[0]) != 20) || !rewritePolicyRayPattern.MatchString(values[0]) {
		return ""
	}
	return values[0]
}
