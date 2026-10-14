package main

import (
	"context"
	"encoding/json"
)

func relayPRMergeSnapshot(ctx context.Context, client ghRelayClient, repo, number, head string) (map[string]json.RawMessage, error) {
	if !rewriteCommitSHA.MatchString(head) {
		return nil, prDetailFallback()
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method: "GET", path: repoPath(repo, "pulls", number),
		headers: map[string]string{"x-octopool-public-shape": publicShapePullRequestMergeSnapshot, "cache-control": "max-age=0"},
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
