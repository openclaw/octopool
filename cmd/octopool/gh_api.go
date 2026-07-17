package main

import (
	"errors"
	"net/url"
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
	return request, request.method != "GET", nil
}

func safeRelayHeader(header string) bool {
	switch header {
	case "accept", "x-github-api-version", "if-none-match", "if-modified-since":
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
		!hasDotSegment(path) &&
		!strings.Contains(lower, "%2e") &&
		!strings.Contains(lower, "%5c")
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
