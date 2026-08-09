package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

func parseGHRunWatchOptions(args []string) (ghRunWatchOptions, bool) {
	opts := ghRunWatchOptions{interval: watchMinInterval}
	positionals := []string{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--exit-status":
			opts.exitStatus = true
		case arg == "--compact":
			// Accepted without effect: the shim's terse transition/summary output
			// is already compact by design and does not render real gh's live table.
		case watchFlagValue(args, &index, arg, "-R", &opts.repo):
		case watchFlagValue(args, &index, arg, "--repo", &opts.repo):
		case isWatchValueFlag(arg, "-i"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "-i")
			if !valueOK || !setWatchInterval(value, &opts.interval) {
				return opts, false
			}
		case isWatchValueFlag(arg, "--interval"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "--interval")
			if !valueOK || !setWatchInterval(value, &opts.interval) {
				return opts, false
			}
		case attachedWatchInterval(arg) != "":
			if !setWatchInterval(attachedWatchInterval(arg), &opts.interval) {
				return opts, false
			}
		case strings.HasPrefix(arg, "-"):
			return opts, false
		default:
			positionals = append(positionals, arg)
		}
	}
	if len(positionals) != 1 || !isDigits(positionals[0]) {
		return opts, false
	}
	opts.id = positionals[0]
	return opts, true
}

// attachedWatchInterval handles pflag's attached shorthand form -i45.
func attachedWatchInterval(arg string) string {
	value, ok := strings.CutPrefix(arg, "-i")
	if !ok || value == "" || !isDigits(value) {
		return ""
	}
	return value
}

func relayRunWatch(ctx context.Context, stdout io.Writer, opts ghRunWatchOptions) error {
	client, err := newGHRelayClient()
	if err != nil {
		return err
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
			return watchError(err, progressPrinted)
		}
		status := watchSafeText(firstString(run, "status"))
		if status == "" {
			return watchError(errors.New("workflow run response did not include status"), progressPrinted)
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
				return watchError(err, progressPrinted)
			}
			confirmedStatus := watchSafeText(firstString(confirmed, "status"))
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
				return localFallbackError{Reason: "workflow run response did not include run_attempt"}
			}
			jobs, err := relayWatchRunJobs(ctx, client, opts.repo, opts.id, attempt, &backoff)
			if err != nil {
				return watchError(err, true)
			}
			if err := printWatchRunJobs(stdout, jobs); err != nil {
				return err
			}
			conclusion := watchSafeText(firstString(confirmed, "conclusion"))
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
			}
			jobs = append(jobs, pageJobs...)
			if len(jobs) >= total || len(pageJobs) < relayPageSize {
				return nil
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
	return ghCompleted(relayPRChecksWatch(ctx, stdout, opts))
}

func parseGHPRChecksWatchOptions(args []string) (ghPRChecksWatchOptions, bool) {
	opts := ghPRChecksWatchOptions{interval: watchMinInterval}
	positionals := []string{}
	watch := false
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case watchFlagTrue(arg):
			watch = true
		case strings.HasPrefix(arg, "--watch="):
			return opts, false
		case arg == "--fail-fast":
			opts.failFast = true
		case watchFlagValue(args, &index, arg, "-R", &opts.repo):
		case watchFlagValue(args, &index, arg, "--repo", &opts.repo):
		case isWatchValueFlag(arg, "-i"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "-i")
			if !valueOK || !setWatchInterval(value, &opts.interval) {
				return opts, false
			}
		case isWatchValueFlag(arg, "--interval"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "--interval")
			if !valueOK || !setWatchInterval(value, &opts.interval) {
				return opts, false
			}
		case attachedWatchInterval(arg) != "":
			if !setWatchInterval(attachedWatchInterval(arg), &opts.interval) {
				return opts, false
			}
		case strings.HasPrefix(arg, "-"):
			// real gh rejects --watch with --json/--jq/--template; delegating
			// unknown flags lets it report those combinations itself.
			return opts, false
		default:
			positionals = append(positionals, arg)
		}
	}
	if !watch || len(positionals) != 1 || !isDigits(positionals[0]) {
		return opts, false
	}
	opts.number = positionals[0]
	return opts, true
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
		var items []any
		var sha string
		err := retryWatchTick(ctx, &backoff, func() error {
			var pollErr error
			items, sha, pollErr = relayPRCheckItemsWithSHA(ctx, client, opts.repo, opts.number)
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
				current, freshErr := relayPRHeadSHA(ctx, client, opts.repo, opts.number, 0)
				if freshErr != nil {
					return freshErr
				}
				freshItems, freshErr := prCheckItemsForSHAFresh(ctx, client, opts.repo, current)
				if freshErr != nil {
					return freshErr
				}
				items, sha = freshItems, current
				return nil
			})
			if err != nil {
				return watchError(err, progressPrinted)
			}
			if len(items) == 0 {
				return fmt.Errorf("no checks reported on pull request #%s", opts.number)
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
			var final []any
			var confirmed bool
			err := retryWatchTick(ctx, &backoff, func() error {
				var confirmErr error
				final, confirmed, confirmErr = confirmPRChecksTerminal(ctx, client, opts, sha)
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
) ([]any, bool, error) {
	current, err := relayPRHeadSHA(ctx, client, opts.repo, opts.number, 0)
	if err != nil {
		return nil, false, err
	}
	if current != sha {
		return nil, false, nil
	}
	items, err := prCheckItemsForSHAFresh(ctx, client, opts.repo, current)
	if err != nil {
		return nil, false, err
	}
	// A fresh empty set after a terminal-looking cached snapshot is an
	// anomaly (rerun re-registration, data lag) — never confirm it as green.
	if len(items) == 0 {
		return nil, false, fmt.Errorf("no checks reported on pull request #%s", opts.number)
	}
	pending, _, failing, _ := checkWatchCounts(items)
	if pending == 0 || opts.failFast && failing > 0 {
		return items, true, nil
	}
	return nil, false, nil
}

func checkWatchCounts(items []any) (pending int, passing int, failing int, cancelled int) {
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch watchCheckBucket(item) {
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

func watchCheckBucket(item map[string]any) string {
	bucket := strings.ToLower(firstString(item, "bucket"))
	if bucket != "" {
		return bucket
	}
	state := strings.ToLower(firstString(item, "state"))
	if state == "success" || state == "neutral" {
		return "pass"
	}
	return "pending"
}

func printPRChecksWatchFinal(stdout io.Writer, items []any) error {
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, err := fmt.Fprintf(stdout, "%s\t%s\t%s\t%s\n", watchSafeText(firstString(item, "name")), firstString(item, "bucket"), watchSafeText(firstString(item, "state")), watchSafeText(firstString(item, "link"))); err != nil {
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

func watchError(err error, progressPrinted bool) error {
	if progressPrinted && shouldRunRealGH(err) {
		return errors.New(err.Error())
	}
	return err
}

func hasWatchFlag(args []string) bool {
	// pflag applies last-value-wins to repeated boolean flags; mirror that so
	// `--watch --watch=false` is not treated as a watch shape.
	watch := false
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if watchFlagTrue(arg) {
			watch = true
		} else if value, ok := strings.CutPrefix(arg, "--watch="); ok {
			if parsed, err := strconv.ParseBool(value); err == nil && !parsed {
				watch = false
			}
		}
	}
	return watch
}

// watchFlagTrue mirrors pflag bool parsing: bare --watch or any ParseBool
// true spelling counts; false spellings stay unwatched.
func watchFlagTrue(arg string) bool {
	if arg == "--watch" {
		return true
	}
	value, ok := strings.CutPrefix(arg, "--watch=")
	if !ok {
		return false
	}
	parsed, err := strconv.ParseBool(value)
	return err == nil && parsed
}

func watchFlagValue(args []string, index *int, arg string, name string, target *string) bool {
	if !isWatchValueFlag(arg, name) {
		return false
	}
	value, ok := takeWatchFlagValue(args, index, arg, name)
	if !ok {
		return false
	}
	*target = value
	return true
}

func isWatchValueFlag(arg string, name string) bool {
	return arg == name || strings.HasPrefix(arg, name+"=")
}

func takeWatchFlagValue(args []string, index *int, arg string, name string) (string, bool) {
	if strings.HasPrefix(arg, name+"=") {
		value := strings.TrimPrefix(arg, name+"=")
		return value, value != ""
	}
	*index = *index + 1
	if *index >= len(args) {
		return "", false
	}
	return args[*index], true
}

func setWatchInterval(raw string, interval *time.Duration) bool {
	seconds, err := strconv.Atoi(raw)
	if err != nil {
		return false
	}
	*interval = max(time.Duration(seconds)*time.Second, watchMinInterval)
	return true
}

func floorGHWatchDelegateArgs(args []string) []string {
	if !isGHWatchShape(args) {
		return args
	}
	out := append([]string(nil), args...)
	found := false
	for index := 2; index < len(out); index++ {
		arg := out[index]
		// Everything after the terminator is positional, never an interval flag.
		if arg == "--" {
			break
		}
		if value := attachedWatchInterval(arg); value != "" {
			found = true
			out[index] = "-i" + floorWatchIntervalValue(value)
			continue
		}
		for _, name := range []string{"-i", "--interval"} {
			if arg == name {
				found = true
				if index+1 < len(out) {
					out[index+1] = floorWatchIntervalValue(out[index+1])
					index++
				}
				break
			}
			if strings.HasPrefix(arg, name+"=") {
				found = true
				value := strings.TrimPrefix(arg, name+"=")
				out[index] = name + "=" + floorWatchIntervalValue(value)
				break
			}
		}
	}
	if !found {
		floor := []string{"--interval", "30"}
		// Keep the injected flag ahead of any `--` terminator; after it,
		// real gh would treat the flag as a positional and reject the command.
		for index, arg := range out {
			if arg == "--" {
				return append(out[:index:index], append(floor, out[index:]...)...)
			}
		}
		out = append(out, floor...)
	}
	return out
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

func floorWatchIntervalValue(raw string) string {
	seconds, err := strconv.Atoi(raw)
	if err == nil && seconds < int(watchMinInterval/time.Second) {
		return strconv.Itoa(int(watchMinInterval / time.Second))
	}
	return raw
}
