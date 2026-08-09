package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type localFallbackError struct {
	Reason string
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

func shouldRunRealGH(err error) bool {
	return isLocalFallback(err) || errors.Is(err, errOctopoolNotLoggedIn)
}

func localFallbackFromRelayError(relay *relayResponseError) (localFallbackError, bool) {
	switch relay.Code {
	case "fallback_local":
		return localFallbackError{Reason: relayFallbackReason(relay)}, true
	case "missing_auth", "invalid_auth":
		return localFallbackError{Reason: "octopool auth unavailable"}, true
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
	cmd := exec.CommandContext(child, "jq", "-r", expr)
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
	path, err := resolveGHPath(envDefault("OCTOPOOL_GH_PATH", "gh"))
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = env
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitCodeError{Code: exitErr.ExitCode()}
		}
		return err
	}
	return nil
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
