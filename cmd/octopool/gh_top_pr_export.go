package main

import (
	"context"
	"strings"
)

func relayPRViewAuthor(ctx context.Context, client ghRelayClient, raw any, users map[string]map[string]any) (map[string]any, error) {
	// gh's author query selects id/name only for User. Its zero Author value
	// (including a null/deleted actor) uses the same two-key export as bots.
	if raw == nil {
		return map[string]any{"is_bot": true, "login": "app/"}, nil
	}
	user, _ := raw.(map[string]any)
	login := firstString(user, "login")
	if login == "" {
		return nil, localFallbackError{Reason: "unsupported pull request author identity"}
	}
	switch firstString(user, "type") {
	case "Bot":
		slug, ok := strings.CutSuffix(login, "[bot]")
		if !ok || slug == "" {
			return nil, localFallbackError{Reason: "unsupported pull request bot login"}
		}
		return map[string]any{"is_bot": true, "login": "app/" + slug}, nil
	case "User":
		profile, err := relayPRUser(ctx, client, raw, users)
		if err != nil {
			return nil, err
		}
		if profile["type"] != "User" {
			return nil, localFallbackError{Reason: "pull request author profile type changed"}
		}
		return map[string]any{
			"id": profile["node_id"], "is_bot": false,
			"login": profile["login"], "name": firstString(profile, "name"),
		}, nil
	default:
		return nil, localFallbackError{Reason: "unsupported pull request author type"}
	}
}

func mapPRViewLabels(raw any) ([]any, error) {
	labels, ok := raw.([]any)
	if !ok {
		return nil, localFallbackError{Reason: "pull request response did not include labels array"}
	}
	out := make([]any, 0, len(labels))
	for _, raw := range labels {
		label, _ := raw.(map[string]any)
		name, nameOK := label["name"].(string)
		color, colorOK := label["color"].(string)
		description, descriptionPresent := label["description"]
		_, descriptionOK := description.(string)
		if firstString(label, "node_id") == "" || !nameOK || !colorOK || !descriptionPresent || (description != nil && !descriptionOK) {
			return nil, localFallbackError{Reason: "unsupported pull request label shape"}
		}
		out = append(out, map[string]any{
			"id": label["node_id"], "name": name, "color": color,
			"description": firstString(label, "description"),
		})
	}
	return out, nil
}
