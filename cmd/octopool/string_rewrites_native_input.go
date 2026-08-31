package main

import (
	"maps"
	"mime"
	"strconv"
	"strings"
)

type bestEffortInputKind uint8

const (
	bestEffortUndeclared bestEffortInputKind = iota
	bestEffortText
	bestEffortDeclaredJSON
)

type bestEffortArg struct {
	start, end    int
	name, value   string
	booleanPrefix string
}

func (arg bestEffortArg) capturedField(value string) string {
	if arg.booleanPrefix != "" {
		return arg.booleanPrefix + "F=" + value
	}
	return "--field=" + value
}

type bestEffortNativeInput struct {
	command, subcommand string
	args                []bestEffortArg
	argv                []string
	delimiter           int
	workflowJSON        bool
	inputKind           bestEffortInputKind
}

// Parse known native declarations without rewriting caller spelling. Synthetic
// flag names and defaults must never become visible policy input.
func describeBestEffortInput(args []string) (bestEffortNativeInput, error) {
	out := bestEffortNativeInput{delimiter: -1}
	argumentBytes := 0
	appendArg := func(arg string) error {
		argumentBytes += len(arg)
		if argumentBytes > rewriteMaxContent {
			return errRewriteBlocked
		}
		out.argv = append(out.argv, arg)
		return nil
	}
	commandIndex := -1
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			out.delimiter = len(out.argv)
			for ; i < len(args); i++ {
				start := len(out.argv)
				if err := appendArg(args[i]); err != nil {
					return out, err
				}
				out.args = append(out.args, bestEffortArg{start: start, end: start + 1})
			}
			break
		}
		parseArg, booleanPrefix := arg, ""
		// Native API has one Boolean shorthand: i. Each occurrence leaves the
		// next shorthand active, unless =value assigns the whole remainder.
		if out.command == "api" && strings.HasPrefix(arg, "-i") {
			rest, value := arg[1:], "true"
			for strings.HasPrefix(rest, "i") {
				rest = rest[1:]
				if strings.HasPrefix(rest, "=") {
					value, rest = rest[1:], ""
				}
				if _, err := strconv.ParseBool(value); err != nil {
					return out, errRewriteBlocked
				}
			}
			// An invalid '-' shorthand must not become a long option or delimiter.
			if strings.HasPrefix(rest, "-") {
				return out, errRewriteBlocked
			}
			if rest == "" {
				parseArg = "--include=" + value
			} else {
				booleanPrefix = arg[:len(arg)-len(rest)]
				parseArg = "-" + rest
			}
		}
		token := bestEffortArg{start: len(out.argv), booleanPrefix: booleanPrefix}
		if err := appendArg(arg); err != nil {
			return out, err
		}
		if !strings.HasPrefix(arg, "-") {
			if out.command == "" {
				out.command = arg
				commandIndex = token.start
			} else if out.subcommand == "" {
				out.subcommand = arg
			}
		} else {
			name, value, equal := strings.Cut(parseArg, "=")
			if !strings.HasPrefix(parseArg, "--") && len(parseArg) > 2 {
				name, value, equal = parseArg[:2], parseArg[2:], true
				// With no text after '=', pflag treats it as the value itself.
				if len(value) > 1 && value[0] == '=' {
					value = value[1:]
				}
			}
			canonical := ""
			switch name {
			case "--repo", "-R":
				canonical = "--repo"
			case "--input":
				canonical = "--input"
			case "--field", "-F":
				canonical = "--field"
			}
			if out.command == "api" {
				switch name {
				case "--header", "-H":
					canonical = "--header"
				case "--hostname", "--cache":
					canonical = name
				case "--method", "-X":
					canonical = "--method"
				case "--raw-field", "-f":
					canonical = "--raw-field"
				case "--jq", "-q":
					canonical = "--jq"
				case "--template", "-t":
					canonical = "--template"
				case "--preview", "-p":
					canonical = "--preview"
				}
			}
			if out.command == "workflow" {
				switch name {
				case "--ref", "-r":
					canonical = "--ref"
				case "--raw-field", "-f":
					canonical = "--raw-field"
				}
			}
			if canonical != "" {
				if !equal {
					i++
					if i >= len(args) {
						return out, errRewriteBlocked
					}
					value = args[i]
					if err := appendArg(value); err != nil {
						return out, err
					}
				}
				token.name, token.value = canonical, value
			} else if out.command == "api" && name == "--include" {
				if !equal {
					value = "true"
				}
				if _, err := strconv.ParseBool(value); err != nil {
					return out, errRewriteBlocked
				}
				token.name, token.value = name, value
			} else if (out.command == "workflow" || out.command == "") && name == "-h" {
				token.name = "-h"
			} else if ((out.command == "workflow" || out.command == "") && name == "--help") || (out.command == "workflow" && name == "--json") {
				if !equal {
					value = "true"
				}
				token.name, token.value = name, value
			}
		}
		token.end = len(out.argv)
		out.args = append(out.args, token)
	}
	if out.delimiter < 0 {
		out.delimiter = len(out.argv)
	}
	if out.command == "workflow" && out.subcommand == "run" {
		help := false
		for _, token := range out.args {
			// gh's inherited help flag has no h alias. Pflag returns ErrHelp
			// immediately on h; its suffix and later assignments cannot undo it.
			if token.name == "-h" {
				help = true
				break
			}
			if token.name == "--json" || token.name == "--help" {
				value, err := strconv.ParseBool(token.value)
				if err != nil {
					return out, errRewriteBlocked
				}
				if token.name == "--json" {
					out.workflowJSON = value
				} else {
					help = value
				}
			}
		}
		out.workflowJSON = out.workflowJSON && !help
	}
	if out.command == "api" {
		args = out.argv
		out.inputKind = bestEffortDeclaredJSON
		endpoint := ""
		headers := []string{}
		for _, token := range out.args {
			switch token.name {
			case "--hostname":
				if token.value != "github.com" {
					return out, errRewriteBlocked
				}
			case "--header":
				if sensitiveBestEffortHeader(token.value) {
					return out, errRewriteBlocked
				}
				name, value, ok := strings.Cut(token.value, ":")
				if strings.EqualFold(strings.TrimSpace(name), "Content-Type") {
					if !ok {
						return out, errRewriteBlocked
					}
					headers = append(headers, strings.TrimSpace(value))
				}
			case "":
				value := args[token.start]
				if token.start == commandIndex {
					continue
				}
				if endpoint == "" && value != "--" && (token.start > out.delimiter || !strings.HasPrefix(value, "-")) {
					endpoint = value
				}
			}
		}
		if endpoint == "" || strings.Contains(endpoint, "://") || rewriteEndpointPlaceholder.MatchString(endpoint) {
			return out, errRewriteBlocked
		}
		kind, err := bestEffortContentType(headers)
		if err != nil {
			return out, err
		}
		out.inputKind = kind
	}
	return out, nil
}

func bestEffortContentType(headers []string) (bestEffortInputKind, error) {
	// Native Header.Add retains order. Header.Get sees the first value, and an
	// empty first value causes the transport to replace all values with JSON.
	if len(headers) == 0 || headers[0] == "" {
		return bestEffortDeclaredJSON, nil
	}
	media, params, err := mime.ParseMediaType(headers[0])
	if err != nil || !strings.Contains(media, "/") {
		return 0, errRewriteBlocked
	}
	for _, value := range headers[1:] {
		other, otherParams, err := mime.ParseMediaType(value)
		if err != nil || media != other || !maps.Equal(params, otherParams) {
			return 0, errRewriteBlocked
		}
	}
	_, subtype, _ := strings.Cut(media, "/")
	if subtype == "json" || strings.HasSuffix(subtype, "+json") {
		return bestEffortDeclaredJSON, nil
	}
	return bestEffortText, nil
}

func insertBestEffortFlag(args []string, declaration bestEffortNativeInput, flag string) []string {
	out := append([]string(nil), args[:declaration.delimiter]...)
	out = append(out, flag)
	return append(out, args[declaration.delimiter:]...)
}

// Sources are captured before argv rewriting, but rewritten only after both
// declarations are known. The empty private snapshot is an owned opaque handle;
// original bytes remain in bounded memory and never reach the child uninspected.
type bestEffortCapturedInput struct {
	data []byte
	kind bestEffortInputKind
}
