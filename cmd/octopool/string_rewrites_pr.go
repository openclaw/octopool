package main

import (
	"io"
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
		booleans = rewriteFlagNames("--squash --auto")
	default:
		return errRewriteBlocked
	}
	flags, err := parseRewriteFlags(args[2:], values, booleans)
	if err != nil || len(flags.positionals) > 1 {
		return errRewriteBlocked
	}
	if command == "pr ready" && len(flags.positionals) == 0 {
		selector, err := rewriteCurrentBranch()
		if err != nil {
			return err
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
		if flags.values["--auto"] == "true" {
			return prepareRewriteAutoMerge(policy, flags, stdin, prepared)
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

func prepareRewriteAutoMerge(policy stringRewritePolicy, flags rewriteFlags, stdin io.Reader, prepared *rewritePreparation) error {
	// Native gh omits an empty headline and an unspecified body, which would let
	// GitHub generate publication text that has not passed the current policy.
	if !flags.has("--subject") || !flags.has("--body-file") || flags.values["--body-file"] == "" {
		return errRewriteBlocked
	}
	subject, err := prepared.text(policy, flags.values["--subject"])
	if err != nil || strings.TrimSpace(subject) == "" {
		return errRewriteBlocked
	}
	body, err := readRewriteFile(flags.values["--body-file"], stdin, rewriteMaxContent-prepared.inputBytes)
	if err != nil {
		return err
	}
	text, err := prepared.text(policy, string(body))
	if err != nil {
		return err
	}
	// The full head is checked at submission. A queued merge remains GitHub's
	// lifecycle; this does not freeze the head or override branch/queue policy.
	args := []string{
		"pr", "merge", flags.positionals[0], "--repo=" + flags.values["--repo"],
		"--squash", "--auto", "--match-head-commit=" + flags.values["--match-head-commit"],
		"--subject=" + subject,
	}
	if ghMergeArgBytes(args)+len("--body-file=")+len(text) > rewriteMaxContent {
		return errRewriteBlocked
	}
	path, err := prepared.snapshot([]byte(text))
	if err != nil {
		return err
	}
	args = append(args, "--body-file="+path)
	if ghMergeArgBytes(args)+len(text) > rewriteMaxContent {
		return errRewriteBlocked
	}
	prepared.args = args
	prepared.stdin = strings.NewReader("")
	if prepared.mergeDiagnostics != nil {
		prepared.mergeDiagnostics.route = ghMergeNative
	}
	return nil
}

// Current checkout branch, validated as a plain branch name. Detached HEAD,
// non-git directories, and unusual ref shapes fail closed.
func rewriteCurrentBranch() (string, error) {
	branch, err := gitProbe("symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	selector := strings.TrimSpace(branch)
	if !validRewriteReadyBranch(selector) {
		return "", errRewriteBlocked
	}
	return selector, nil
}

func validRewriteReadyBranch(selector string) bool {
	if selector == "" || isDigits(selector) || !rewriteRefPattern.MatchString(selector) {
		return false
	}
	if strings.ContainsAny(selector, `:\?#`) || strings.Contains(selector, "/pull/") || strings.HasPrefix(selector, "github.com/") {
		return false
	}
	_, err := gitProbe("check-ref-format", "--branch", selector)
	return err == nil
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
