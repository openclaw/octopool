package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type ghTopOptions struct {
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

func prepareGHTopOptions(args []string) (ghTopOptions, ghResult, bool) {
	opts, fallback, err := parseGHTopOptions(args)
	if err != nil {
		return opts, ghFailed(err), false
	}
	if fallback || topJQFallback(opts) {
		return opts, ghDelegated(), false
	}
	return opts, ghResult{}, true
}

func parseGHTopOptions(args []string) (ghTopOptions, bool, error) {
	opts := ghTopOptions{limit: 30}
	limitRaw := ""
	attemptRaw := ""
	for index := 0; index < len(args); index++ {
		arg := args[index]
		valueFlag := func(name string) (string, bool, error) {
			if arg == name {
				index++
				if index >= len(args) {
					return "", false, fmt.Errorf("%s requires a value", name)
				}
				return args[index], true, nil
			}
			if strings.HasPrefix(arg, name+"=") {
				return strings.TrimPrefix(arg, name+"="), true, nil
			}
			return "", false, nil
		}
		for _, item := range []struct {
			name string
			set  func(string)
		}{
			{"-R", func(value string) { opts.repo = value; opts.repoCount++ }},
			{"--repo", func(value string) { opts.repo = value; opts.repoCount++ }},
			{"--json", func(value string) { opts.json = splitFields(value) }},
			{"--jq", func(value string) { opts.jq = value }},
			{"-q", func(value string) { opts.jq = value }},
			{"--limit", func(value string) { limitRaw = value; opts.limitSet = true }},
			{"-L", func(value string) { limitRaw = value; opts.limitSet = true }},
			{"--state", func(value string) { opts.state = value }},
			{"--branch", func(value string) { opts.branch = value }},
			{"--workflow", func(value string) { opts.workflow = value }},
			{"--status", func(value string) { opts.status = value }},
			{"--attempt", func(value string) { attemptRaw = value; opts.attemptSet = true }},
			{"--author", func(value string) { opts.author = value }},
			{"--assignee", func(value string) { opts.assignee = value }},
			{"--label", func(value string) { opts.labels = append(opts.labels, value) }},
		} {
			value, ok, err := valueFlag(item.name)
			if err != nil {
				return opts, false, err
			}
			if ok {
				item.set(value)
				goto nextArg
			}
		}
		switch arg {
		case "--patch":
			opts.patch = true
		case "--web", "--comments", "--template", "--paginate", "--slurp":
			return opts, true, nil
		default:
			if strings.HasPrefix(arg, "-") && arg != "--patch" {
				return opts, true, nil
			}
			opts.positionals = append(opts.positionals, arg)
		}
	nextArg:
	}
	if opts.limitSet {
		limit, err := strconv.Atoi(limitRaw)
		if err != nil {
			return opts, false, fmt.Errorf("--limit requires an integer: %w", err)
		}
		opts.limit = limit
	}
	if opts.attemptSet {
		attempt, err := strconv.Atoi(attemptRaw)
		if err != nil || attempt < 1 {
			return opts, false, fmt.Errorf("--attempt requires a positive integer")
		}
		opts.attempt = attempt
	}
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
	if opts.limit < 1 {
		return 1
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

func splitFields(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' '
	})
	out := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		if part != "" && !seen[part] {
			seen[part] = true
			out = append(out, part)
		}
	}
	return out
}

func isDigits(raw string) bool {
	return digitsPattern.MatchString(raw)
}
