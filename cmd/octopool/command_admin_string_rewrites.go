package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
)

var errRewriteConflict = errors.New("string rewrite policy revision conflict; fetch the current revision and retry")

func runAdminStringRewrites(ctx context.Context, args []string, stdout io.Writer) error {
	usage := "usage: octopool admin string-rewrites <status|set --file PATH|-> [--if-revision N] [--url URL]"
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, usage)
		return nil
	}
	if args[0] != "status" && args[0] != "set" {
		return errRewriteBlocked
	}
	fs := flag.NewFlagSet("admin string-rewrites", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	baseURL := fs.String("url", envDefault("OCTOPOOL_URL", defaultURL), "Octopool base URL")
	tokenEnv := fs.String("admin-token-env", "OCTOPOOL_ADMIN_TOKEN", "admin token environment variable")
	file := fs.String("file", "", "policy JSON file or - for stdin")
	expected := fs.Int64("if-revision", 0, "require this current revision")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(stdout, usage)
			return nil
		}
		return errRewriteBlocked
	}
	if fs.NArg() != 0 || *expected < 0 {
		return errRewriteBlocked
	}
	revisionSet := false
	fs.Visit(func(item *flag.Flag) {
		if item.Name == "if-revision" {
			revisionSet = true
		}
	})
	if revisionSet && (*expected < 1 || *expected > 9007199254740991) {
		return errRewriteBlocked
	}
	var imported stringRewritePolicy
	if args[0] == "set" {
		if *file == "" {
			return errRewriteBlocked
		}
		data, err := readRewriteFile(*file, os.Stdin, rewriteMaxDocument)
		if err != nil {
			return errRewritePolicy
		}
		imported, err = parseStringRewritePolicy(data, false)
		if err != nil {
			return err
		}
	} else if *file != "" || *expected != 0 {
		return errRewriteBlocked
	}
	token, err := requiredEnv(*tokenEnv)
	if err != nil {
		return errRewritePolicy
	}
	result, err := rewritePolicyHTTP(ctx, *baseURL, "/v1/admin/string-rewrites", token, http.MethodGet, nil)
	if err != nil {
		return err
	}
	current, err := parseStringRewritePolicy(result.data, true)
	if err != nil {
		return err
	}
	if args[0] == "status" {
		fmt.Fprintf(stdout, "revision: %d\nrule_count: %d\n", current.Revision, len(current.Rules))
		return nil
	}
	if *expected != 0 && *expected != current.Revision {
		return errRewriteConflict
	}
	rules := make([]stringRewriteRule, 0, len(imported.Rules))
	for _, rule := range imported.Rules {
		rules = append(rules, rule.stringRewriteRule)
	}
	body, _ := json.Marshal(map[string]any{"schema_version": 1, "expected_revision": current.Revision, "rules": rules})
	result, err = rewritePolicyHTTP(ctx, *baseURL, "/v1/admin/string-rewrites", token, http.MethodPut, body)
	if err != nil {
		return err
	}
	value, err := strictRewriteJSON(result.data, rewriteMaxDocument)
	if err != nil {
		return err
	}
	object, ok := exactRewriteKeys(value, "schema_version", "revision", "updated_at", "rule_count")
	if !ok {
		return errRewritePolicy
	}
	version, vok := rewriteInteger(object["schema_version"])
	revision, rok := rewriteInteger(object["revision"])
	updated, uok := object["updated_at"].(string)
	count, cok := object["rule_count"].(json.Number)
	parsedCount, cerr := count.Int64()
	if !vok || version != 1 || !rok || revision != current.Revision+1 || !uok || !validRewriteTimestamp(updated) || !cok || cerr != nil || parsedCount != int64(len(rules)) {
		return errRewritePolicy
	}
	fmt.Fprintf(stdout, "revision: %d\nrule_count: %d\n", revision, parsedCount)
	return nil
}
