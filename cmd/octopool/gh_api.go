package main

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
)

type ghAPIRequest struct {
	method    string
	path      string
	query     map[string]any
	headers   map[string]string
	routeHint map[string]string
	jq        string
	paginate  bool
	slurp     bool
}

func parseGHAPIArgs(args []string) (ghAPIRequest, bool, error) {
	var err error
	args, err = normalizeGHAPIQueryArgs(args)
	if err != nil {
		return ghAPIRequest{}, false, err
	}
	request := ghAPIRequest{
		method:  "GET",
		query:   map[string]any{},
		headers: map[string]string{},
	}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch arg {
		case "--method", "-X":
			index++
			if index >= len(args) {
				return request, false, errors.New("--method requires a value")
			}
			request.method = strings.ToUpper(args[index])
		case "--jq", "-q":
			index++
			if index >= len(args) {
				return request, false, errors.New("--jq requires a value")
			}
			request.jq = args[index]
		case "-H", "--header":
			index++
			if index >= len(args) {
				return request, false, errors.New("--header requires a value")
			}
			key, value, ok := strings.Cut(args[index], ":")
			if ok {
				header := strings.ToLower(strings.TrimSpace(key))
				if !safeRelayHeader(header) {
					return request, true, nil
				}
				request.headers[header] = strings.TrimSpace(value)
			}
		case "--paginate":
			request.paginate = true
		case "--slurp":
			request.slurp = true
		case "-f", "-F", "--field", "--raw-field":
			return request, true, nil
		default:
			if name, value, ok := strings.Cut(arg, "="); ok && (name == "--paginate" || name == "--slurp") {
				enabled, err := strconv.ParseBool(value)
				if err != nil {
					return request, true, nil
				}
				if name == "--paginate" {
					request.paginate = enabled
				} else {
					request.slurp = enabled
				}
				continue
			}
			if strings.HasPrefix(arg, "--method=") {
				request.method = strings.ToUpper(strings.TrimPrefix(arg, "--method="))
				continue
			}
			if strings.HasPrefix(arg, "--jq=") {
				request.jq = strings.TrimPrefix(arg, "--jq=")
				continue
			}
			if strings.HasPrefix(arg, "--header=") {
				key, value, ok := strings.Cut(strings.TrimPrefix(arg, "--header="), ":")
				if ok {
					header := strings.ToLower(strings.TrimSpace(key))
					if !safeRelayHeader(header) {
						return request, true, nil
					}
					request.headers[header] = strings.TrimSpace(value)
				}
				continue
			}
			if strings.HasPrefix(arg, "-") || request.path != "" {
				return request, true, nil
			}
			path, rawQuery, ok := strings.Cut(arg, "?")
			request.path = path
			if ok {
				values, err := url.ParseQuery(rawQuery)
				if err != nil {
					return request, false, err
				}
				for key, items := range values {
					if len(items) == 1 {
						request.query[key] = items[0]
					} else if len(items) > 1 {
						request.query[key] = items
					}
				}
			}
		}
	}
	if request.slurp && !request.paginate {
		return request, false, errors.New("--slurp requires --paginate")
	}
	if request.slurp && request.jq != "" {
		return request, false, errors.New("the `--slurp` option is not supported with `--jq` or `--template`")
	}
	if request.path == "" {
		return request, false, errors.New("gh api path is required")
	}
	if !strings.HasPrefix(request.path, "/") {
		request.path = "/" + request.path
	}
	// Fresh /user reads must skip the saved-login shortcut.
	request.headers = relayReadHeaders(request.method, request.headers)
	return request, request.method != "GET", nil
}

func normalizeGHAPIQueryArgs(args []string) ([]string, error) {
	opts, err := parseRewriteAPI(args)
	if err != nil || len(opts.fields) == 0 {
		return args, nil
	}
	request, err := rewriteAPIRequest(opts)
	if err != nil {
		return args, nil
	}
	if rewriteWorkflowRunsPath.MatchString(request.path) {
		request, err = workflowRunsQuery(opts, request)
		if err != nil {
			return nil, err
		}
	} else {
		// Fields imply POST in native gh unless GET was explicit. Keep complex
		// field expansion and request bodies with the native owner.
		if opts.method != "GET" || opts.inputSet {
			return args, nil
		}
		for _, pattern := range nativeReadPathPatterns {
			if pattern.MatchString(request.path) {
				return args, nil
			}
		}
		for _, field := range opts.fields {
			key, value, ok := strings.Cut(field.value, "=")
			if _, duplicate := request.query[key]; !ok || key == "" || duplicate || strings.ContainsAny(key, "[]{}") || strings.HasPrefix(value, "@") || strings.ContainsAny(value, "{}") || rewriteEndpointPlaceholder.MatchString(value) {
				return args, nil
			}
			if field.name == "--field" {
				if number, err := strconv.Atoi(value); err == nil {
					value = strconv.Itoa(number)
				} else if value == "null" {
					value = ""
				}
			}
			request.query[key] = value
		}
		if !safeRelayRequest(request) {
			return args, nil
		}
	}
	return append([]string{apiQueryEndpoint(request), "--method=GET"}, opts.output...), nil
}

func apiQueryEndpoint(request ghAPIRequest) string {
	query := url.Values{}
	for key, value := range request.query {
		query.Set(key, value.(string))
	}
	if len(query) == 0 {
		return request.path
	}
	return request.path + "?" + query.Encode()
}

func safeRelayHeader(header string) bool {
	switch header {
	// cache-control carries no credentials and is how a caller asks the relay
	// for a live read instead of a shared cache entry.
	case "accept", "x-github-api-version", "if-none-match", "if-modified-since", "cache-control":
		return true
	default:
		return false
	}
}

func safeRelayRequest(request ghAPIRequest) bool {
	if !safeRelayPath(request.path) {
		return false
	}
	if len(request.query) > 0 && !relayQueryPath(request.path) {
		return false
	}
	if request.path == "/search/repositories" && !safeRepositorySearchQuery(request.query) {
		return false
	}
	for key := range request.query {
		if sensitiveQueryKey(key) {
			return false
		}
	}
	return true
}

func safeRepositorySearchQuery(query map[string]any) bool {
	raw, ok := query["q"]
	if !ok {
		return false
	}
	value, ok := raw.(string)
	if !ok {
		return false
	}
	terms, ok := searchTerms(value)
	return ok && len(terms) > 0
}

func safeRelayPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.HasPrefix(path, "/") &&
		!strings.Contains(path, "://") &&
		!strings.Contains(path, "\\") &&
		!strings.Contains(path, "?") &&
		!strings.Contains(path, "#") &&
		!hasGHPlaceholderSegment(path) &&
		!hasDotSegment(path) &&
		!strings.Contains(lower, "%2e") &&
		!strings.Contains(lower, "%5c")
}

func hasGHPlaceholderSegment(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if len(segment) >= 2 && segment[0] == ':' &&
			(segment[1] >= 'A' && segment[1] <= 'Z' || segment[1] >= 'a' && segment[1] <= 'z') {
			return true
		}
	}
	return false
}

func hasDotSegment(path string) bool {
	return path == "." || path == ".." ||
		strings.Contains(path, "/./") || strings.Contains(path, "/../") ||
		strings.HasSuffix(path, "/.") || strings.HasSuffix(path, "/..")
}

func relayQueryPath(path string) bool {
	for _, pattern := range relayQueryPathPatterns {
		if pattern.MatchString(path) {
			return true
		}
	}
	return false
}

func sensitiveQueryKey(key string) bool {
	lower := strings.ToLower(key)
	return strings.Contains(lower, "token") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "password") ||
		strings.Contains(lower, "passwd") ||
		strings.Contains(lower, "api_key") ||
		strings.Contains(lower, "apikey") ||
		strings.Contains(lower, "access_key") ||
		strings.Contains(lower, "private_key")
}
