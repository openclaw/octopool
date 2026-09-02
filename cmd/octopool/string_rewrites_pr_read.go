package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
)

// These helpers own only modeled PR reads. Native gh's finder distinguishes
// explicit labels from current-branch push/tracking configuration.
func rewritePRReadRepo(policy stringRewritePolicy, raw string) (string, error) {
	if err := policy.checkStructural(raw); err != nil {
		return "", err
	}
	value := strings.TrimPrefix(raw, "github.com/")
	if strings.Contains(value, "://") {
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || u.RawPath != "" {
			return "", errRewriteBlocked
		}
		value = strings.TrimPrefix(u.Path, "/")
	}
	value = strings.TrimSuffix(value, ".git")
	flags := rewriteFlags{values: map[string]string{"--repo": value}}
	// A pin must remain identical under the next boundary's normalization.
	if strings.HasSuffix(value, ".git") || !rewriteRepoPattern.MatchString(value) || rewriteRepo(&flags, policy) != nil {
		return "", errRewriteBlocked
	}
	for _, repo := range []string{value, flags.values["--repo"]} {
		for _, material := range append(strings.Split(repo, "/"), repo, "github.com/"+repo, "https://github.com/"+repo, "--repo=https://github.com/"+repo) {
			if err := policy.checkStructural(material); err != nil {
				return "", err
			}
		}
	}
	// Base repositories compare case-insensitively, but native head labels do not.
	return value, nil
}

func rewritePRReadBranch(policy stringRewritePolicy, selector string) (string, error) {
	if err := policy.checkStructural(selector); err != nil {
		return "", err
	}
	branch := selector
	if owner, ref, qualified := strings.Cut(selector, ":"); qualified {
		if !rewriteGitHubLogin.MatchString(owner) || policy.checkStructural(owner) != nil {
			return "", errRewriteBlocked
		}
		branch = ref
	}
	// Unlike ready, a qualified numeric branch is unambiguous to the finder.
	if !rewriteRefPattern.MatchString(branch) || strings.ContainsAny(branch, ":\\?#") || strings.HasPrefix(branch, "github.com/") || strings.Contains(branch, "/pull/") {
		return "", errRewriteBlocked
	}
	for _, part := range append(strings.Split(branch, "/"), branch) {
		if err := policy.checkStructural(part); err != nil {
			return "", err
		}
	}
	if _, err := rewritePRReadGit("check-ref-format", "--branch", branch); err != nil {
		return "", errRewriteBlocked
	}
	return branch, nil
}

// Modeled reads give native gh empty, pipe-backed stdin, so CanPrompt is false
// even with GH_FORCE_TTY. Repository discovery must stay local to that boundary.
func rewritePRReadBaseRepo(policy stringRewritePolicy, raw string) (string, error) {
	if raw != "" {
		return rewritePRReadRepo(policy, raw)
	}
	if raw = os.Getenv("GH_REPO"); raw != "" {
		return rewritePRReadRepo(policy, raw)
	}
	names, err := rewritePRReadGit("remote")
	if err != nil {
		return "", errRewriteBlocked
	}
	base := ""
	remoteNames := strings.Fields(names)
	for _, name := range remoteNames {
		if !rewriteGitHubLogin.MatchString(name) || policy.checkStructural(name) != nil {
			return "", errRewriteBlocked
		}
		resolved, err := rewritePRReadConfig(policy, "remote."+name+".gh-resolved")
		if err != nil {
			return "", err
		}
		if resolved == "" {
			continue
		}
		// Keep the existing single-configured-default boundary.
		if base != "" {
			return "", errRewriteBlocked
		}
		repo, err := rewritePRReadRemote(policy, name)
		if err != nil {
			return "", err
		}
		if resolved != "base" {
			repo, err = rewritePRReadRepo(policy, resolved)
			if err != nil {
				return "", err
			}
		}
		base = repo
	}
	if base != "" {
		return base, nil
	}
	// Native orders upstream, github, origin, then other names, case-insensitively.
	// Its tie order is not guaranteed. Require a unique winner, and check every
	// candidate instead of guessing how SSH aliases or foreign hosts are filtered.
	priorities := map[string]int{"upstream": 3, "github": 2, "origin": 1}
	priority := -1
	ambiguous := false
	for _, name := range remoteNames {
		repo, err := rewritePRReadRemote(policy, name)
		if err != nil {
			return "", err
		}
		score := priorities[strings.ToLower(name)]
		switch {
		case score > priority:
			base, priority, ambiguous = repo, score, false
		case score == priority:
			ambiguous = true
		}
	}
	if base == "" || ambiguous {
		return "", errRewriteBlocked
	}
	return base, nil
}

func rewritePRReadRemote(policy stringRewritePolicy, remote string) (string, error) {
	if err := policy.checkStructural(remote); err != nil {
		return "", err
	}
	if strings.Contains(remote, ":") {
		return rewritePRReadRepo(policy, remote)
	}
	if !rewriteGitHubLogin.MatchString(remote) {
		return "", errRewriteBlocked
	}
	original, err := rewritePRReadConfig(policy, "remote."+remote+".url")
	if err != nil {
		return "", err
	}
	if _, err := rewritePRReadRepo(policy, original); err != nil {
		return "", err
	}
	// get-url applies insteadOf just as native remote -v does. Multiple URLs and
	// SSH host aliases are deliberately outside this local resolution boundary.
	raw, err := rewritePRReadGit("remote", "get-url", "--all", remote)
	if err != nil {
		return "", errRewriteBlocked
	}
	return rewritePRReadRepo(policy, strings.TrimSuffix(raw, "\n"))
}

func rewritePRReadCurrent(policy stringRewritePolicy, repo string) (string, error) {
	raw, err := rewritePRReadGit("symbolic-ref", "--quiet", "HEAD")
	if err != nil {
		return "", errRewriteBlocked
	}
	raw = strings.TrimSuffix(raw, "\n")
	branch, ok := strings.CutPrefix(raw, "refs/heads/")
	if !ok || policy.checkStructural(raw) != nil {
		return "", errRewriteBlocked
	}
	if _, err := rewritePRReadBranch(policy, branch); err != nil {
		return "", err
	}
	merge, err := rewritePRReadConfig(policy, "branch."+branch+".merge")
	if err != nil {
		return "", err
	}
	if number, ok := strings.CutPrefix(merge, "refs/pull/"); ok && strings.HasSuffix(number, "/head") {
		number = strings.TrimSuffix(number, "/head")
		if n, err := strconv.Atoi(number); err == nil && n > 0 && isDigits(number) {
			if err := policy.checkStructural(number); err != nil {
				return "", err
			}
			canonical := strconv.Itoa(n)
			return canonical, policy.checkStructural(canonical)
		}
		return "", errRewriteBlocked
	}
	remote, ref := "", branch
	push, pushErr := rewritePRReadGit("rev-parse", "--symbolic-full-name", branch+"@{push}")
	var exitErr *exec.ExitError
	if pushErr != nil && !errors.As(pushErr, &exitErr) {
		return "", errRewriteBlocked
	}
	if pushErr == nil && strings.HasPrefix(push, "refs/remotes/") {
		if err := policy.checkStructural(strings.TrimSuffix(push, "\n")); err != nil {
			return "", err
		}
		remote, ref, ok = strings.Cut(strings.TrimPrefix(strings.TrimSuffix(push, "\n"), "refs/remotes/"), "/")
		if !ok {
			return "", errRewriteBlocked
		}
	} else {
		pushDefault, err := rewritePRReadConfig(policy, "push.default")
		if err != nil || !slices.Contains([]string{"", "nothing", "current", "upstream", "tracking", "simple", "matching"}, pushDefault) {
			return "", errRewriteBlocked
		}
		if (pushDefault == "upstream" || pushDefault == "tracking") && merge != "" {
			ref = strings.TrimPrefix(merge, "refs/heads/")
		}
		for _, key := range []string{"branch." + branch + ".pushRemote", "remote.pushDefault", "branch." + branch + ".remote"} {
			remote, err = rewritePRReadConfig(policy, key)
			if err != nil {
				return "", err
			}
			if remote != "" {
				// Unlike branch remotes, native remote.pushDefault is a name, not a URL.
				if key == "remote.pushDefault" && !rewriteGitHubLogin.MatchString(remote) {
					return "", errRewriteBlocked
				}
				break
			}
		}
	}
	selector := ref
	if remote != "" {
		headRepo, err := rewritePRReadRemote(policy, remote)
		if err != nil {
			return "", err
		}
		if !strings.EqualFold(repo, headRepo) {
			selector = strings.SplitN(headRepo, "/", 2)[0] + ":" + ref
		}
	}
	// An explicit plain number would change a branch lookup into a PR-number
	// lookup. Adding an owner would also change native's head-label matching.
	if isDigits(selector) {
		return "", errRewriteBlocked
	}
	_, err = rewritePRReadBranch(policy, selector)
	return selector, err
}

func guardPRReadQuery(policy stringRewritePolicy, repo, selector string) error {
	branch, err := rewritePRReadBranch(policy, selector)
	if err != nil {
		return err
	}
	parts := strings.SplitN(repo, "/", 2)
	// The native finder sends the unqualified headRefName as a GraphQL variable,
	// then matches the full label locally. Never model this as pulls/<branch>.
	variables := map[string]any{"owner": parts[0], "repo": parts[1], "headRefName": branch}
	request := ghAPIRequest{method: "POST", path: "/graphql", query: variables}
	if err := policy.guardRequest(request); err != nil {
		return err
	}
	variables["states"] = nil
	encoded, err := json.Marshal(variables)
	if err != nil || policy.checkStructural(string(encoded)) != nil || policy.checkStructural("https://api.github.com/graphql") != nil {
		return errRewriteBlocked
	}
	return nil
}

func rewritePRReadConfig(policy stringRewritePolicy, key string) (string, error) {
	out, err := rewritePRReadGit("config", "--get-all", key)
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return "", nil
	}
	value := strings.TrimSuffix(out, "\n")
	if err != nil || policy.checkStructural(value) != nil {
		return "", errRewriteBlocked
	}
	return value, nil
}

type prReadGitOutput struct{ data bytes.Buffer }

func (out *prReadGitOutput) Write(data []byte) (int, error) {
	if out.data.Len()+len(data) > rewriteMaxContent {
		return 0, errRewriteBlocked
	}
	return out.data.Write(data)
}

func rewritePRReadGit(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	var out prReadGitOutput
	cmd.Stdout = &out
	err := cmd.Run()
	return out.data.String(), err
}
