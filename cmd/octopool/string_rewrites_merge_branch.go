package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// Attached only to a prepared protected merge; never reparses original arguments.
type rewriteMergeBranchCleanup struct {
	repo, number string
	remote       bool
	pr           *rewriteMergePR
}

type rewriteMergeRepository struct {
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
}

type rewriteMergePR struct {
	State  string `json:"state"`
	Merged *bool  `json:"merged"`
	Head   struct {
		Ref  string                  `json:"ref"`
		Repo *rewriteMergeRepository `json:"repo"`
	} `json:"head"`
	Base struct {
		Repo *rewriteMergeRepository `json:"repo"`
	} `json:"base"`
}

type rewriteMergeState struct{ repo, number string }

func (state *rewriteMergeState) inspect(ctx context.Context, ghPath string, env []string, prepared *rewritePreparation, stderr io.Writer) (bool, error) {
	path := repoPath(state.repo, "pulls", state.number)
	if err := prepared.policy.guardRequest(ghAPIRequest{method: http.MethodGet, path: path}); err != nil {
		return false, err
	}
	args := []string{"api", strings.TrimPrefix(path, "/"), "--method=GET", "--hostname=github.com"}
	for _, arg := range args {
		if err := prepared.policy.checkStructural(arg); err != nil {
			return false, err
		}
	}
	child, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, ghPath, args...)
	// This response is machine input even when the caller forces terminal output.
	cmd.Env = append(envWithGitHubHost(env), "GH_FORCE_TTY=", "NO_COLOR=1")
	cmd.Stdin = strings.NewReader("")
	var output rewritePreflightOutput
	cmd.Stdout = &output
	journalNativeDelegation(context.WithValue(ctx, nativeJournalCategoryKey{}, "preflight"), args, cmd.Env, "")
	if err := cmd.Run(); err != nil {
		return false, errors.New("could not inspect GitHub pull request merge state")
	}
	var pr rewriteMergePR
	if json.Unmarshal(output.data.Bytes(), &pr) != nil {
		return false, errors.New("invalid GitHub pull request merge state")
	}
	if pr.Merged == nil || (pr.State != "open" && pr.State != "closed") || (*pr.Merged && pr.State != "closed") {
		return false, errors.New("invalid GitHub pull request merge state")
	}
	if *pr.Merged {
		// Native gh warns even without --delete-branch and skips remote deletion
		// for an already-merged PR. No publication or cleanup child is needed.
		fmt.Fprintf(stderr, "! Pull request %s#%s was already merged\n", state.repo, state.number)
		return true, nil
	}
	if cleanup := prepared.mergeBranchCleanup; cleanup != nil {
		cleanup.pr = &pr
	}
	return false, nil
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
	pr := cleanup.pr
	if pr == nil {
		pr = &rewriteMergePR{}
		if _, err := restPRRequest(ctx, client, token, policy, http.MethodGet, repoPath(cleanup.repo, "pulls", cleanup.number), nil, http.StatusOK, pr); err != nil {
			return err
		}
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
