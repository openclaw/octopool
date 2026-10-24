package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Attached only to a prepared protected merge; never reparses original arguments.
type rewriteMergeBranchCleanup struct {
	repo, number string
	remote       bool
}

func (cleanup *rewriteMergeBranchCleanup) execute(ctx context.Context, ghPath string, env []string, policy stringRewritePolicy, stderr io.Writer) error {
	err := cleanup.run(ctx, ghPath, env, policy, stderr)
	if err == nil {
		return nil
	}
	if !cleanup.remote {
		// Native --auto may only have scheduled a merge. Local inspection is a
		// courtesy and must not turn successful scheduling into a merge failure.
		fmt.Fprintln(stderr, "octopool: local branches kept; could not inspect the pull request head")
		return nil
	}
	return fmt.Errorf("octopool: merge succeeded but branch deletion failed: %w", err)
}

func (cleanup *rewriteMergeBranchCleanup) run(ctx context.Context, ghPath string, env []string, policy stringRewritePolicy, stderr io.Writer) error {
	token, err := nativeRESTWriteToken(ctx, ghPath, env)
	if err != nil {
		return errors.New("could not resolve caller credentials")
	}
	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	type repository struct {
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
	}
	var pr struct {
		Head struct {
			Ref  string      `json:"ref"`
			Repo *repository `json:"repo"`
		} `json:"head"`
		Base struct {
			Repo *repository `json:"repo"`
		} `json:"base"`
	}
	if _, err := restPRRequest(ctx, client, token, policy, http.MethodGet, repoPath(cleanup.repo, "pulls", cleanup.number), nil, http.StatusOK, &pr); err != nil {
		return err
	}
	if !validRewriteBaseBranch(pr.Head.Ref) {
		return errors.New("invalid GitHub pull request head branch")
	}
	if _, err := gitProbe("show-ref", "--verify", "--quiet", "refs/heads/"+pr.Head.Ref); err == nil {
		fmt.Fprintln(stderr, "octopool: kept the local head branch; local branches are never switched or deleted")
	}
	if !cleanup.remote {
		return nil
	}
	if pr.Base.Repo == nil || !strings.EqualFold(pr.Base.Repo.FullName, cleanup.repo) {
		return errors.New("invalid GitHub pull request base repository")
	}
	if pr.Head.Repo == nil || !strings.EqualFold(pr.Head.Repo.FullName, pr.Base.Repo.FullName) {
		fmt.Fprintln(stderr, "octopool: Skipped deleting the remote branch of a pull request from fork")
		return nil
	}
	if pr.Base.Repo.DefaultBranch == "" {
		return errors.New("GitHub did not identify the repository default branch")
	}
	if pr.Head.Ref == pr.Base.Repo.DefaultBranch {
		fmt.Fprintln(stderr, "octopool: skipped deleting the repository default branch")
		return nil
	}
	// repoPath escapes the entire ref as one parameter, including embedded slashes.
	path := repoPath(cleanup.repo, "git", "refs", "heads", pr.Head.Ref)
	_, err = restPRRequest(ctx, client, token, policy, http.MethodDelete, path, nil, http.StatusNoContent, nil)
	var failure *restPRHTTPError
	if errors.As(err, &failure) && (failure.status == http.StatusUnprocessableEntity || failure.status == http.StatusNotFound) && failure.message == "Reference does not exist" {
		return nil
	}
	return err
}
