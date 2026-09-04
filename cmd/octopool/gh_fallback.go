package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type localFallbackError struct {
	Reason string
	Relay  *relayResponseError
}

func (err localFallbackError) Error() string {
	if err.Reason == "" {
		return "octopool requested local gh fallback"
	}
	return "octopool requested local gh fallback: " + err.Reason
}

func isLocalFallback(err error) bool {
	var fallback localFallbackError
	return errors.As(err, &fallback)
}

func explicitRelayFallback(err error) (localFallbackError, bool) {
	var fallback localFallbackError
	if !errors.As(err, &fallback) || fallback.Relay == nil || fallback.Relay.Code != "fallback_local" {
		return localFallbackError{}, false
	}
	return fallback, true
}

func shouldRunRealGH(err error) bool {
	return isLocalFallback(err)
}

func localFallbackFromRelayError(relay *relayResponseError) (localFallbackError, bool) {
	switch relay.Code {
	case "fallback_local":
		return localFallbackError{Reason: relayFallbackReason(relay), Relay: relay}, true
	default:
		return localFallbackError{}, false
	}
}

func relayFallbackReason(relay *relayResponseError) string {
	if relay.Details.FallbackReason != "" {
		return relay.Details.FallbackReason
	}
	return relay.Message
}

func execRealGHAfterLocalFallback(
	ctx context.Context,
	args []string,
	stdout io.Writer,
	stderr io.Writer,
	reason error,
) error {
	if envDefault("OCTOPOOL_NO_FALLBACK", "") != "" {
		return reason
	}
	if !errors.Is(reason, errOctopoolNotLoggedIn) {
		fmt.Fprintf(stderr, "octopool: %v; falling back to real gh\n", reason)
	}
	return execRealGH(ctx, args, stdout, stderr)
}

func runJQ(ctx context.Context, stdout io.Writer, input []byte, expr string) error {
	child, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	args := []string{"-r"}
	if runtime.GOOS == "windows" {
		// Native jq otherwise expands every LF, including raw string payloads.
		args = append(args, "--binary")
	}
	// A filter that resembles a jq option is still a filter.
	cmd := exec.CommandContext(child, "jq", append(args, "--", expr)...)
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	return cmd.Run()
}

func jqAvailable() bool {
	_, err := exec.LookPath("jq")
	return err == nil
}

func execRealGH(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	return execRealGHWithStdin(ctx, args, os.Stdin, stdout, stderr)
}

func execRealGHWithStdin(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout io.Writer,
	stderr io.Writer,
) error {
	return execRealGHWithStdinAndEnv(ctx, args, stdin, stdout, stderr, os.Environ())
}

func execRealGHWithStdinAndEnv(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout io.Writer,
	stderr io.Writer,
	env []string,
) error {
	attempt := time.Now()
	prepared, err := prepareProtectedGH(ctx, args, stdin)
	var diagnostic *ghMergeDiagnostic
	if prepared != nil && prepared.mergeDiagnostics != nil {
		diagnostic = &ghMergeDiagnostic{attempt: attempt, preparation: prepared.mergeDiagnostics}
		defer diagnostic.writeTo(stderr)
	}
	if err != nil {
		return err
	}
	defer prepared.cleanup()
	if err := ctx.Err(); err != nil {
		if diagnostic != nil {
			diagnostic.outcome = ghMergeCanceledBeforeStart
		}
		return err
	}
	if len(prepared.preflight) != 0 {
		if err := execRealGHWithStdinAndEnv(ctx, prepared.preflight, strings.NewReader(""), io.Discard, io.Discard, env); err != nil {
			return errRewriteBlocked
		}
	}
	if diagnostic != nil {
		diagnostic.outcome = ghMergeStartFailed
	}
	path, err := resolveGHPath(envDefault("OCTOPOOL_GH_PATH", "gh"))
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, path, prepared.args...)
	cmd.Stdin = prepared.stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if diagnostic != nil && prepared.mergeDiagnostics.captureHeaders {
		diagnostic.headers = &ghMergeHeaderCollector{}
		cmd.Stdout = diagnostic.headers
	}
	if prepared.forceGitHubHost {
		env = envWithGitHubHost(env)
	}
	cmd.Env = env
	if diagnostic == nil {
		err = cmd.Run()
	} else {
		err = cmd.Start()
		if err == nil {
			diagnostic.childStarted = true
			err = cmd.Wait()
			diagnostic.outcome = ghMergeSucceeded
			if cmd.ProcessState != nil {
				code := cmd.ProcessState.ExitCode()
				diagnostic.exitCode = &code
			}
			if err != nil {
				diagnostic.outcome = ghMergeWaitFailed
				var exitErr *exec.ExitError
				if errors.As(err, &exitErr) {
					diagnostic.outcome = ghMergeExited
				}
				if ctx.Err() != nil {
					diagnostic.outcome = ghMergeCanceled
				}
			}
		} else if ctx.Err() != nil {
			diagnostic.outcome = ghMergeCanceledBeforeStart
		}
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitCodeError{Code: exitErr.ExitCode()}
		}
		return err
	}
	return nil
}

func envWithGitHubHost(env []string) []string {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "GH_HOST") || strings.EqualFold(name, "GH_REPO") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "GH_HOST=github.com")
}

func envWithoutGitHubTokens() []string {
	blocked := map[string]struct{}{
		"GH_TOKEN":                {},
		"GITHUB_TOKEN":            {},
		"GH_ENTERPRISE_TOKEN":     {},
		"GITHUB_ENTERPRISE_TOKEN": {},
	}
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, found := blocked[strings.ToUpper(name)]; !found {
			env = append(env, entry)
		}
	}
	return env
}
