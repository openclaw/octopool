package main

import "testing"

func TestTopLevelRepoNumber(t *testing.T) {
	opts := ghTopOptions{repo: "openclaw/openclaw", positionals: []string{"85341"}}
	repo, number, ok := repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{positionals: []string{"https://github.com/openclaw/openclaw/pull/85341"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "openclaw/openclaw" || number != "85341" {
		t.Fatalf("repoNumber URL = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "cli/cli", positionals: []string{"1"}}
	repo, number, ok = repoNumber(opts)
	if !ok || repo != "cli/cli" || number != "1" {
		t.Fatalf("repoNumber outside default owner = %q %q %v", repo, number, ok)
	}

	opts = ghTopOptions{repo: "openclaw", positionals: []string{"1"}}
	if _, _, ok = repoNumber(opts); ok {
		t.Fatal("malformed explicit repo should fall back")
	}
}

func TestParseGHTopOptions(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{
		"-R", "openclaw/openclaw",
		"--json", "number,title,url",
		"--jq", ".number",
		"--limit", "50",
		"--state=open",
		"--label", "bug",
		"85341",
	})
	if err != nil || fallback {
		t.Fatalf("parse fallback=%v err=%v", fallback, err)
	}
	if opts.repo != "openclaw/openclaw" || opts.limit != 50 || opts.state != "open" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.json) != 3 || opts.json[2] != "url" || opts.jq != ".number" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.labels) != 1 || opts.labels[0] != "bug" {
		t.Fatalf("opts = %#v", opts)
	}
	if len(opts.positionals) != 1 || opts.positionals[0] != "85341" {
		t.Fatalf("opts = %#v", opts)
	}
}

func TestParseGHTopOptionsRejectsInvalidLimit(t *testing.T) {
	_, fallback, err := parseGHTopOptions([]string{"--limit", "nope"})
	if err == nil || fallback {
		t.Fatalf("fallback=%v err=%v", fallback, err)
	}
}

func TestParseGHTopOptionsValidatesAttempt(t *testing.T) {
	opts, fallback, err := parseGHTopOptions([]string{"42", "--attempt", "2"})
	if err != nil || fallback || !opts.attemptSet || opts.attempt != 2 {
		t.Fatalf("opts=%#v fallback=%v err=%v", opts, fallback, err)
	}
	for _, value := range []string{"0", "nope"} {
		if _, _, err := parseGHTopOptions([]string{"42", "--attempt", value}); err == nil {
			t.Fatalf("--attempt %s must fail", value)
		}
	}
}
