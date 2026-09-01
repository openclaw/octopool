package main

import (
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"
)

type readOptionKind uint8

const (
	readString readOptionKind = iota
	readSlice
	readInt
	readUint
	readBool
)

type readOptionSpec struct {
	name     string
	kind     readOptionKind
	enum     []string
	attached bool
}

type readOptionValue struct {
	raw     string
	strings []string
	integer int64
	uint    uint64
	boolean bool
}

type readOccurrence struct {
	name, raw   string
	start, end  int
	valueIndex  int
	valuePrefix string
}

type readOptions struct {
	argv        []string
	ordered     []readOccurrence
	values      map[string]readOptionValue
	positionals []string
	delimiter   int
}

type readEnumError struct{ name string }

func (err readEnumError) Error() string { return "invalid value for " + err.name }

func (opts readOptions) has(name string) bool { _, ok := opts.values[name]; return ok }

// This owner knows only the caller's vocabulary. Unknown grammar is delegated,
// never assigned a guessed value type. Original spans remain separate from projection.
func parseReadOptions(args []string, specs map[string]readOptionSpec) (readOptions, bool, error) {
	out := readOptions{argv: append([]string(nil), args...), values: map[string]readOptionValue{}, delimiter: len(args)}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			out.delimiter = i
			out.positionals = append(out.positionals, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			out.positionals = append(out.positionals, arg)
			continue
		}
		name, raw, equals := strings.Cut(arg, "=")
		prefix := name + "="
		if !strings.HasPrefix(arg, "--") && len(arg) > 2 {
			name = arg[:2]
			spec, ok := specs[name]
			if !ok || (!spec.attached && arg[2] != '=') {
				return out, true, nil
			}
			// Boolean shorthand needs a nonempty '=value'; a lone '=' or
			// an attached suffix is native cluster/error grammar, not a value.
			if spec.kind == readBool && (arg[2] != '=' || len(arg) == 3) {
				return out, true, nil
			}
			raw, equals, prefix = arg[2:], true, name
			// pflag treats a lone '=' remainder as the value, not an empty value.
			if len(raw) > 1 && raw[0] == '=' {
				raw, prefix = raw[1:], name+"="
			}
		}
		spec, ok := specs[name]
		if !ok {
			return out, true, nil
		}
		occurrence := readOccurrence{name: spec.name, start: i, valueIndex: i, valuePrefix: prefix}
		if spec.kind == readBool && !equals {
			raw = "true"
		} else if !equals {
			i++
			if i == len(args) {
				return out, false, fmt.Errorf("%s requires a value", name)
			}
			raw = args[i]
			occurrence.valueIndex, occurrence.valuePrefix = i, ""
		}
		occurrence.raw, occurrence.end = raw, i+1
		out.ordered = append(out.ordered, occurrence)
		value := readOptionValue{raw: raw}
		var err error
		switch spec.kind {
		case readSlice:
			value.strings, err = readStringSlice(raw)
			if previous, present := out.values[spec.name]; present && err == nil {
				value.strings = append(previous.strings, value.strings...)
			}
		case readInt:
			value.integer, err = strconv.ParseInt(raw, 0, 64)
		case readUint:
			value.uint, err = strconv.ParseUint(raw, 0, 64)
		case readBool:
			value.boolean, err = strconv.ParseBool(raw)
		}
		if err != nil {
			return out, false, fmt.Errorf("invalid value for %s: %w", spec.name, err)
		}
		if len(spec.enum) != 0 {
			valid := false
			for _, choice := range spec.enum {
				valid = valid || strings.EqualFold(raw, choice)
			}
			if !valid {
				return out, false, readEnumError{name: spec.name}
			}
		}
		out.values[spec.name] = value
	}
	return out, false, nil
}

func readStringSlice(raw string) ([]string, error) {
	if raw == "" {
		return nil, nil
	}
	return csv.NewReader(strings.NewReader(raw)).Read()
}

func uniqueReadFields(fields []string) []string {
	var out []string
	seen := make(map[string]bool, len(fields))
	for _, field := range fields {
		if !seen[field] {
			seen[field] = true
			out = append(out, field)
		}
	}
	return out
}

// Types augment an existing command-owned vocabulary, not native eligibility.
func typedReadSpecs(command, values, booleans string) map[string]readOptionSpec {
	out := map[string]readOptionSpec{}
	for alias, name := range rewriteFlagNames(values) {
		spec := readOptionSpec{name: name}
		// These existing aliases retain their native attached-value ownership
		// even when the read guard preserves the caller's original spelling.
		switch alias {
		case "-R", "-L", "-q":
			spec.attached = true
		}
		switch name {
		case "--json", "--label":
			spec.kind = readSlice
		case "--repo":
			if command == "search issues" || command == "search prs" {
				spec.kind = readSlice
			}
		case "--limit", "--interval":
			spec.kind = readInt
		case "--attempt":
			spec.kind = readUint
		case "--state":
			switch command {
			case "pr list":
				spec.enum = []string{"open", "closed", "merged", "all"}
			case "issue list":
				spec.enum = []string{"open", "closed", "all"}
			case "search issues", "search prs":
				spec.enum = []string{"open", "closed"}
			}
		case "--status":
			spec.enum = []string{"queued", "completed", "in_progress", "requested", "waiting", "pending", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out"}
		}
		out[alias] = spec
	}
	for alias, name := range rewriteFlagNames(booleans) {
		out[alias] = readOptionSpec{name: name, kind: readBool}
	}
	return out
}
