package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
)

type graphQLReadRequest struct {
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables"`
	OperationName string         `json:"operationName,omitempty"`
	viewer        *graphQLLocalViewer
}

var graphQLReadToken = regexp.MustCompile(`[_A-Za-z][_0-9A-Za-z]*|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|"(?:\\.|[^"\\\r\n])*"|[!$():{}\[\]@=]|\.\.\.`)
var graphQLVariableName = regexp.MustCompile(`^[_A-Za-z][_0-9A-Za-z]*$`)

// This bounded token check is an optimization only. The Worker parses the AST
// and owns authorization and the single-repository credential boundary.
func graphQLReadTokens(query string) ([]string, bool) {
	if len(query) == 0 || len(query) > 16384 || strings.Contains(query, `"""`) {
		return nil, false
	}
	var tokens []string
	for len(query) > 0 {
		query = strings.TrimLeft(query, " \t\r\n,\ufeff")
		if query == "" {
			break
		}
		if query[0] == '#' {
			if end := strings.IndexByte(query, '\n'); end >= 0 {
				query = query[end+1:]
				continue
			}
			break
		}
		match := graphQLReadToken.FindStringIndex(query)
		if match == nil || match[0] != 0 {
			return nil, false
		}
		token := query[:match[1]]
		if token == "mutation" || token == "subscription" || token == "rateLimit" || token == "__schema" || token == "__type" {
			return nil, false
		}
		tokens = append(tokens, token)
		if len(tokens) > 4000 {
			return nil, false
		}
		query = query[match[1]:]
	}
	return tokens, len(tokens) > 0
}

func repositoryGraphQLRead(read *graphQLReadRequest) bool {
	tokens, ok := graphQLReadTokens(read.Query)
	if !ok {
		return false
	}
	i := 0
	skip := func(open, close string) bool {
		if i >= len(tokens) || tokens[i] != open {
			return false
		}
		depth := 0
		for i < len(tokens) {
			token := tokens[i]
			i++
			if token == open {
				depth++
			}
			if token == close {
				depth--
				if depth == 0 {
					return true
				}
			}
			if depth > 12 {
				return false
			}
		}
		return false
	}
	operationName := ""
	if tokens[i] == "query" {
		i++
		if i < len(tokens) && graphQLVariableName.MatchString(tokens[i]) {
			operationName = tokens[i]
			i++
		}
		if i < len(tokens) && tokens[i] == "(" && !skip("(", ")") {
			return false
		}
	}
	if read.OperationName != "" && read.OperationName != operationName {
		return false
	}
	if i >= len(tokens) || tokens[i] != "{" {
		return false
	}
	i++
	repositories := 0
	repo := ""
	viewer := &graphQLLocalViewer{}
	viewerStart, viewerEnd := 0, 0
	for i < len(tokens) && tokens[i] != "}" {
		start := i
		field := tokens[i]
		key := field
		if !graphQLVariableName.MatchString(field) {
			return false
		}
		i++
		if i < len(tokens) && tokens[i] == ":" {
			i++
			if i >= len(tokens) {
				return false
			}
			field = tokens[i]
			i++
		}
		viewer.keys = append(viewer.keys, key)
		if field == "viewer" {
			if viewer.key != "" || i+2 >= len(tokens) || tokens[i] != "{" || tokens[i+1] != "login" || tokens[i+2] != "}" {
				return false
			}
			i += 3
			viewer.key, viewerStart, viewerEnd = key, start, i
			continue
		}
		if field == "repository" {
			repositories++
			if i >= len(tokens) || tokens[i] != "(" {
				return false
			}
			i++
			args := map[string]string{}
			for i < len(tokens) && tokens[i] != ")" {
				name := tokens[i]
				i++
				if (name != "owner" && name != "name") || args[name] != "" || i >= len(tokens) || tokens[i] != ":" {
					return false
				}
				i++
				if i >= len(tokens) {
					return false
				}
				value := ""
				if tokens[i] == "$" {
					i++
					if i >= len(tokens) {
						return false
					}
					value, ok = read.Variables[tokens[i]].(string)
					if !ok {
						return false
					}
					i++
				} else {
					if json.Unmarshal([]byte(tokens[i]), &value) != nil {
						return false
					}
					i++
				}
				if value == "" || value == "." || value == ".." || strings.Contains(value, "/") {
					return false
				}
				args[name] = value
			}
			if i >= len(tokens) || !rewriteRepoPattern.MatchString(args["owner"]+"/"+args["name"]) {
				return false
			}
			current := strings.ToLower(args["owner"] + "/" + args["name"])
			if repo != "" && repo != current {
				return false
			}
			repo = current
			i++
		} else if field != "__typename" {
			return false
		}
		for i < len(tokens) && tokens[i] == "@" {
			i++
			if i >= len(tokens) || (tokens[i] != "include" && tokens[i] != "skip") {
				return false
			}
			i++
			if !skip("(", ")") {
				return false
			}
		}
		if field == "repository" && !skip("{", "}") {
			return false
		}
	}
	if repositories == 0 || i >= len(tokens) || tokens[i] != "}" {
		return false
	}
	i++
	// Named fragments may follow the operation. The Worker expands, bounds and
	// checks every spread, including unused fragments and cycles.
	for i < len(tokens) {
		if tokens[i] != "fragment" || i+3 >= len(tokens) || !graphQLVariableName.MatchString(tokens[i+1]) || tokens[i+2] != "on" || !graphQLVariableName.MatchString(tokens[i+3]) {
			return false
		}
		i += 4
		if !skip("{", "}") {
			return false
		}
	}
	for index, token := range tokens {
		if (index < viewerStart || index >= viewerEnd) && strings.HasPrefix(token, "viewer") {
			return false
		}
	}
	if viewer.key != "" {
		seen := map[string]bool{}
		for _, key := range viewer.keys {
			if seen[key] {
				return false
			}
			seen[key] = true
		}
		read.Query = strings.Join(append(tokens[:viewerStart:viewerStart], tokens[viewerEnd:]...), " ")
		read.viewer = viewer
	}
	return true
}

func parseRepositoryGraphQL(args []string) (ghAPIRequest, bool) {
	if envDefault("OCTOPOOL_GRAPHQL_RELAY", "") == "0" {
		return ghAPIRequest{}, false
	}
	opts, err := parseRewriteAPI(args)
	if err != nil || (opts.endpoint != "graphql" && opts.endpoint != "/graphql") || opts.method != "POST" || opts.inputSet {
		return ghAPIRequest{}, false
	}
	if opts.hostname == "" && envDefault("GH_HOST", "github.com") != "github.com" {
		return ghAPIRequest{}, false
	}
	for key := range opts.headers {
		if key != "accept" && key != "cache-control" {
			return ghAPIRequest{}, false
		}
	}
	for _, output := range opts.output {
		if strings.HasPrefix(output, "--paginate") || strings.HasPrefix(output, "--slurp") {
			return ghAPIRequest{}, false
		}
	}
	read := &graphQLReadRequest{Variables: map[string]any{}}
	fields := map[string]bool{}
	for _, field := range opts.fields {
		key, raw, ok := strings.Cut(field.value, "=")
		if !ok || !graphQLVariableName.MatchString(key) || fields[key] || (field.name == "--field" && (strings.HasPrefix(raw, "@") || strings.Contains(raw, "{owner}") || strings.Contains(raw, "{repo}") || strings.Contains(raw, "{branch}"))) {
			return ghAPIRequest{}, false
		}
		fields[key] = true
		var value any = raw
		if field.name == "--field" {
			if number, err := strconv.Atoi(raw); err == nil {
				if number > 9007199254740991 || number < -9007199254740991 {
					return ghAPIRequest{}, false
				}
				value = number
			} else if raw == "true" {
				value = true
			} else if raw == "false" {
				value = false
			} else if raw == "null" {
				value = nil
			}
		}
		switch key {
		case "query":
			read.Query, ok = value.(string)
		case "operationName":
			read.OperationName, ok = value.(string)
		default:
			read.Variables[key] = value
		}
		if !ok {
			return ghAPIRequest{}, false
		}
	}
	variables, err := json.Marshal(read.Variables)
	if err != nil || len(variables) > 16384 || !repositoryGraphQLRead(read) {
		return ghAPIRequest{}, false
	}
	if read.viewer != nil {
		login, ok := nativeGraphQLViewerLogin()
		if !ok {
			return ghAPIRequest{}, false
		}
		read.viewer.login = login
	}
	request, fallback, err := parseGHAPIArgs(append([]string{"/graphql"}, opts.output...))
	if err != nil || fallback || request.paginate || request.slurp {
		return ghAPIRequest{}, false
	}
	if accept := request.headers["accept"]; accept != "" && accept != "application/json" && accept != "application/vnd.github+json" {
		return ghAPIRequest{}, false
	}
	request.method, request.graphql = "POST", read
	if freshReadRequested() {
		request.headers["cache-control"] = "max-age=0"
	} else if _, present := opts.headers["cache-control"]; !present {
		request.headers["cache-control"] = "max-age=20"
	}
	return request, true
}

func relayRepositoryGraphQL(ctx context.Context, request ghAPIRequest, stdout io.Writer) error {
	if request.jq != "" && !jqAvailable() {
		return localFallbackError{Reason: "jq_unavailable"}
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return repositoryGraphQLFallback(err)
	}
	raw, err := decodeRelayBody(envelope)
	if err != nil {
		return localFallbackError{Reason: "unsupported_graphql_read_response"}
	}
	var response struct {
		Data   json.RawMessage   `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if envelope.Relay.RouteKind != "graphql_read" || json.Unmarshal(raw, &response) != nil || (response.Data == nil && len(response.Errors) == 0) {
		return localFallbackError{Reason: "unsupported_graphql_read_response"}
	}
	if request.graphql.viewer != nil {
		raw, err = spliceGraphQLViewer(raw, request.graphql.viewer)
		if err != nil {
			return localFallbackError{Reason: "unsupported_graphql_read_response"}
		}
		envelope.Body, _ = json.Marshal(string(raw))
		envelope.BodyEncoding = "text"
	}
	if err := writeGHBody(ctx, stdout, envelope, request.jq); err != nil {
		return err
	}
	if len(response.Errors) != 0 {
		return errors.New("GraphQL request failed")
	}
	return nil
}

func repositoryGraphQLFallback(err error) error {
	if isLocalFallback(err) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errRewritePolicy) || errors.Is(err, errRewriteBlocked) {
		return err
	}
	var relay *relayResponseError
	if errors.As(err, &relay) && relay.Code != "method_denied" && (relay.Status < 500 || relay.Code == "pool_policy_unavailable" || strings.HasPrefix(relay.Code, "string_rewrite")) {
		return err
	}
	return localFallbackError{Reason: "graphql_relay_unavailable"}
}
