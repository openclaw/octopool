package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

const prCommentPageLimit = 10

// A saved gh login can be stale after a rename. Resolve the immutable viewer ID
// with the same native credential, without exposing it to the pooled projection.
func localPRCommentViewer(ctx context.Context, client ghRelayClient) (string, error) {
	if os.Getenv("GH_TOKEN") != "" || os.Getenv("GITHUB_TOKEN") != "" {
		return "", nil
	}
	policy, err := client.stringRewritePolicy(ctx)
	if err != nil {
		return "", err
	}
	args := []string{"api", "user", "--hostname=github.com"}
	for _, arg := range append(append([]string(nil), args...), "https://api.github.com/user") {
		if err := policy.checkStructural(arg); err != nil {
			return "", err
		}
	}
	if err := policy.guardRequest(ghAPIRequest{method: "GET", path: "/user"}); err != nil {
		return "", err
	}
	path, err := resolveGHPath(envDefault("OCTOPOOL_GH_PATH", "gh"))
	if err != nil {
		return "", nil
	}
	child, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var output prReadGitOutput
	cmd := exec.CommandContext(child, path, args...)
	cmd.Stdout = &output
	cmd.WaitDelay = 100 * time.Millisecond
	if cmd.Run() != nil {
		return "", nil
	}
	var viewer struct {
		ID   string `json:"node_id"`
		Type string `json:"type"`
	}
	if json.Unmarshal(output.data.Bytes(), &viewer) != nil || viewer.Type != "User" || strings.TrimSpace(viewer.ID) == "" {
		return "", nil
	}
	return viewer.ID, nil
}

type prDetailPage struct {
	TotalCount *int              `json:"totalCount"`
	Nodes      []json.RawMessage `json:"nodes"`
	PageInfo   struct {
		HasNextPage *bool  `json:"hasNextPage"`
		EndCursor   string `json:"endCursor"`
	} `json:"pageInfo"`
}

func prDetailFallback() error {
	return localFallbackError{Reason: "unsupported_pr_detail_export"}
}

func relayPRDetail(ctx context.Context, client ghRelayClient, repo, number, field, viewer, head string) ([]any, error) {
	shape := publicShapePullRequestComments
	if field == "commits" {
		shape = publicShapePullRequestCommits
		if head == "" {
			return nil, prDetailFallback()
		}
	}
	items := []any{}
	seen, cursors := map[string]bool{}, map[string]bool{}
	cursor, identity, total := "", "", -1
	for page := 0; page < prCommentPageLimit; page++ {
		query := map[string]any{}
		if cursor != "" {
			query["cursor"] = cursor
		}
		envelope, err := client.do(ctx, ghAPIRequest{
			method: "GET", path: repoPath(repo, "pulls", number), query: query,
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
		if json.Unmarshal(body, &response) != nil {
			return nil, prDetailFallback()
		}
		if len(response.Errors) > 0 {
			return nil, errors.New("GraphQL PR detail request failed")
		}
		pr := response.Data.Repository.PullRequest
		var id, pageHead string
		var connection prDetailPage
		if json.Unmarshal(pr["id"], &id) != nil || id == "" ||
			json.Unmarshal(pr[field], &connection) != nil || connection.TotalCount == nil ||
			connection.PageInfo.HasNextPage == nil || connection.Nodes == nil || len(connection.Nodes) > 100 {
			return nil, prDetailFallback()
		}
		if page == 0 {
			identity, total = id, *connection.TotalCount
		}
		if id != identity || *connection.TotalCount != total || total < 0 || total > 100*prCommentPageLimit {
			return nil, prDetailFallback()
		}
		// Native gh exports first:100 commits without pagination. Larger sets
		// retain native handling rather than changing its truncation contract.
		if field == "commits" && (total > 100 || json.Unmarshal(pr["headRefOid"], &pageHead) != nil || pageHead != head) {
			return nil, prDetailFallback()
		}
		for _, node := range connection.Nodes {
			item, key, err := mapPRDetail(node, field, viewer)
			if err != nil || key == "" || seen[key] {
				return nil, prDetailFallback()
			}
			seen[key] = true
			items = append(items, item)
		}
		if !*connection.PageInfo.HasNextPage {
			if len(items) != total {
				return nil, prDetailFallback()
			}
			return items, nil
		}
		cursor = connection.PageInfo.EndCursor
		if len(connection.Nodes) != 100 || len(items) >= total || !validPRDetailCursor(cursor) || cursors[cursor] {
			return nil, prDetailFallback()
		}
		cursors[cursor] = true
	}
	return nil, prDetailFallback()
}

func validPRDetailCursor(cursor string) bool {
	if len(cursor) == 0 || len(cursor) > 512 {
		return false
	}
	for _, c := range cursor {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

type prDetailComment struct {
	ID     string `json:"id"`
	Author struct {
		Login string `json:"login"`
	} `json:"author"`
	AuthorAssociation   string    `json:"authorAssociation"`
	Body                string    `json:"body"`
	CreatedAt           time.Time `json:"createdAt"`
	IncludesCreatedEdit bool      `json:"includesCreatedEdit"`
	IsMinimized         bool      `json:"isMinimized"`
	MinimizedReason     string    `json:"minimizedReason"`
	ReactionGroups      []struct {
		Content string `json:"content"`
		Users   struct {
			TotalCount int `json:"totalCount"`
		} `json:"users"`
	} `json:"reactionGroups"`
	URL             string `json:"url,omitempty"`
	ViewerDidAuthor bool   `json:"viewerDidAuthor"`
}

func mapPRDetail(raw json.RawMessage, field, viewer string) (any, string, error) {
	if field == "comments" {
		var comment prDetailComment
		var identity struct {
			Author struct {
				ID string `json:"id"`
			} `json:"author"`
		}
		if !hasPRDetailKeys(raw, "id", "author", "authorAssociation", "body", "createdAt", "includesCreatedEdit", "isMinimized", "minimizedReason", "reactionGroups", "url") ||
			json.Unmarshal(raw, &comment) != nil || json.Unmarshal(raw, &identity) != nil || viewer == "" {
			return nil, "", prDetailFallback()
		}
		comment.ViewerDidAuthor = identity.Author.ID == viewer
		groups := comment.ReactionGroups[:0]
		for _, group := range comment.ReactionGroups {
			if group.Users.TotalCount != 0 {
				groups = append(groups, group)
			}
		}
		if groups == nil {
			groups = make([]struct {
				Content string `json:"content"`
				Users   struct {
					TotalCount int `json:"totalCount"`
				} `json:"users"`
			}, 0)
		}
		comment.ReactionGroups = groups
		return comment, comment.ID, nil
	}
	var node struct {
		Commit json.RawMessage `json:"commit"`
	}
	if json.Unmarshal(raw, &node) != nil || !hasPRDetailKeys(node.Commit, "authors", "messageHeadline", "messageBody", "oid", "committedDate", "authoredDate") {
		return nil, "", prDetailFallback()
	}
	var commit struct {
		OID, MessageHeadline, MessageBody string
		CommittedDate, AuthoredDate       time.Time
		Authors                           struct {
			Nodes []struct {
				Name, Email string
				User        struct{ ID, Login string }
			}
		}
	}
	if json.Unmarshal(node.Commit, &commit) != nil {
		return nil, "", prDetailFallback()
	}
	authors := []any{}
	for _, author := range commit.Authors.Nodes {
		authors = append(authors, map[string]any{"name": author.Name, "email": author.Email, "id": author.User.ID, "login": author.User.Login})
	}
	return map[string]any{
		"oid": commit.OID, "messageHeadline": commit.MessageHeadline, "messageBody": commit.MessageBody,
		"committedDate": commit.CommittedDate, "authoredDate": commit.AuthoredDate, "authors": authors,
	}, commit.OID, nil
}

func hasPRDetailKeys(raw json.RawMessage, keys ...string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return false
	}
	for _, key := range keys {
		if _, ok := object[key]; !ok {
			return false
		}
	}
	return true
}
