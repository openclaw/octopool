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
			if shouldRunRealGH(result.err) {
				return execRealGHAfterLocalFallback(ctx, floorGHWatchDelegateArgs(args), stdout, stderr, result.err)
			}
			return result.err
		case ghDelegate:
			return execRealGH(ctx, floorGHWatchDelegateArgs(args), stdout, stderr)
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
			return execRealGH(ctx, floorGHWatchDelegateArgs(args), stdout, stderr)
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
