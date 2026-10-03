package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"time"
)

func handleGHListSearch(ctx context.Context, stdout io.Writer, kind string, opts ghTopOptions) ghResult {
	fields, fieldMap := supportedListSearchFields, fieldMapIssue
	if kind == "pr" {
		fields, fieldMap = supportedPRListSearchFields, fieldMapPR
	}
	// Empty --search does not select native's search path or its ordering.
	if strings.TrimSpace(opts.search) == "" || !machineReadable(opts) || !supportedJSONFields(opts, fields) || limitOverOnePage(opts) {
		return ghDelegated()
	}
	repo, ok, err := repoOnly(opts)
	if err != nil {
		return ghFailed(err)
	}
	if !ok {
		return ghDelegated()
	}
	return ghCompleted(relayGitHubSearch(ctx, stdout, repo, opts.search, kind, opts, fieldMap))
}

func mapListSearchItem(ctx context.Context, client ghRelayClient, item map[string]any, kind string, fields []string, users map[string]map[string]any) error {
	for _, field := range fields {
		if field == "mergedAt" || (field == "state" && kind == "pr") {
			merged, present := valueAtPath(item, "pull_request", "merged_at")
			if !present {
				return localFallbackError{Reason: "missing_search_merge_metadata"}
			}
			if merged != nil {
				value, ok := merged.(string)
				date, err := time.Parse(time.RFC3339, value)
				if !ok || err != nil || date.IsZero() {
					return localFallbackError{Reason: "unsupported_search_merge_metadata"}
				}
			}
			item["merged_at"] = merged
		}
		value, present := mappedValue(item, field, fieldMapPR)
		if !present {
			return localFallbackError{Reason: "missing_list_search_field"}
		}
		switch field {
		case "author":
			author, err := relayPRViewAuthor(ctx, client, value, users)
			if err != nil {
				return err
			}
			item["user"] = author
		case "labels":
			labels, err := mapPRViewLabels(value)
			if err != nil {
				return err
			}
			// Native's GraphQL label connection is bounded to 100 nodes.
			if len(labels) > 100 {
				return localFallbackError{Reason: "unsupported_list_search_labels"}
			}
			item["labels"] = labels
		case "state":
			state := firstString(item, "state")
			if state != "open" && state != "closed" && !(kind == "pr" && state == "merged") {
				return localFallbackError{Reason: "unsupported_list_search_state"}
			}
			item["state"] = strings.ToUpper(state)
		case "body":
			if value == nil {
				item["body"] = ""
			} else if _, ok := value.(string); !ok {
				return localFallbackError{Reason: "unsupported_list_search_body"}
			}
		case "isDraft":
			if _, ok := value.(bool); !ok {
				return localFallbackError{Reason: "unsupported_list_search_draft"}
			}
		case "number":
			number, ok := value.(float64)
			if !ok || number < 1 || number != math.Trunc(number) {
				return localFallbackError{Reason: "unsupported_list_search_number"}
			}
		case "title", "url":
			if _, ok := value.(string); !ok {
				return localFallbackError{Reason: "unsupported_list_search_text"}
			}
		case "createdAt", "updatedAt", "closedAt":
			if value == nil && field == "closedAt" {
				continue
			}
			text, ok := value.(string)
			if _, err := time.Parse(time.RFC3339, text); !ok || err != nil {
				return localFallbackError{Reason: "unsupported_list_search_timestamp"}
			}
		}
	}
	return nil
}

// Search exports use gh's REST User, not the GraphQL Author used by list/view.
func searchUser(raw any) map[string]any {
	user, _ := raw.(map[string]any)
	id, login := firstString(user, "node_id"), firstString(user, "login")
	if id == "" {
		login = "app/" + login
	}
	return map[string]any{
		"id": id, "login": login, "is_bot": id == "",
		"type": firstString(user, "type"), "url": firstString(user, "html_url"),
	}
}

func mapTopSearchItem(item map[string]any, fields []string) error {
	for _, field := range fields {
		switch field {
		case "author":
			item["user"] = searchUser(item["user"])
		case "assignees":
			users, _ := item["assignees"].([]any)
			mapped := make([]any, 0, len(users))
			for _, user := range users {
				mapped = append(mapped, searchUser(user))
			}
			item["assignees"] = mapped
		case "labels":
			labels, err := mapPRViewLabels(item["labels"])
			if err != nil {
				return err
			}
			item["labels"] = labels
		case "closedAt", "createdAt", "updatedAt":
			key := fieldMapIssue[field][0]
			item[key] = ghCheckTimestamp(item, key)
		case "body":
			if item["body"] == nil {
				item["body"] = ""
			}
		}
	}
	return nil
}

func searchFallbackError(err error) error {
	var relay *relayResponseError
	if errors.As(err, &relay) && (relay.Status == 403 || relay.Status == 429) {
		switch relay.Code {
		case "search_denied", "github_rate_limited", "github_secondary_rate_limited":
			return localFallbackError{Reason: relay.Code}
		}
	}
	return err
}

func searchRateLimited(envelope relayEnvelope) bool {
	if envelope.Status == 429 {
		return true
	}
	if envelope.Status != 403 {
		return false
	}
	if envelope.Headers["retry-after"] != "" || envelope.Headers["x-ratelimit-remaining"] == "0" {
		return true
	}
	body, err := decodeRelayBody(envelope)
	if err != nil {
		return false
	}
	var response struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &response) != nil {
		return false
	}
	message := strings.ToLower(response.Message)
	return strings.Contains(message, "rate limit") || strings.Contains(message, "abuse detection")
}
