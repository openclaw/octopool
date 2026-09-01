package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	watchMinInterval = 30 * time.Second
	watchMaxInterval = 120 * time.Second
	watchMaxErrors   = 3
)

var sleepContext = func(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type ghRunWatchOptions struct {
	repo       string
	id         string
	interval   time.Duration
	exitStatus bool
}

type ghPRChecksWatchOptions struct {
	repo     string
	number   string
	interval time.Duration
	failFast bool
}

type watchBackoff struct {
	current time.Duration
	limit   time.Duration
}

type watchFallbackHandoffError struct {
	fallback localFallbackError
}

func (err watchFallbackHandoffError) Error() string {
	return err.fallback.Error()
}

func ghWatchCompleted(err error) ghResult {
	if err == nil {
		return ghResult{action: ghComplete}
	}
	var handoff watchFallbackHandoffError
	if errors.As(err, &handoff) {
		return ghResult{action: ghHandoffAfterOutput, err: handoff}
	}
	return ghFailed(err)
}

func newWatchBackoff(requested time.Duration) watchBackoff {
	start := max(requested, watchMinInterval)
	return watchBackoff{current: start, limit: max(watchMaxInterval, start)}
}

func (backoff *watchBackoff) sleep(ctx context.Context) error {
	if err := sleepContext(ctx, backoff.current); err != nil {
		return err
	}
	backoff.current = min(backoff.current*2, backoff.limit)
	return nil
}

func retryWatchTick(ctx context.Context, backoff *watchBackoff, poll func() error) error {
	var err error
	for attempt := 0; attempt < watchMaxErrors; attempt++ {
		if err = poll(); err == nil {
			return nil
		}
		// Deterministic relay refusals (unsupported route, not logged in) never
		// heal on retry; surface them immediately so first-tick fallback stays fast.
		if shouldRunRealGH(err) {
			return err
		}
		if errors.Is(err, errRewritePolicy) || errors.Is(err, errRewriteBlocked) || errors.Is(err, errOctopoolNotLoggedIn) {
			return err
		}
		// The relay client already exhausted its typed response retry policy.
		// Watch retries remain for transport, parse, and operation-level failures.
		var relay *relayResponseError
		if errors.As(err, &relay) {
			return err
		}
		if attempt+1 < watchMaxErrors {
			if sleepErr := backoff.sleep(ctx); sleepErr != nil {
				return sleepErr
			}
		}
	}
	return err
}

func handleGHRunWatch(ctx context.Context, args []string, stdout io.Writer) ghResult {
	opts, ok := parseGHRunWatchOptions(args)
	if !ok {
		return ghDelegated()
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok {
		return ghDelegated()
	}
	opts.repo = repo
	return ghCompleted(relayRunWatch(ctx, stdout, opts))
}

func watchReadSpecs(command string) map[string]readOptionSpec {
	values, booleans := "--repo,-R --interval,-i", "--exit-status --compact"
	if command == "pr checks" {
		values += " --json --jq,-q --template"
		booleans = "--watch --fail-fast --required --web"
	}
	specs := typedReadSpecs(command, values, booleans)
	interval := specs["-i"]
	interval.attached = true
	specs["-i"] = interval
	return specs
}

func nativeWatchReadSpecs(command string) map[string]readOptionSpec {
	specs := watchReadSpecs(command)
	if command == "pr checks" {
		// Native web shorthand affects shape/floor ownership, not relay eligibility.
		specs["-w"] = specs["--web"]
	}
	return specs
}

func readWatchInterval(parsed readOptions) (time.Duration, bool) {
	if !parsed.has("--interval") {
		return watchMinInterval, true
	}
	seconds := parsed.values["--interval"].integer
	// Validate before multiplication or flooring; an int-valid discarded value
	// need not be a representable duration, but the final value must be.
	if seconds > math.MaxInt64/int64(time.Second) || seconds < math.MinInt64/int64(time.Second) {
		return 0, false
	}
	return max(time.Duration(seconds)*time.Second, watchMinInterval), true
}

func parseGHRunWatchOptions(args []string) (ghRunWatchOptions, bool) {
	opts := ghRunWatchOptions{interval: watchMinInterval}
	parsed, unsupported, err := parseReadOptions(args, watchReadSpecs("run watch"))
	if err != nil || unsupported || len(parsed.positionals) != 1 || !isDigits(parsed.positionals[0]) {
		return opts, false
	}
	var ok bool
	opts.interval, ok = readWatchInterval(parsed)
	opts.repo, opts.id = parsed.values["--repo"].raw, parsed.positionals[0]
	opts.exitStatus = parsed.values["--exit-status"].boolean
	return opts, ok
}

func relayRunWatch(ctx context.Context, stdout io.Writer, opts ghRunWatchOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return runWatchError(err, false)
	}
	backoff := newWatchBackoff(opts.interval)
	previousStatus := ""
	progressPrinted := false
	for {
		var run map[string]any
		err := retryWatchTick(ctx, &backoff, func() error {
			var pollErr error
			run, pollErr = relayWatchRun(ctx, client, opts.repo, opts.id, nil)
			return pollErr
		})
		if err != nil {
			return runWatchError(err, progressPrinted)
		}
		status := watchSafeText(firstString(run, "status"))
		if status == "" {
			return runWatchError(errors.New("workflow run response did not include status"), progressPrinted)
		}
		if !progressPrinted {
			if _, err := fmt.Fprintf(stdout, "Watching run %s in %s (status: %s)\n", opts.id, opts.repo, status); err != nil {
				return err
			}
			progressPrinted = true
		} else if status != previousStatus {
			if _, err := fmt.Fprintf(stdout, "run %s: %s -> %s\n", opts.id, previousStatus, status); err != nil {
				return err
			}
		}
		previousStatus = status
		if status == "completed" {
			// Reruns reuse the run ID, so a cached terminal payload from a
			// previous attempt could finalize the watch instantly with stale
			// results. Confirm completion with one uncached read per exit.
			var confirmed map[string]any
			err := retryWatchTick(ctx, &backoff, func() error {
				var pollErr error
				confirmed, pollErr = relayWatchRun(ctx, client, opts.repo, opts.id, watchFreshHeaders())
				return pollErr
			})
			if err != nil {
				return runWatchError(err, progressPrinted)
			}
			confirmedStatus := watchSafeText(firstString(confirmed, "status"))
			if confirmedStatus == "" {
				return errors.New("workflow run confirmation did not include status")
			}
			if confirmedStatus != "completed" {
				if confirmedStatus != "" && confirmedStatus != status {
					if _, err := fmt.Fprintf(stdout, "run %s: %s -> %s\n", opts.id, status, confirmedStatus); err != nil {
						return err
					}
					previousStatus = confirmedStatus
				}
				if err := backoff.sleep(ctx); err != nil {
					return err
				}
				continue
			}
			attempt, ok := positiveJSONInt(confirmed["run_attempt"])
			if !ok {
				return runWatchError(localFallbackError{Reason: "workflow run response did not include run_attempt"}, progressPrinted)
			}
			conclusion := watchSafeText(firstString(confirmed, "conclusion"))
			if conclusion == "" {
				return errors.New("workflow run confirmation did not include conclusion")
			}
			jobs, err := relayWatchRunJobs(ctx, client, opts.repo, opts.id, attempt, &backoff)
			if err != nil {
				return runWatchError(err, true)
			}
			if err := printWatchRunJobs(stdout, jobs); err != nil {
				return err
			}
			if _, err := fmt.Fprintf(stdout, "Run %s completed with '%s'\n", opts.id, conclusion); err != nil {
				return err
			}
			if opts.exitStatus && !strings.EqualFold(conclusion, "success") {
				return exitCodeError{Code: 1}
			}
			return nil
		}
		if err := backoff.sleep(ctx); err != nil {
			return err
		}
	}
}

func watchFreshHeaders() map[string]string {
	return map[string]string{"cache-control": "max-age=0"}
}

func relayWatchRun(ctx context.Context, client ghRelayClient, repo string, id string, extraHeaders map[string]string) (map[string]any, error) {
	headers := map[string]string{"x-octopool-public-shape": publicShapeActionsSummary}
	for key, value := range extraHeaders {
		headers[key] = value
	}
	envelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "actions", "runs", id),
		headers: headers,
	})
	if err != nil {
		return nil, err
	}
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, err
	}
	var run map[string]any
	if err := json.Unmarshal(body, &run); err != nil {
		return nil, err
	}
	return run, nil
}

func relayWatchRunJobs(ctx context.Context, client ghRelayClient, repo string, id string, attempt int, backoff *watchBackoff) ([]any, error) {
	var jobs []any
	err := retryWatchTick(ctx, backoff, func() error {
		jobs = jobs[:0]
		total := 0
		for page := 1; page <= maxRelayPages; page++ {
			envelope, err := client.do(ctx, ghAPIRequest{
				method: "GET",
				path:   repoPath(repo, "actions", "runs", id, "attempts", strconv.Itoa(attempt), "jobs"),
				query:  map[string]any{"per_page": strconv.Itoa(relayPageSize), "page": strconv.Itoa(page)},
				headers: map[string]string{
					"x-octopool-public-shape": publicShapeActionsJobs,
					// The run just confirmed terminal; stale cached jobs from a
					// previous attempt must not leak into the final summary.
					"cache-control": "max-age=0",
				},
			})
			if err != nil {
				return err
			}
			pageJobs, pageTotal, err := runJobsPage(envelope)
			if err != nil {
				return err
			}
			if page == 1 {
				total = pageTotal
			} else if pageTotal != total {
				return localFallbackError{Reason: "workflow jobs total_count changed during pagination"}
			}
			jobs = append(jobs, pageJobs...)
			link, linked := relayResponseHeader(envelope.Headers, "link")
			next, hasNext := relayNextLink(link)
			if len(jobs) > total || (len(jobs) == total && hasNext) {
				return localFallbackError{Reason: "workflow jobs pagination contradicts total_count"}
			}
			if len(jobs) == total {
				return nil
			}
			// A short page is not proof of completion when the advertised total
			// still includes missing jobs (for example, partial rerun metadata).
			if len(pageJobs) < relayPageSize || (linked && !hasNext) {
				return localFallbackError{Reason: "workflow jobs response is incomplete"}
			}
			if hasNext {
				if nextPage, ok := relayLinkNumericPage(next); !ok || nextPage != page+1 {
					return localFallbackError{Reason: "workflow jobs pagination link is inconsistent"}
				}
			}
		}
		return localFallbackError{Reason: "workflow jobs pagination exhausted"}
	})
	return jobs, err
}

func printWatchRunJobs(stdout io.Writer, jobs []any) error {
	for _, rawJob := range jobs {
		job, ok := rawJob.(map[string]any)
		if !ok {
			continue
		}
		conclusion := watchSafeText(firstString(job, "conclusion"))
		if _, err := fmt.Fprintf(stdout, "job %s: %s\n", watchSafeText(firstString(job, "name")), conclusion); err != nil {
			return err
		}
		if !strings.EqualFold(conclusion, "failure") {
			continue
		}
		steps, _ := job["steps"].([]any)
		for _, rawStep := range steps {
			step, ok := rawStep.(map[string]any)
			if !ok || !strings.EqualFold(firstString(step, "conclusion"), "failure") {
				continue
			}
			if _, err := fmt.Fprintf(stdout, "  step %s: %s\n", watchSafeText(firstString(step, "name")), watchSafeText(firstString(step, "conclusion"))); err != nil {
				return err
			}
		}
	}
	return nil
}

func handleGHPRChecksWatch(ctx context.Context, args []string, stdout io.Writer) ghResult {
	opts, ok := parseGHPRChecksWatchOptions(args)
	if !ok {
		return ghDelegated()
	}
	repo, ok := repoFromOptionOrCurrent(opts.repo)
	if !ok {
		return ghDelegated()
	}
	opts.repo = repo
	return ghWatchCompleted(relayPRChecksWatch(ctx, stdout, opts))
}

func parseGHPRChecksWatchOptions(args []string) (ghPRChecksWatchOptions, bool) {
	opts := ghPRChecksWatchOptions{interval: watchMinInterval}
	parsed, unsupported, err := parseReadOptions(args, watchReadSpecs("pr checks"))
	if err != nil || unsupported || !parsed.values["--watch"].boolean || len(parsed.positionals) != 1 || !isDigits(parsed.positionals[0]) {
		return opts, false
	}
	if parsed.has("--json") || parsed.has("--jq") || parsed.has("--template") || parsed.values["--required"].boolean || parsed.values["--web"].boolean {
		return opts, false
	}
	var ok bool
	opts.interval, ok = readWatchInterval(parsed)
	opts.repo, opts.number = parsed.values["--repo"].raw, parsed.positionals[0]
	opts.failFast = parsed.values["--fail-fast"].boolean
	return opts, ok
}

func relayPRChecksWatch(ctx context.Context, stdout io.Writer, opts ghPRChecksWatchOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	backoff := newWatchBackoff(opts.interval)
	previousCounts := ""
	progressPrinted := false
	for {
		var items []prCheckRow
		var head prCheckHead
		err := retryWatchTick(ctx, &backoff, func() error {
			var pollErr error
			items, head, pollErr = relayPRCheckItemsWithHead(ctx, client, opts.repo, opts.number)
			return pollErr
		})
		if err != nil {
			return watchError(err, progressPrinted)
		}
		// Zero registered checks must not read as green. A cached empty
		// snapshot may simply predate check registration, so confirm with a
		// fresh sweep first; genuinely empty results error like real gh.
		if len(items) == 0 {
			err := retryWatchTick(ctx, &backoff, func() error {
				current, freshErr := relayPRChecksHead(ctx, client, opts.repo, opts.number, 0)
				if freshErr != nil {
					return freshErr
				}
				freshItems, freshErr := prCheckItemsForSHAFresh(ctx, client, opts.repo, current.SHA)
				if freshErr != nil {
					return freshErr
				}
				items, head = freshItems, current
				return nil
			})
			if err != nil {
				return watchError(err, progressPrinted)
			}
			if len(items) == 0 {
				return prChecksEmptyError{head: head}
			}
		}
		pending, passing, failing, cancelled := checkWatchCounts(items)
		counts := fmt.Sprintf("%d/%d/%d/%d", pending, passing, failing, cancelled)
		if counts != previousCounts {
			if _, err := fmt.Fprintf(stdout, "checks: %d pending, %d pass, %d fail, %d cancel\n", pending, passing, failing, cancelled); err != nil {
				return err
			}
			progressPrinted = true
		}
		previousCounts = counts
		// real gh's --fail-fast stops on failed checks only; cancellation is
		// terminal but not a failure.
		if pending == 0 || opts.failFast && failing > 0 {
			// The snapshot came from bounded-staleness cache reads; a push right
			// before the watch (new head SHA) or a check rerun (same SHA, cached
			// terminal payloads) could otherwise finalize on obsolete results.
			// One fresh sweep per exit attempt.
			var final []prCheckRow
			var confirmed bool
			err := retryWatchTick(ctx, &backoff, func() error {
				var confirmErr error
				final, confirmed, confirmErr = confirmPRChecksTerminal(ctx, client, opts, head.SHA)
				return confirmErr
			})
			if err != nil {
				return watchError(err, progressPrinted)
			}
			if confirmed {
				if err := printPRChecksWatchFinal(stdout, final); err != nil {
					return err
				}
				return checkExitCode(final)
			}
		}
		if err := backoff.sleep(ctx); err != nil {
			return err
		}
	}
}

func confirmPRChecksTerminal(
	ctx context.Context,
	client ghRelayClient,
	opts ghPRChecksWatchOptions,
	sha string,
) ([]prCheckRow, bool, error) {
	current, err := relayPRChecksHead(ctx, client, opts.repo, opts.number, 0)
	if err != nil {
		return nil, false, err
	}
	if current.SHA != sha {
		return nil, false, nil
	}
	items, err := prCheckItemsForSHAFresh(ctx, client, opts.repo, current.SHA)
	if err != nil {
		return nil, false, err
	}
	// A fresh empty set after a terminal-looking cached snapshot is an
	// anomaly (rerun re-registration, data lag) — never confirm it as green.
	if len(items) == 0 {
		return nil, false, prChecksEmptyError{head: current}
	}
	pending, _, failing, _ := checkWatchCounts(items)
	if pending != 0 && !(opts.failFast && failing > 0) {
		return nil, false, nil
	}
	// The head can move while context or workflow pages are being hydrated.
	// A matching head closes that window, not same-commit status races.
	finalHead, err := relayPRChecksHead(ctx, client, opts.repo, opts.number, 0)
	if err != nil {
		return nil, false, err
	}
	if finalHead.SHA != current.SHA {
		return nil, false, nil
	}
	return items, true, nil
}

func checkWatchCounts(items []prCheckRow) (pending int, passing int, failing int, cancelled int) {
	for _, item := range items {
		switch item.Bucket {
		case "pass", "skipping":
			passing++
		case "fail":
			failing++
		case "cancel":
			cancelled++
		default:
			pending++
		}
	}
	return pending, passing, failing, cancelled
}

func printPRChecksWatchFinal(stdout io.Writer, items []prCheckRow) error {
	for _, item := range items {
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\n", watchSafeText(item.Name), item.Bucket, watchSafeText(item.State), watchSafeText(item.Link)); err != nil {
			return err
		}
	}
	return nil
}

// watchSafeText strips ASCII/C1 control characters from API-controlled
// strings so job/check names cannot inject terminal escape sequences.
// Printable CSI remainders like "[31m" are harmless once the escape
// introducer is gone. U+FFFD passes through: post-JSON strings are valid
// UTF-8, so stripping it would only eat legitimate replacement characters.
func watchSafeText(raw string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return -1
		}
		return r
	}, raw)
}

// bodySafeText preserves body layout while removing control characters that
// could alter terminal state or encode invalid text.
func bodySafeText(raw string) string {
	return strings.Map(func(r rune) rune {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return -1
		}
		return r
	}, raw)
}

func runWatchError(err error, progressPrinted bool) error {
	if fallback, ok := explicitRelayFallback(err); ok && !progressPrinted && fallback.Reason == "repo_not_public" {
		return err
	}
	if shouldRunRealGH(err) {
		// The run watcher owns the whole polling session. A failed hydration
		// must not restart that session using the caller's personal quota.
		return fmt.Errorf("run watch stopped without local gh fallback: %v", err)
	}
	return err
}

func watchError(err error, progressPrinted bool) error {
	if !progressPrinted {
		return err
	}
	if fallback, ok := explicitRelayFallback(err); ok {
		return watchFallbackHandoffError{fallback: fallback}
	}
	if shouldRunRealGH(err) {
		return errors.New(err.Error())
	}
	return err
}

func hasWatchFlag(args []string) bool {
	parsed, unsupported, err := parseReadOptions(args, nativeWatchReadSpecs("pr checks"))
	return err == nil && !unsupported && parsed.values["--watch"].boolean
}

func floorGHWatchDelegateArgs(args []string) []string {
	if !isGHWatchShape(args) {
		return args
	}
	parsed, unsupported, err := parseReadOptions(args[2:], nativeWatchReadSpecs(args[0]+" "+args[1]))
	if err != nil || unsupported {
		return args
	}
	interval, ok := readWatchInterval(parsed)
	if !ok {
		return args
	}
	if parsed.has("--interval") {
		if interval > watchMinInterval || parsed.values["--interval"].integer >= int64(watchMinInterval/time.Second) {
			return args
		}
		for i := len(parsed.ordered) - 1; i >= 0; i-- {
			occurrence := parsed.ordered[i]
			if occurrence.name == "--interval" {
				out := append([]string(nil), args...)
				out[2+occurrence.valueIndex] = occurrence.valuePrefix + "30"
				return out
			}
		}
	}
	out := append([]string(nil), args[:2+parsed.delimiter]...)
	out = append(out, "--interval", "30")
	return append(out, args[2+parsed.delimiter:]...)
}

func isGHWatchShape(args []string) bool {
	if len(args) < 2 {
		return false
	}
	if args[0] == "run" && args[1] == "watch" {
		return true
	}
	return args[0] == "pr" && args[1] == "checks" && hasWatchFlag(args[2:])
}
