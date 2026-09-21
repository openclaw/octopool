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

var landingGraphQLToken = regexp.MustCompile(`[_A-Za-z][_0-9A-Za-z]*|[0-9]+|"(?:\\.|[^"\\])*"|[!$():{}]|\.\.\.`)

// Compare GraphQL tokens, not stripped text: whitespace between two names must
// never turn an unsupported query into an allowlisted one.
func landingGraphQLTokens(query string) string {
	positions := landingGraphQLToken.FindAllStringIndex(query, -1)
	var tokens []string
	end := 0
	for _, position := range positions {
		if strings.Trim(query[end:position[0]], " \t\r\n,") != "" {
			return ""
		}
		tokens = append(tokens, query[position[0]:position[1]])
		end = position[1]
	}
	if strings.Trim(query[end:], " \t\r\n,") != "" {
		return ""
	}
	return strings.Join(tokens, " ")
}

func parseLandingGraphQL(args []string) (ghAPIRequest, bool) {
	opts, err := parseRewriteAPI(args)
	if err != nil || (opts.endpoint != "graphql" && opts.endpoint != "/graphql") || opts.method != "POST" || opts.inputSet {
		return ghAPIRequest{}, false
	}
	if opts.hostname == "" && envDefault("GH_HOST", "github.com") != "github.com" {
		return ghAPIRequest{}, false
	}
	fields := map[string]rewriteFlag{}
	for _, field := range opts.fields {
		key, value, ok := strings.Cut(field.value, "=")
		if _, duplicate := fields[key]; !ok || duplicate || strings.HasPrefix(value, "@") {
			return ghAPIRequest{}, false
		}
		field.value = value
		fields[key] = field
	}
	query := landingGraphQLTokens(fields["query"].value)
	shape, numberKey := "", "pr"
	switch query {
	case landingGraphQLTokens(githubLandingQueryPullRequestCISummary):
		shape = publicShapePullRequestCISummary
	case landingGraphQLTokens(githubLandingQueryPullRequestCIRollup):
		shape = publicShapePullRequestCIRollup
	case landingGraphQLTokens(githubLandingQueryPullRequestMergeSnapshot):
		shape, numberKey = publicShapePullRequestMergeSnapshot, "number"
	default:
		return ghAPIRequest{}, false
	}
	for key := range fields {
		if key != "query" && key != "owner" && key != "name" && key != numberKey && (key != "cursor" || shape != publicShapePullRequestCIRollup) {
			return ghAPIRequest{}, false
		}
	}
	owner, name := fields["owner"].value, fields["name"].value
	if !landingGraphQLString(fields["owner"]) || !landingGraphQLString(fields["name"]) {
		return ghAPIRequest{}, false
	}
	if !rewriteRepoPattern.MatchString(owner+"/"+name) || strings.Contains(owner, "/") || strings.Contains(name, "/") {
		return ghAPIRequest{}, false
	}
	number := fields[numberKey]
	parsed, err := strconv.ParseInt(number.value, 10, 32)
	if err != nil || parsed < 1 || number.name != "--field" {
		return ghAPIRequest{}, false
	}
	args = append([]string{repoPath(owner+"/"+name, "pulls", strconv.FormatInt(parsed, 10))}, opts.output...)
	if opts.hostname != "" {
		args = append(args, "--hostname="+opts.hostname)
	}
	request, fallback, err := parseGHAPIArgs(args)
	if err != nil || fallback || request.paginate || request.slurp || request.headers["if-none-match"] != "" || request.headers["if-modified-since"] != "" {
		return ghAPIRequest{}, false
	}
	if accept := request.headers["accept"]; accept != "" && accept != "application/json" && accept != "application/vnd.github+json" {
		return ghAPIRequest{}, false
	}
	request.headers["x-octopool-public-shape"] = shape
	if cursor, present := fields["cursor"]; present {
		if cursor.value == "" || len(cursor.value) > 512 || strings.ContainsAny(cursor.value, "\x00\t\r\n{}") || !landingGraphQLString(cursor) {
			return ghAPIRequest{}, false
		}
		request.query["cursor"] = cursor.value
	}
	return request, safeRelayRequest(request)
}

func landingGraphQLString(field rewriteFlag) bool {
	if field.name == "--raw-field" {
		return true
	}
	if field.name != "--field" || field.value == "null" || field.value == "true" || field.value == "false" {
		return false
	}
	_, err := strconv.Atoi(field.value)
	return err != nil
}

func relayLandingGraphQL(ctx context.Context, request ghAPIRequest, stdout io.Writer) error {
	if request.jq != "" && !jqAvailable() {
		return localFallbackError{Reason: "jq_unavailable"}
	}
	client, err := newGHRelayClient()
	if err != nil {
		return err
	}
	envelope, err := client.do(ctx, request)
	if err != nil {
		return err
	}
	var response struct {
		Errors []json.RawMessage          `json:"errors"`
		Data   map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(envelope.Body, &response); err != nil {
		return err
	}
	if _, present := response.Data["repository"]; !present && len(response.Errors) == 0 {
		return localFallbackError{Reason: "unsupported_graphql_landing_shape"}
	}
	if err := writeGHBody(ctx, stdout, envelope, request.jq); err != nil {
		return err
	}
	if len(response.Errors) != 0 {
		return errors.New("GraphQL request failed")
	}
	return nil
}
