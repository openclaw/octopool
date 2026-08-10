package main

import (
	"context"
	"flag"
	"io"
)

func runHealth(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("health", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	requestFlags := newCallerRequestFlags(fs)
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool health [flags]"); err != nil {
		return err
	} else if handled {
		return nil
	}
	auth, err := requestFlags.applyAuth(fs)
	if err != nil {
		return err
	}
	token, err := requestFlags.authorize(auth)
	if err != nil {
		return err
	}
	return getJSON(ctx, stdout, apiURL(*requestFlags.baseURL, "/v1/pools/"+urlPath(*requestFlags.pool)+"/health"), token)
}
