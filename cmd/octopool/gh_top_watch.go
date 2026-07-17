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
	"unicode/utf8"
)

const (
	watchMinInterval = 30 * time.Second
	watchMaxInterval = 120 * time.Second
	watchMaxErrors   = 3
)

var watchSleep = func(ctx context.Context, duration time.Duration) error {
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
	json     []string
	jq       string
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
	if err := watchSleep(ctx, backoff.current); err != nil {
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
			run, pollErr = relayWatchRun(ctx, client, opts.repo, opts.id)
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
			jobs, err := relayWatchRunJobs(ctx, client, opts.repo, opts.id, &backoff)
			if err != nil {
				return watchError(err, true)
			}
			if err := printWatchRunJobs(stdout, jobs); err != nil {
				return err
			}
			conclusion := watchSafeText(firstString(run, "conclusion"))
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

func relayWatchRun(ctx context.Context, client ghRelayClient, repo string, id string) (map[string]any, error) {
	envelope, err := client.do(ctx, ghAPIRequest{
		method:  "GET",
		path:    repoPath(repo, "actions", "runs", id),
		headers: map[string]string{"x-octopool-public-shape": publicShapeActionsSummary},
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

func relayWatchRunJobs(ctx context.Context, client ghRelayClient, repo string, id string, backoff *watchBackoff) ([]any, error) {
	var jobs []any
	err := retryWatchTick(ctx, backoff, func() error {
		jobs = jobs[:0]
		total := 0
		for page := 1; page <= maxRelayPages; page++ {
			envelope, err := client.do(ctx, ghAPIRequest{
				method: "GET",
				path:   repoPath(repo, "actions", "runs", id, "jobs"),
				query:  map[string]any{"per_page": strconv.Itoa(relayPageSize), "page": strconv.Itoa(page)},
				headers: map[string]string{
					"x-octopool-public-shape": publicShapeActionsJobs,
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
	if !ok || opts.jq != "" && !jqAvailable() {
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
		case isWatchValueFlag(arg, "--json"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "--json")
			if !valueOK {
				return opts, false
			}
			opts.json = splitFields(value)
			if len(opts.json) == 0 || !supportedJSONFields(ghTopOptions{json: opts.json}, supportedCheckRunFields) {
				return opts, false
			}
		case isWatchValueFlag(arg, "--jq"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "--jq")
			if !valueOK {
				return opts, false
			}
			opts.jq = value
		case isWatchValueFlag(arg, "-q"):
			value, valueOK := takeWatchFlagValue(args, &index, arg, "-q")
			if !valueOK {
				return opts, false
			}
			opts.jq = value
		case strings.HasPrefix(arg, "-"):
			return opts, false
		default:
			positionals = append(positionals, arg)
		}
	}
	if !watch || len(positionals) != 1 || !isDigits(positionals[0]) {
		return opts, false
	}
	// real gh rejects --jq without --json; delegate so it reports that itself.
	if opts.jq != "" && len(opts.json) == 0 {
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
		pending, passing, failing := checkWatchCounts(items)
		counts := fmt.Sprintf("%d/%d/%d", pending, passing, failing)
		// Structured output must stay pure: no progress lines ahead of the
		// final --json/--jq payload.
		structured := len(opts.json) > 0 || opts.jq != ""
		if counts != previousCounts && !structured {
			if _, err := fmt.Fprintf(stdout, "checks: %d pending, %d pass, %d fail\n", pending, passing, failing); err != nil {
				return err
			}
			progressPrinted = true
		}
		previousCounts = counts
		if pending == 0 || opts.failFast && failing > 0 {
			// The snapshot's head came from a bounded-staleness lookup; a push
			// right before the watch could otherwise turn a stale SHA's finished
			// checks into a false terminal result. One fresh read per exit.
			current, err := relayPRHeadSHA(ctx, client, opts.repo, opts.number, 0)
			if err != nil {
				return watchError(err, progressPrinted)
			}
			if current == sha {
				if err := printPRChecksWatchFinal(ctx, stdout, items, opts); err != nil {
					return err
				}
				return checkExitCode(items)
			}
		}
		if err := backoff.sleep(ctx); err != nil {
			return err
		}
	}
}

func checkWatchCounts(items []any) (pending int, passing int, failing int) {
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch watchCheckBucket(item) {
		case "pass", "skipping":
			passing++
		case "fail", "cancel":
			failing++
		default:
			pending++
		}
	}
	return pending, passing, failing
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

func printPRChecksWatchFinal(ctx context.Context, stdout io.Writer, items []any, opts ghPRChecksWatchOptions) error {
	if len(opts.json) > 0 {
		raw, err := json.Marshal(items)
		if err != nil {
			return err
		}
		raw, err = filterJSONFields(raw, opts.json, fieldMapCheckRun)
		if err != nil {
			return err
		}
		return writeBytes(ctx, stdout, raw, opts.jq)
	}
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

// watchSafeText strips ASCII/C1 control characters and invalid UTF-8 from
// API-controlled strings so job/check names cannot inject terminal escape
// sequences. Printable CSI remainders like "[31m" are harmless once the
// escape introducer is gone.
func watchSafeText(raw string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) || r == utf8.RuneError {
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
	for _, arg := range args {
		if watchFlagTrue(arg) {
			return true
		}
	}
	return false
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
