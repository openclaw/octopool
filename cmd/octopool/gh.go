package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
)

func runGH(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, "usage: octopool gh api <GET path> [--paginate] [--slurp] [--jq expr]")
		fmt.Fprintln(stdout, "       octopool gh pr|issue|run|repo|release|workflow|label|gist|search ...")
		return nil
	}
	if !rewriteBootstrapInvocation(args) {
		policy, err := currentStringRewritePolicy(ctx)
		if err != nil {
			return err
		}
		if len(policy.Rules) != 0 {
			lifecycle := len(args) >= 2 && args[0] == "pr" && (args[1] == "ready" || args[1] == "merge")
			if rewriteContentCommand(args) || lifecycle || args[0] == "api" {
				// Mutations and content snapshots are prepared exactly once, at the
				// final child boundary. Read API dispatch still uses the relay.
				if args[0] != "api" {
					return execRealGH(ctx, args, stdout, stderr)
				}
				opts, err := parseRewriteAPI(args[1:])
				if err != nil {
					if errors.Is(err, errRewriteUnsupported) {
						return execRealGH(ctx, args, stdout, stderr)
					}
					return err
				}
				if opts.method != "GET" {
					return execRealGH(ctx, args, stdout, stderr)
				}
				request, err := rewriteAPIRequest(opts)
				if err != nil {
					return err
				}
				if err := policy.guardRequest(request); err != nil {
					return err
				}
				if opts.inputSet || len(opts.fields) != 0 || !rewriteReadPath(request.path) {
					return execRealGH(ctx, args, stdout, stderr)
				}
			} else {
				prepared := &rewritePreparation{}
				if err := prepareRewriteRead(policy, args, prepared); err != nil {
					if errors.Is(err, errRewriteUnsupported) {
						return execRealGH(ctx, args, stdout, stderr)
					}
					return err
				}
				args = prepared.args
			}
		}
	}
	if isGHAuthStatus(args) {
		return runGHAuthStatus(ctx, args, stdout, stderr)
	}
	if isGHWithTokenLogin(args) {
		return runGHWithTokenLogin(ctx, args, os.Stdin, stdout, stderr)
	}
	if args[0] != "api" {
		result := runGHTopLevel(ctx, args, stdout)
		switch result.action {
		case ghComplete:
			return nil
		case ghFail:
			var empty prChecksEmptyError
			if errors.As(result.err, &empty) {
				if _, err := fmt.Fprintln(stderr, empty.Error()); err != nil {
					return err
				}
				return exitCodeError{Code: 1}
			}
			if shouldRunRealGH(result.err) {
				return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, result.err)
			}
			return result.err
		case ghDelegate:
			return execRealGH(ctx, args, stdout, stderr)
		case ghHandoffAfterOutput:
			var handoff watchFallbackHandoffError
			if !errors.As(result.err, &handoff) {
				return errors.New("invalid gh watch handoff outcome")
			}
			if envDefault("OCTOPOOL_NO_FALLBACK", "") != "" {
				return handoff.fallback
			}
			fmt.Fprintf(
				stderr,
				"octopool: relay requested local fallback (%s); continuing watch with real gh\n",
				watchSafeText(handoff.fallback.Reason),
			)
			return execRealGH(ctx, args, stdout, stderr)
		default:
			return errors.New("invalid gh dispatch outcome")
		}
	}
	request, fallback, err := parseGHAPIArgs(args[1:])
	if err != nil {
		return err
	}
	if request.paginate {
		request = prepareGHAPIPagination(request)
	}
	if fallback || request.method != "GET" || !safeRelayRequest(request) {
		return execRealGH(ctx, args, stdout, stderr)
	}
	if handled, err := writeLocalUserLogin(ctx, request, stdout); handled {
		return err
	}
	if request.jq != "" && !jqAvailable() {
		return execRealGH(ctx, args, stdout, stderr)
	}
	client, err := newGHRelayClient()
	if err != nil {
		if shouldRunRealGH(err) {
			return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, err)
		}
		return err
	}
	if request.paginate {
		err = relayPaginatedGHAPI(ctx, client, request, stdout)
		if err != nil && shouldRunRealGH(err) {
			return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, err)
		}
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		if shouldRunRealGH(err) {
			return execRealGHAfterLocalFallback(ctx, args, stdout, stderr, err)
		}
		return err
	}
	return writeGHBody(ctx, stdout, envelope, request.jq)
}
