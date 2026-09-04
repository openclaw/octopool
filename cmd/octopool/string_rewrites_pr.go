package main

import (
	"io"
	"os/exec"
	"regexp"
	"strings"
)

var rewriteCommitSHA = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)
var rewriteGitHubLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)

func prepareRewritePRLifecycle(policy stringRewritePolicy, args []string, stdin io.Reader, prepared *rewritePreparation) error {
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
		values = rewriteFlagNames("--repo,-R --match-head-commit --body-file,-F --subject,-t")
		booleans = rewriteFlagNames("--squash")
	default:
		return errRewriteBlocked
	}
	flags, err := parseRewriteFlags(args[2:], values, booleans)
	if err != nil || len(flags.positionals) > 1 {
		return errRewriteBlocked
	}
	if command == "pr ready" && len(flags.positionals) == 0 {
		selector, ok := rewriteCurrentBranch()
		if !ok {
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
		apiArgs := []string{
			"api", endpoint, "--method=PUT", "--raw-field=sha=" + sha,
			"--raw-field=merge_method=squash", "--silent",
		}
		if flags.has("--subject") {
			// Keep leading @ and typed-looking titles literal; the API owner
			// rewrites and snapshots publication text before child dispatch.
			apiArgs = append(apiArgs, "--raw-field=commit_title="+flags.values["--subject"])
		}
		if flags.has("--body-file") {
			// The API owner reads, rewrites, and snapshots the body before dispatch.
			apiArgs = append(apiArgs, "--field=commit_message=@"+flags.values["--body-file"])
		}
		capture := prepared.mergeDiagnostics != nil && ghMergeIncludeAllowed(policy, args, apiArgs)
		if capture {
			apiArgs = append(apiArgs, ghMergeIncludeFlag)
		}
		// One preparation owns every input read and the sole publication snapshot.
		if err := prepareRewriteAPI(policy, apiArgs, stdin, prepared); err != nil {
			return err
		}
		if diagnostic := prepared.mergeDiagnostics; diagnostic != nil {
			diagnostic.route = ghMergeREST
			if capture && (ghMergeArgBytes(prepared.args) > rewriteMaxContent || prepared.outputBytes+len(ghMergeIncludeFlag) > rewriteMaxContent) {
				// Instrumentation must never reject an otherwise valid merge.
				prepared.args = prepared.args[:len(prepared.args)-1]
				capture = false
			}
			if capture {
				prepared.outputBytes += len(ghMergeIncludeFlag)
			}
			diagnostic.captureHeaders = capture
		}
		return nil
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

// Current checkout branch, validated as a plain branch name. Detached HEAD,
// non-git directories, and unusual ref shapes fail closed.
func rewriteCurrentBranch() (string, bool) {
	branch, err := exec.Command("git", "symbolic-ref", "--quiet", "--short", "HEAD").Output()
	selector := strings.TrimSpace(string(branch))
	if err != nil || !validRewriteReadyBranch(selector) {
		return "", false
	}
	return selector, true
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
		if login != "@me" && login != "@copilot" && !rewriteGitHubLogin.MatchString(login) {
			return false
		}
	}
	return true
}

func validRewriteLabels(value string) bool {
	for _, label := range strings.Split(value, ",") {
		if strings.TrimSpace(label) == "" {
			return false
		}
	}
	return value != ""
}
