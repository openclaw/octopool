package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"strings"
)

func runRequest(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	requestFlags := newCallerRequestFlags(fs)
	method := fs.String("method", "GET", "GitHub method")
	path := fs.String("path", "", "GitHub API path")
	queryValues := multiFlag{}
	headerValues := multiFlag{}
	routeHintValues := multiFlag{}
	fs.Var(&queryValues, "query", "query key=value, repeatable")
	fs.Var(&headerValues, "header", "header key=value, repeatable")
	fs.Var(&routeHintValues, "route-hint", "route hint key=value, repeatable")
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool request --path PATH [flags]"); err != nil {
		return err
	} else if handled {
		return nil
	}
	auth, err := requestFlags.applyAuth(fs)
	if err != nil {
		return err
	}
	if *path == "" {
		return errors.New("--path is required")
	}
	token, err := requestFlags.authorize(auth)
	if err != nil {
		return err
	}
	body := map[string]any{
		"pool":   *requestFlags.pool,
		"method": strings.ToUpper(*method),
		"path":   *path,
	}
	if len(queryValues) > 0 {
		body["query"] = valuesMap(queryValues)
	}
	if len(headerValues) > 0 {
		body["headers"] = valuesMap(headerValues)
	}
	if len(routeHintValues) > 0 {
		body["route_hint"] = valuesMap(routeHintValues)
	}
	return postJSON(ctx, stdout, apiURL(*requestFlags.baseURL, "/v1/github/request"), token, body)
}

type multiFlag []string

func (m *multiFlag) String() string {
	return strings.Join(*m, ",")
}

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}

func valuesMap(values []string) map[string]string {
	out := make(map[string]string, len(values))
	for _, value := range values {
		key, item, ok := strings.Cut(value, "=")
		if !ok {
			out[value] = ""
			continue
		}
		out[key] = item
	}
	return out
}
