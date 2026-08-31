package main

import (
	"encoding/json"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

// Unmodeled native gh commands still receive bounded best-effort filtering.
// Modeled content, API, and lifecycle paths keep their stricter structural
// snapshots; this fallback rewrites visible argv, --input files, and declared stdin.
func prepareRewriteBestEffort(policy stringRewritePolicy, args []string, stdin io.Reader, prepared *rewritePreparation) error {
	if len(args) == 0 {
		return errRewriteBlocked
	}
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return err
	}
	prepared.args, err = pinBestEffortRepositories(policy, args)
	if err != nil {
		return err
	}
	prepared.args, err = pinBestEffortPositionalRepositories(policy, prepared.args)
	if err != nil {
		return err
	}
	captures := map[string]*bestEffortCapturedInput{}
	var stdinConsumed bool
	prepared.args, stdinConsumed, err = snapshotBestEffortSources(policy, prepared.args, stdin, prepared, captures, false)
	if err != nil {
		return err
	}
	prepared.args, err = rewriteBestEffortArguments(policy, prepared.args, prepared)
	if err != nil {
		return err
	}
	// Validate final host/header/repository declarations before reading any new
	// source, including declarations introduced by a visible argument rewrite.
	final, err := describeBestEffortInput(prepared.args)
	if err != nil {
		return err
	}
	prepared.args, err = pinBestEffortRepositories(policy, prepared.args)
	if err != nil {
		return err
	}
	prepared.args, err = pinBestEffortPositionalRepositories(policy, prepared.args)
	if err != nil {
		return err
	}
	prepared.args, stdinConsumed, err = snapshotBestEffortSources(policy, prepared.args, stdin, prepared, captures, stdinConsumed)
	if err != nil {
		return err
	}
	prepared.args, err = finishBestEffortSources(policy, prepared.args, prepared, captures)
	if err != nil {
		return err
	}
	prepared.forceGitHubHost = true
	if declaration.command == "api" || final.command == "api" {
		final, err = describeBestEffortInput(prepared.args)
		if err != nil {
			return err
		}
		hasHost := false
		for _, token := range final.args {
			hasHost = hasHost || token.name == "--hostname"
		}
		if !hasHost {
			if err := policy.checkStructural("github.com"); err != nil {
				return err
			}
			prepared.args = insertBestEffortFlag(prepared.args, final, "--hostname=github.com")
		}
	}
	if stdinConsumed {
		if final.workflowJSON {
			return errRewriteBlocked
		}
		prepared.stdin = strings.NewReader("")
		return nil
	}
	if stdin == nil || rewriteReaderIsTerminal(stdin) || !final.workflowJSON {
		prepared.stdin = stdin
		return nil
	}
	data, err := readBestEffortSource("-", stdin, prepared)
	if err != nil {
		return err
	}
	rewritten, err := rewriteBestEffortData(policy, data, prepared, bestEffortDeclaredJSON)
	if err != nil {
		return err
	}
	prepared.stdin = strings.NewReader(string(rewritten))
	return nil
}

func rewriteBestEffortArguments(policy stringRewritePolicy, args []string, prepared *rewritePreparation) ([]string, error) {
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return nil, err
	}
	args = declaration.argv
	out := make([]string, 0, len(args))
	for _, token := range declaration.args {
		if token.name == "--repo" || token.name == "--input" || (token.name == "--field" && bestEffortFieldIsSource(token.value)) {
			out = append(out, args[token.start:token.end]...)
			continue
		}
		for _, arg := range args[token.start:token.end] {
			rewritten, err := prepared.text(policy, arg)
			if err != nil {
				return nil, err
			}
			out = append(out, rewritten)
		}
	}
	return out, nil
}

func bestEffortFieldIsSource(field string) bool {
	_, value, ok := strings.Cut(field, "=")
	return ok && strings.HasPrefix(value, "@")
}

func snapshotBestEffortSources(policy stringRewritePolicy, args []string, stdin io.Reader, prepared *rewritePreparation, captures map[string]*bestEffortCapturedInput, stdinConsumed bool) ([]string, bool, error) {
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return nil, false, err
	}
	args = declaration.argv
	out := make([]string, 0, len(args))
	for _, token := range declaration.args {
		source, key, kind := token.value, "", declaration.inputKind
		field := token.name == "--field" && bestEffortFieldIsSource(token.value)
		if token.name != "--input" && !field {
			out = append(out, args[token.start:token.end]...)
			continue
		}
		if field {
			key, source, _ = strings.Cut(token.value, "=")
			source, kind = strings.TrimPrefix(source, "@"), bestEffortText
			if key == "" {
				return nil, false, errRewriteBlocked
			}
		}
		capture := captures[source]
		path := source
		if capture == nil {
			if source == "" || (source == "-" && stdinConsumed) {
				return nil, false, errRewriteBlocked
			}
			data, err := readBestEffortSource(source, stdin, prepared)
			if err != nil {
				return nil, false, err
			}
			path, err = prepared.snapshot(nil)
			if err != nil {
				return nil, false, err
			}
			captures[path] = &bestEffortCapturedInput{data: data, kind: kind}
			stdinConsumed = stdinConsumed || source == "-"
			if field {
				key, err = prepared.text(policy, key)
				if err != nil || key == "" {
					return nil, false, errRewriteBlocked
				}
			}
		} else if kind == bestEffortDeclaredJSON {
			capture.kind = bestEffortDeclaredJSON
		}
		if field {
			out = append(out, token.capturedField(key+"=@"+path))
		} else {
			out = append(out, "--input="+path)
		}
	}
	return out, stdinConsumed, nil
}

func finishBestEffortSources(policy stringRewritePolicy, args []string, prepared *rewritePreparation, captures map[string]*bestEffortCapturedInput) ([]string, error) {
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return nil, err
	}
	args = declaration.argv
	out := append([]string(nil), args...)
	for _, token := range declaration.args {
		source, key := token.value, ""
		if token.name == "--field" {
			key, source, _ = strings.Cut(source, "=")
			source = strings.TrimPrefix(source, "@")
		} else if token.name != "--input" {
			continue
		}
		capture := captures[source]
		if capture == nil {
			continue
		}
		data, err := rewriteBestEffortData(policy, capture.data, prepared, capture.kind)
		if err != nil {
			return nil, err
		}
		path, err := prepared.snapshot(data)
		if err != nil {
			return nil, err
		}
		if token.name == "--field" {
			out[token.start] = token.capturedField(key + "=@" + path)
		} else {
			out[token.start] = "--input=" + path
		}
	}
	return out, nil
}

func readBestEffortSource(source string, stdin io.Reader, prepared *rewritePreparation) ([]byte, error) {
	remaining := rewriteMaxContent - prepared.bestEffortSources
	if remaining < 0 {
		return nil, errRewriteBlocked
	}
	data, err := readRewriteFile(source, stdin, remaining)
	if err != nil {
		return nil, err
	}
	prepared.bestEffortSources += len(data)
	if prepared.bestEffortSources > rewriteMaxContent {
		return nil, errRewriteBlocked
	}
	return data, nil
}

func rewriteBestEffortData(policy stringRewritePolicy, data []byte, prepared *rewritePreparation, kind bestEffortInputKind) ([]byte, error) {
	if len(data) == 0 {
		return data, nil
	}
	if policy.containsRuleMaterial(string(data)) {
		return nil, errRewriteBlocked
	}
	if kind == bestEffortText {
		text, err := prepared.text(policy, string(data))
		return []byte(text), err
	}
	value, parseErr := strictRewriteJSON(data, rewriteMaxContent)
	if kind == bestEffortDeclaredJSON && parseErr != nil {
		return nil, errRewriteBlocked
	}
	if parseErr == nil {
		rewritten, err := rewriteBestEffortJSON(policy, value, prepared)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(rewritten)
		if err != nil || len(encoded) > rewriteMaxContent || policy.containsRuleMaterial(string(encoded)) {
			return nil, errRewriteBlocked
		}
		return encoded, nil
	}
	text, err := prepared.text(policy, string(data))
	if err != nil {
		return nil, err
	}
	return []byte(text), nil
}

func rewriteBestEffortJSON(policy stringRewritePolicy, value any, prepared *rewritePreparation) (any, error) {
	switch value := value.(type) {
	case string:
		return prepared.text(policy, value)
	case []any:
		out := make([]any, len(value))
		for index, item := range value {
			rewritten, err := rewriteBestEffortJSON(policy, item, prepared)
			if err != nil {
				return nil, err
			}
			out[index] = rewritten
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, item := range value {
			rewrittenKey, err := prepared.text(policy, key)
			if err != nil || rewrittenKey == "" {
				return nil, errRewriteBlocked
			}
			if _, exists := out[rewrittenKey]; exists {
				return nil, errRewriteBlocked
			}
			rewritten, err := rewriteBestEffortJSON(policy, item, prepared)
			if err != nil {
				return nil, err
			}
			out[rewrittenKey] = rewritten
		}
		return out, nil
	default:
		return value, nil
	}
}

func rewriteReaderIsTerminal(reader io.Reader) bool {
	file, ok := reader.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func pinBestEffortRepositories(policy stringRewritePolicy, args []string) ([]string, error) {
	declaration, err := describeBestEffortInput(args)
	if err != nil {
		return nil, err
	}
	args = declaration.argv
	out := append([]string(nil), args...)
	hasRepo := false
	for _, token := range declaration.args {
		if token.name != "--repo" {
			continue
		}
		hasRepo = true
		repo, err := normalizeBestEffortRepo(policy, token.value)
		if err != nil {
			return nil, err
		}
		value := bestEffortRepoFlagValue(repo, declaration.command == "search")
		if token.end-token.start == 2 {
			out[token.start+1] = value
		} else if token.booleanPrefix != "" {
			out[token.start] = token.booleanPrefix + "R=" + value
		} else {
			out[token.start] = "--repo=" + value
		}
	}
	if !hasRepo && bestEffortNeedsRepository([]string{declaration.command}) {
		repo, err := currentBestEffortRepo(policy)
		if err != nil {
			return nil, err
		}
		out = insertBestEffortFlag(out, declaration, "--repo="+repo)
	}
	return out, nil
}

func bestEffortRepoFlagValue(pinned string, searchFilter bool) string {
	if searchFilter {
		return strings.TrimPrefix(pinned, "github.com/")
	}
	return pinned
}

func bestEffortNeedsRepository(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "pr", "issue", "run", "workflow", "release", "label":
		return true
	default:
		return false
	}
}

func currentBestEffortRepo(policy stringRewritePolicy) (string, error) {
	out, err := exec.Command("git", "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return "", errRewriteBlocked
	}
	return normalizeBestEffortRepo(policy, strings.TrimSpace(string(out)))
}

func pinBestEffortPositionalRepositories(policy stringRewritePolicy, args []string) ([]string, error) {
	out := append([]string(nil), args...)
	if len(out) < 3 {
		return out, nil
	}
	switch out[0] {
	case "repo":
		if out[1] == "clone" {
			return out, validateBestEffortCloneRepository(policy, out[2:])
		}
		for _, value := range out[2:] {
			candidate, err := validateBestEffortRepoValue(policy, value)
			if candidate && err != nil {
				return nil, err
			}
		}
	case "pr", "issue":
		for _, value := range out[2:] {
			candidate, err := validateBestEffortItemValue(policy, out[0], value)
			if candidate && err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func validateBestEffortCloneRepository(policy stringRewritePolicy, args []string) error {
	// Native gh uses the first positional as the source, even after --.
	help := false
	for index := 0; index < len(args); index++ {
		value := args[index]
		switch {
		case value == "--":
			index++
			if index >= len(args) {
				return errRewriteBlocked
			}
			value = args[index]
		case value == "--upstream-remote-name" || value == "-u":
			index++
			if index >= len(args) {
				return errRewriteBlocked
			}
			continue
		case value == "--no-upstream" || strings.HasPrefix(value, "--no-upstream="):
			continue
		case value == "--help" || value == "-h" || strings.HasPrefix(value, "--help=") || strings.HasPrefix(value, "-h="):
			help = true
			continue
		case strings.HasPrefix(value, "--upstream-remote-name=") || strings.HasPrefix(value, "-u"):
			continue
		case strings.HasPrefix(value, "-"):
			return errRewriteBlocked
		}
		if !strings.ContainsAny(value, "/:") {
			// Bare names resolve under the authenticated user on the pinned host.
			if !rewriteRepoPattern.MatchString("owner/"+value) || strings.Contains(value, "..") {
				return errRewriteBlocked
			}
			return policy.checkStructural("github.com/" + value)
		}
		_, err := normalizeBestEffortRepo(policy, value)
		return err
	}
	if help {
		return nil
	}
	return errRewriteBlocked
}

func validateBestEffortRepoValue(policy stringRewritePolicy, value string) (bool, error) {
	value = strings.TrimSpace(value)
	candidate := rewriteRepoPattern.MatchString(value) || strings.HasPrefix(value, "github.com/") || strings.HasPrefix(value, "git@") || looksBestEffortSCPRepo(value)
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil {
			return true, errRewriteBlocked
		}
		candidate = len(strings.Split(strings.Trim(parsed.Path, "/"), "/")) == 2
	}
	parts := strings.Split(strings.Trim(value, "/"), "/")
	if len(parts) == 3 && strings.Contains(parts[0], ".") {
		candidate = true
	}
	if !candidate {
		return false, nil
	}
	_, err := normalizeBestEffortRepo(policy, value)
	return true, err
}

func looksBestEffortSCPRepo(value string) bool {
	colon := strings.Index(value, ":")
	if colon <= 0 || strings.Contains(value[:colon], "/") {
		return false
	}
	return strings.Count(strings.Trim(value[colon+1:], "/"), "/") == 1
}

func validateBestEffortItemValue(policy stringRewritePolicy, command string, value string) (bool, error) {
	raw := value
	if !strings.Contains(raw, "://") {
		parts := strings.Split(strings.Trim(raw, "/"), "/")
		if len(parts) != 4 || !strings.Contains(parts[0], ".") {
			return false, nil
		}
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false, nil
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	kind := "pull"
	if command == "issue" {
		kind = "issues"
	}
	if len(parts) != 4 || parts[2] != kind || !isDigits(parts[3]) {
		return false, nil
	}
	if parsed.Scheme != "https" || parsed.Hostname() != "github.com" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return true, errRewriteBlocked
	}
	repo := normalizeRepo(parts[0] + "/" + parts[1])
	if !rewriteRepoPattern.MatchString(repo) || strings.Contains(repo, "..") {
		return true, errRewriteBlocked
	}
	if err := policy.checkStructural("github.com/" + repo); err != nil {
		return true, err
	}
	return true, nil
}

func normalizeBestEffortRepo(policy stringRewritePolicy, value string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "github.com/") {
		parts := strings.Split(strings.Trim(value, "/"), "/")
		if len(parts) != 3 {
			return "", errRewriteBlocked
		}
		value = parts[1] + "/" + parts[2]
	}
	repo := normalizeRepo(value)
	if !rewriteRepoPattern.MatchString(repo) || strings.Contains(repo, "..") {
		return "", errRewriteBlocked
	}
	pinned := "github.com/" + repo
	if err := policy.checkStructural(pinned); err != nil {
		return "", err
	}
	return pinned, nil
}

func sensitiveBestEffortHeader(value string) bool {
	name, _, _ := strings.Cut(value, ":")
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "authorization", "proxy-authorization", "x-github-token":
		return true
	default:
		return false
	}
}
