package main

import (
	"context"
	"encoding/json"
	"time"
)

type prAutoMergeAuthor struct {
	ID    string  `json:"id,omitempty"`
	IsBot bool    `json:"is_bot"`
	Login string  `json:"login"`
	Name  *string `json:"name,omitempty"`
}

type prAutoMerge struct {
	AuthorEmail    *string           `json:"authorEmail"`
	CommitBody     *string           `json:"commitBody"`
	CommitHeadline *string           `json:"commitHeadline"`
	MergeMethod    string            `json:"mergeMethod"`
	EnabledAt      time.Time         `json:"enabledAt"`
	EnabledBy      prAutoMergeAuthor `json:"enabledBy"`
}

func relayPRAutoMerge(ctx context.Context, client ghRelayClient, repo, number, head string) (any, error) {
	pr, err := relayPRLandingFields(ctx, client, repo, number, head, publicShapePullRequestAutoMerge)
	if err != nil {
		return nil, err
	}
	return mapPRAutoMerge(pr["autoMergeRequest"])
}

func relayPRLandingFields(ctx context.Context, client ghRelayClient, repo, number, head, shape string) (map[string]json.RawMessage, error) {
	if !rewriteCommitSHA.MatchString(head) {
		return nil, prDetailFallback()
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET", path: repoPath(repo, "pulls", number),
		headers: map[string]string{"x-octopool-public-shape": shape, "cache-control": "max-age=0"},
	})
	if err != nil {
		return nil, err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var response struct {
		Errors []json.RawMessage `json:"errors"`
		Data   struct {
			Repository struct {
				PullRequest map[string]json.RawMessage `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &response) != nil || len(response.Errors) > 0 {
		return nil, prDetailFallback()
	}
	pr := response.Data.Repository.PullRequest
	var id, currentHead string
	if json.Unmarshal(pr["id"], &id) != nil || id == "" || json.Unmarshal(pr["headRefOid"], &currentHead) != nil || currentHead != head {
		return nil, prDetailFallback()
	}
	return pr, nil
}

func mapPRAutoMerge(raw json.RawMessage) (any, error) {
	if string(raw) == "null" {
		return nil, nil
	}
	if !hasPRDetailKeys(raw, "authorEmail", "commitBody", "commitHeadline", "mergeMethod", "enabledAt", "enabledBy") {
		return nil, prDetailFallback()
	}
	var value struct {
		AuthorEmail    *string         `json:"authorEmail"`
		CommitBody     *string         `json:"commitBody"`
		CommitHeadline *string         `json:"commitHeadline"`
		MergeMethod    string          `json:"mergeMethod"`
		EnabledAt      time.Time       `json:"enabledAt"`
		EnabledBy      json.RawMessage `json:"enabledBy"`
	}
	if json.Unmarshal(raw, &value) != nil || value.EnabledAt.IsZero() {
		return nil, prDetailFallback()
	}
	switch value.MergeMethod {
	case "MERGE", "REBASE", "SQUASH":
	default:
		return nil, prDetailFallback()
	}
	var actor struct{ ID, Login, Name string }
	if json.Unmarshal(value.EnabledBy, &actor) != nil || (string(value.EnabledBy) != "null" && !hasPRDetailKeys(value.EnabledBy, "login")) {
		return nil, prDetailFallback()
	}
	var author prAutoMergeAuthor
	if actor.ID != "" {
		if actor.Login == "" {
			return nil, prDetailFallback()
		}
		author = prAutoMergeAuthor{ID: actor.ID, Login: actor.Login, Name: &actor.Name}
	} else {
		author = prAutoMergeAuthor{Login: "app/" + actor.Login, IsBot: true}
	}
	return prAutoMerge{value.AuthorEmail, value.CommitBody, value.CommitHeadline, value.MergeMethod, value.EnabledAt, author}, nil
}
