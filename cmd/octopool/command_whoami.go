package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
)

func runWhoami(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("whoami", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	jsonOutput := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("usage: octopool whoami [--json]")
	}
	auth, err := loadAuth()
	if err != nil {
		return err
	}
	if auth.Token == "" {
		return errors.New("not logged in; run: octopool login")
	}
	if *jsonOutput {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(map[string]string{
			"server": auth.URL,
			"pool":   auth.Pool,
			"login":  auth.Login,
			"client": auth.Client,
		})
	}
	fmt.Fprintf(stdout, "server: %s\n", auth.URL)
	fmt.Fprintf(stdout, "pool: %s\n", auth.Pool)
	if auth.Login != "" {
		fmt.Fprintf(stdout, "login: %s\n", auth.Login)
	}
	if auth.Client != "" {
		fmt.Fprintf(stdout, "client: %s\n", auth.Client)
	}
	return nil
}
