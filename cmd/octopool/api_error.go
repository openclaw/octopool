package main

import (
	"encoding/json"
	"fmt"
)

type apiErrorDetails struct {
	GitHubRateLimitReset     string `json:"github_rate_limit_reset"`
	GitHubRateLimitRemaining string `json:"github_rate_limit_remaining"`
	GitHubRateLimitResource  string `json:"github_rate_limit_resource"`
	GitHubRetryAfter         string `json:"github_retry_after"`
	FallbackReason           string `json:"reason"`
}

type apiError struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	RequestID string          `json:"request_id"`
	Details   apiErrorDetails `json:"details"`
}

type apiErrorResponse struct {
	Error apiError `json:"error"`
}

// relayResponseError is the single decoded representation of a non-2xx relay response.
type relayResponseError struct {
	Status int
	apiError
}

func parseRelayResponseError(status int, out []byte) *relayResponseError {
	parsed := apiErrorResponse{}
	if err := json.Unmarshal(out, &parsed); err != nil || parsed.Error.Code == "" {
		return &relayResponseError{Status: status}
	}
	return &relayResponseError{Status: status, apiError: parsed.Error}
}

func (err *relayResponseError) Error() string {
	label := fmt.Sprintf("octopool request failed (HTTP %d", err.Status)
	if err.Code != "" {
		label += ", " + err.Code
	}
	label += ")"
	detail := err.Message
	if detail == "" {
		detail = "malformed relay error response"
	}
	if err.RequestID != "" {
		return fmt.Sprintf("%s: %s (request_id: %s)", label, detail, err.RequestID)
	}
	return label + ": " + detail
}
