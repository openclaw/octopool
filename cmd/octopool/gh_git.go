package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"time"
)

const gitProbeTimeout = 10 * time.Second

type gitUnavailableError struct {
	path string
	err  error
}

func (err *gitUnavailableError) Error() string {
	return fmt.Sprintf("octopool: git unavailable (%s): %v; pass -R owner/repo or fix git", err.path, err.err)
}

func (err *gitUnavailableError) Unwrap() error { return err.err }

func gitProbe(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitProbeTimeout)
	defer cancel()
	return gitProbeContext(ctx, args...)
}

func gitProbeContext(ctx context.Context, args ...string) (string, error) {
	path, err := exec.LookPath("git")
	if err != nil {
		return "", &gitUnavailableError{path: "git", err: err}
	}
	resolved := path
	if target, err := filepath.EvalSymlinks(path); err == nil {
		resolved = target
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.WaitDelay = 100 * time.Millisecond
	var out prReadGitOutput
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		if errors.Is(err, errRewriteBlocked) {
			return "", errRewriteBlocked
		}
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return "", &gitUnavailableError{path: resolved, err: err}
	}
	return out.data.String(), nil
}

func rewriteGitError(err error) error {
	var unavailable *gitUnavailableError
	if errors.As(err, &unavailable) {
		return err
	}
	return errRewriteBlocked
}
