package main

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

type ghTopOptions struct {
	read        readOptions
	repo        string
	repoCount   int
	json        []string
	jq          string
	patch       bool
	limit       int
	limitSet    bool
	state       string
	branch      string
	workflow    string
	status      string
	attempt     int
	attemptSet  bool
	author      string
	assignee    string
	labels      []string
	positionals []string
}

var digitsPattern = regexp.MustCompile(`^[0-9]+$`)

func topReadSpecs(command string) map[string]readOptionSpec {
	values, booleans := "--repo,-R --json --jq,-q", ""
	switch command {
	case "pr view", "issue view", "repo view", "release view", "workflow view", "gist view":
	case "pr diff":
		values, booleans = "--repo,-R", "--patch"
	case "pr list", "issue list":
		values += " --limit,-L --state --author --assignee --label"
	case "run list":
		values += " --limit,-L --branch --workflow --status"
	case "run view":
		values += " --attempt"
	case "pr checks":
		booleans = "--watch --required --fail-fast"
	case "release list", "workflow list", "label list":
		values += " --limit,-L"
	case "search issues", "search prs":
		values += " --limit,-L --state --author --assignee --label"
	case "search repos":
		values = "--json --jq,-q --limit,-L"
	default:
		return nil
	}
	return typedReadSpecs(command, values, booleans)
}

func prepareGHTopOptions(command string, args []string) (ghTopOptions, ghResult, bool) {
	opts, fallback, err := parseGHTopOptions(args, topReadSpecs(command))
	if _, invalidEnum := err.(readEnumError); invalidEnum {
		return opts, ghDelegated(), false
	}
	if err != nil {
		return opts, ghFailed(err), false
	}
	if fallback || topJQFallback(opts) || (opts.read.has("--json") && len(opts.json) == 0) || (opts.read.has("--jq") && !opts.read.has("--json")) {
		return opts, ghDelegated(), false
	}
	if opts.limitSet && (opts.limit < 1 || (strings.HasPrefix(command, "search ") && opts.limit > 1000)) {
		return opts, ghFailed(fmt.Errorf("--limit is outside the command range")), false
	}
	if command == "pr list" || command == "issue list" {
		opts.state = strings.ToLower(opts.state)
	}
	if command == "run list" && opts.status != strings.ToLower(opts.status) {
		// Native preserves status spelling; the relay's modeled status set does not.
		return opts, ghDelegated(), false
	}
	if command == "pr list" {
		if opts.read.has("--author") || opts.read.has("--assignee") || opts.read.has("--label") {
			return opts, ghDelegated(), false
		}
	}
	if command == "pr checks" && (opts.read.values["--watch"].boolean || opts.read.values["--required"].boolean || opts.read.values["--fail-fast"].boolean) {
		return opts, ghDelegated(), false
	}
	return opts, ghResult{}, true
}

func parseGHTopOptions(args []string, specs map[string]readOptionSpec) (ghTopOptions, bool, error) {
	opts := ghTopOptions{limit: 30}
	parsed, fallback, err := parseReadOptions(args, specs)
	opts.read = parsed
	if err != nil || fallback {
		return opts, fallback, err
	}
	opts.positionals = parsed.positionals
	opts.repo = parsed.values["--repo"].raw
	for _, occurrence := range parsed.ordered {
		if occurrence.name == "--repo" {
			opts.repoCount++
		}
	}
	if spec, ok := specs["--repo"]; ok && spec.kind == readSlice && parsed.has("--repo") {
		repos := parsed.values["--repo"].strings
		if opts.repoCount > 1 || len(repos) != 1 {
			return opts, true, nil
		}
		opts.repo = repos[0]
	}
	opts.json = uniqueReadFields(parsed.values["--json"].strings)
	opts.jq = parsed.values["--jq"].raw
	opts.patch = parsed.values["--patch"].boolean
	opts.limitSet = parsed.has("--limit")
	if opts.limitSet {
		limit := parsed.values["--limit"].integer
		if limit < math.MinInt || limit > math.MaxInt {
			return opts, true, nil
		}
		opts.limit = int(limit)
	}
	opts.state = parsed.values["--state"].raw
	opts.branch = parsed.values["--branch"].raw
	opts.workflow = parsed.values["--workflow"].raw
	opts.status = parsed.values["--status"].raw
	opts.attemptSet = parsed.has("--attempt")
	if opts.attemptSet {
		attempt := parsed.values["--attempt"].uint
		if attempt > math.MaxInt {
			return opts, true, nil
		}
		opts.attempt = int(attempt)
	}
	opts.author = parsed.values["--author"].raw
	opts.assignee = parsed.values["--assignee"].raw
	opts.labels = parsed.values["--label"].strings
	return opts, false, nil
}

func listQuery(opts ghTopOptions) map[string]any {
	return listQueryDefault(opts, 30)
}

func listQueryDefault(opts ghTopOptions, defaultLimit int) map[string]any {
	return map[string]any{"per_page": strconv.Itoa(desiredLimitDefault(opts, defaultLimit))}
}

func desiredLimit(opts ghTopOptions) int {
	return desiredLimitDefault(opts, 30)
}

func desiredLimitDefault(opts ghTopOptions, defaultLimit int) int {
	if !opts.limitSet {
		return defaultLimit
	}
	if opts.limit > 100 {
		return 100
	}
	return opts.limit
}

func limitOverOnePage(opts ghTopOptions) bool {
	return opts.limitSet && opts.limit > 100
}

func topJQFallback(opts ghTopOptions) bool {
	return opts.jq != "" && !jqAvailable()
}

func machineReadable(opts ghTopOptions) bool {
	return len(opts.json) > 0
}

func hasTopModifiers(opts ghTopOptions) bool {
	return opts.patch ||
		opts.limitSet ||
		opts.state != "" ||
		opts.branch != "" ||
		opts.workflow != "" ||
		opts.status != "" ||
		opts.attemptSet ||
		opts.author != "" ||
		opts.assignee != "" ||
		len(opts.labels) > 0
}

func hasRunViewModifiers(opts ghTopOptions) bool {
	opts.attempt = 0
	opts.attemptSet = false
	return hasTopModifiers(opts)
}

func hasTopModifiersExceptPatch(opts ghTopOptions) bool {
	opts.patch = false
	return hasTopModifiers(opts)
}

func supportedWorkflowRef(ref string) bool {
	lower := strings.ToLower(ref)
	return isDigits(ref) || strings.HasSuffix(lower, ".yml") || strings.HasSuffix(lower, ".yaml")
}

func isDigits(raw string) bool {
	return digitsPattern.MatchString(raw)
}
