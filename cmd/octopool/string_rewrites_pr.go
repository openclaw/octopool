package main

import (
	"os/exec"
	"regexp"
	"strings"
)

var rewriteCommitSHA = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)
var rewriteGitHubLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)

func prepareRewritePRLifecycle(policy stringRewritePolicy, args []string, prepared *rewritePreparation) error {
	if len(args) < 2 || args[0] != "pr" {
		return errRewriteBlocked
	}
	command := args[0] + " " + args[1]
	values := rewriteFlagNames("--repo,-R")
	booleans := map[string]string{}
	switch command {
	case "pr ready":
		booleans = rewriteFlagNames("--undo")
	case "pr merge":
		values = rewriteFlagNames("--repo,-R --match-head-commit")
		booleans = rewriteFlagNames("--squash")
	default:
		return errRewriteBlocked
	}
	flags, err := parseRewriteFlags(args[2:], values, booleans)
	if err != nil || len(flags.positionals) > 1 {
		return errRewriteBlocked
	}
	if command == "pr ready" && len(flags.positionals) == 0 {
		branch, err := exec.Command("git", "symbolic-ref", "--quiet", "--short", "HEAD").Output()
		selector := strings.TrimSpace(string(branch))
		if err != nil || !validRewriteReadyBranch(selector) {
			return errRewriteBlocked
		}
		flags.positionals = []string{selector}
	}
	if len(flags.positionals) != 1 {
		return errRewriteBlocked
	}
	selector := flags.positionals[0]
	if command == "pr merge" {
		if !isDigits(selector) {
			return errRewriteBlocked
		}
	} else if !isDigits(selector) && !validRewriteReadyBranch(selector) {
		return errRewriteBlocked
	}
	if err := rewriteRepo(&flags, policy); err != nil {
		return err
	}
	if err := policy.checkStructural(flags.positionals[0]); err != nil {
		return err
	}
	if command == "pr merge" {
		sha := flags.values["--match-head-commit"]
		if flags.values["--squash"] != "true" || !rewriteCommitSHA.MatchString(sha) {
			return errRewriteBlocked
		}
		if err := policy.checkStructural(sha); err != nil {
			return err
		}
		// Native gh can reinterpret a merge as auto-merge on merge-queue branches.
		// Use GitHub's immediate merge endpoint so the checked head SHA remains the
		// commit being merged; queue-required branches fail instead of weakening it.
		endpoint := "repos/" + flags.values["--repo"] + "/pulls/" + selector + "/merge"
		return prepareRewriteAPI(policy, []string{
			"api", endpoint, "--method=PUT", "--raw-field=sha=" + sha,
			"--raw-field=merge_method=squash", "--silent",
		}, strings.NewReader(""), prepared)
	}
	prepared.args = []string{"pr", args[1], flags.positionals[0], "--repo=" + flags.values["--repo"]}
	for _, flag := range flags.ordered {
		if flag.name == "--repo" {
			continue
		}
		if flag.boolean {
			if flag.value == "true" {
				prepared.args = append(prepared.args, flag.name)
			}
			continue
		}
		prepared.args = append(prepared.args, flag.name+"="+flag.value)
	}
	prepared.stdin = strings.NewReader("")
	return nil
}

func validRewriteReadyBranch(selector string) bool {
	if selector == "" || isDigits(selector) || !rewriteRefPattern.MatchString(selector) {
		return false
	}
	if strings.ContainsAny(selector, `:\?#`) || strings.Contains(selector, "/pull/") || strings.HasPrefix(selector, "github.com/") {
		return false
	}
	return exec.Command("git", "check-ref-format", "--branch", selector).Run() == nil
}

func validRewriteAssignees(value string) bool {
	values := strings.Split(value, ",")
	if len(values) == 0 {
		return false
	}
	for _, login := range values {
		if !rewriteGitHubLogin.MatchString(login) {
			return false
		}
	}
	return true
}
