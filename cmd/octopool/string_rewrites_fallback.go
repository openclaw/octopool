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
	if args[0] == "api" {
		if err := validateBestEffortAPI(args); err != nil {
			return err
		}
	}

	var err error
	prepared.args, err = pinBestEffortRepositories(policy, args)
	if err != nil {
		return err
	}
	prepared.args, err = pinBestEffortPositionalRepositories(policy, prepared.args)
	if err != nil {
		return err
	}
	var stdinConsumed bool
	prepared.args, stdinConsumed, err = snapshotBestEffortSources(policy, prepared.args, stdin, prepared, false)
	if err != nil {
		return err
	}
	prepared.args, err = rewriteBestEffortArguments(policy, prepared.args, prepared)
	if err != nil {
		return err
	}
	prepared.args, stdinConsumed, err = snapshotBestEffortSources(policy, prepared.args, stdin, prepared, stdinConsumed)
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
	prepared.forceGitHubHost = true
	if args[0] == "api" {
		if !bestEffortAPIHasHostname(prepared.args) {
			if err := policy.checkStructural("github.com"); err != nil {
				return err
			}
			prepared.args = append(prepared.args, "--hostname=github.com")
		}
		if err := validateBestEffortAPI(prepared.args); err != nil {
			return err
		}
	}

	if stdinConsumed {
		prepared.stdin = strings.NewReader("")
		return nil
	}
	if stdin == nil || rewriteReaderIsTerminal(stdin) || !bestEffortConsumesStdin(prepared.args) {
		prepared.stdin = stdin
		return nil
	}
	remaining := rewriteMaxContent - prepared.bestEffortSources
	if remaining < 0 {
		return errRewriteBlocked
	}
	data, err := boundedRewriteRead(stdin, remaining)
	if err != nil {
		return err
	}
	prepared.bestEffortSources += len(data)
	if prepared.bestEffortSources > rewriteMaxContent {
		return errRewriteBlocked
	}
	rewritten, err := rewriteBestEffortData(policy, data, prepared)
	if err != nil {
		return err
	}
	prepared.stdin = strings.NewReader(string(rewritten))
	return nil
}

func rewriteBestEffortArguments(policy stringRewritePolicy, args []string, prepared *rewritePreparation) ([]string, error) {
	out := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--repo" || arg == "-R" || arg == "--input" {
			index++
			if index >= len(args) {
				return nil, errRewriteBlocked
			}
			out = append(out, arg, args[index])
			continue
		}
		if strings.HasPrefix(arg, "--repo=") || (strings.HasPrefix(arg, "-R") && len(arg) > 2) || strings.HasPrefix(arg, "--input=") {
			out = append(out, arg)
			continue
		}
		if arg == "--field" || arg == "-F" {
			index++
			if index >= len(args) {
				return nil, errRewriteBlocked
			}
			if bestEffortFieldIsSource(args[index]) {
				out = append(out, arg, args[index])
				continue
			}
			rewrittenFlag, err := prepared.text(policy, arg)
			if err != nil {
				return nil, err
			}
			rewrittenValue, err := prepared.text(policy, args[index])
			if err != nil {
				return nil, err
			}
			out = append(out, rewrittenFlag, rewrittenValue)
			continue
		}
		if field, ok := bestEffortAttachedField(arg); ok && bestEffortFieldIsSource(field) {
			out = append(out, arg)
			continue
		}
		rewritten, err := prepared.text(policy, arg)
		if err != nil {
			return nil, err
		}
		out = append(out, rewritten)
	}
	return out, nil
}

func bestEffortFieldIsSource(field string) bool {
	_, value, ok := strings.Cut(field, "=")
	return ok && strings.HasPrefix(value, "@")
}

func snapshotBestEffortSources(policy stringRewritePolicy, args []string, stdin io.Reader, prepared *rewritePreparation, stdinConsumed bool) ([]string, bool, error) {
	out := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--input" {
			index++
			if index >= len(args) || (args[index] == "-" && stdinConsumed) {
				return nil, false, errRewriteBlocked
			}
			if prepared.snapshots[args[index]] {
				out = append(out, "--input="+args[index])
				continue
			}
			path, err := snapshotBestEffortInput(policy, args[index], stdin, prepared)
			if err != nil {
				return nil, false, err
			}
			stdinConsumed = stdinConsumed || args[index] == "-"
			out = append(out, "--input="+path)
			continue
		}
		if value, ok := strings.CutPrefix(arg, "--input="); ok {
			if value == "-" && stdinConsumed {
				return nil, false, errRewriteBlocked
			}
			if prepared.snapshots[value] {
				out = append(out, arg)
				continue
			}
			path, err := snapshotBestEffortInput(policy, value, stdin, prepared)
			if err != nil {
				return nil, false, err
			}
			stdinConsumed = stdinConsumed || value == "-"
			out = append(out, "--input="+path)
			continue
		}
		if arg == "--field" || arg == "-F" {
			index++
			if index >= len(args) {
				return nil, false, errRewriteBlocked
			}
			rewritten, handled, consumed, err := snapshotBestEffortField(policy, args[index], stdin, prepared, stdinConsumed)
			if err != nil {
				return nil, false, err
			}
			if handled {
				stdinConsumed = stdinConsumed || consumed
				out = append(out, "--field="+rewritten)
			} else {
				out = append(out, arg, args[index])
			}
			continue
		}
		if value, ok := bestEffortAttachedField(arg); ok {
			rewritten, handled, consumed, err := snapshotBestEffortField(policy, value, stdin, prepared, stdinConsumed)
			if err != nil {
				return nil, false, err
			}
			if handled {
				stdinConsumed = stdinConsumed || consumed
				out = append(out, "--field="+rewritten)
				continue
			}
		}
		out = append(out, arg)
	}
	return out, stdinConsumed, nil
}

func snapshotBestEffortInput(policy stringRewritePolicy, source string, stdin io.Reader, prepared *rewritePreparation) (string, error) {
	data, err := readBestEffortSource(source, stdin, prepared)
	if err != nil {
		return "", err
	}
	rewritten, err := rewriteBestEffortData(policy, data, prepared)
	if err != nil {
		return "", err
	}
	return prepared.snapshot(rewritten)
}

func snapshotBestEffortTextInput(policy stringRewritePolicy, source string, stdin io.Reader, prepared *rewritePreparation) (string, error) {
	data, err := readBestEffortSource(source, stdin, prepared)
	if err != nil {
		return "", err
	}
	text, err := prepared.text(policy, string(data))
	if err != nil {
		return "", err
	}
	return prepared.snapshot([]byte(text))
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

func snapshotBestEffortField(policy stringRewritePolicy, field string, stdin io.Reader, prepared *rewritePreparation, stdinConsumed bool) (string, bool, bool, error) {
	key, value, ok := strings.Cut(field, "=")
	if !ok || !strings.HasPrefix(value, "@") {
		return "", false, false, nil
	}
	if key == "" {
		return "", false, false, errRewriteBlocked
	}
	source := strings.TrimPrefix(value, "@")
	if source == "" || (source == "-" && stdinConsumed) {
		return "", false, false, errRewriteBlocked
	}
	rewrittenKey, err := prepared.text(policy, key)
	if err != nil || rewrittenKey == "" {
		return "", false, false, errRewriteBlocked
	}
	if prepared.snapshots[source] {
		return rewrittenKey + "=@" + source, true, false, nil
	}
	path, err := snapshotBestEffortTextInput(policy, source, stdin, prepared)
	if err != nil {
		return "", false, false, err
	}
	return rewrittenKey + "=@" + path, true, source == "-", nil
}

func bestEffortAttachedField(arg string) (string, bool) {
	if value, ok := strings.CutPrefix(arg, "--field="); ok {
		return value, true
	}
	if value, ok := strings.CutPrefix(arg, "-F"); ok && value != "" {
		return strings.TrimPrefix(value, "="), true
	}
	return "", false
}

func bestEffortAPIHasHostname(args []string) bool {
	for _, arg := range args[1:] {
		if arg == "--hostname" || strings.HasPrefix(arg, "--hostname=") {
			return true
		}
	}
	return false
}

func rewriteBestEffortData(policy stringRewritePolicy, data []byte, prepared *rewritePreparation) ([]byte, error) {
	if len(data) == 0 {
		return data, nil
	}
	if policy.containsRuleMaterial(string(data)) {
		return nil, errRewriteBlocked
	}
	if value, err := strictRewriteJSON(data, rewriteMaxContent); err == nil {
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

func bestEffortConsumesStdin(args []string) bool {
	if len(args) < 2 || args[0] != "workflow" || args[1] != "run" {
		return false
	}
	for _, arg := range args[2:] {
		if arg == "--json" || arg == "--json=true" {
			return true
		}
	}
	return false
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
	out := append([]string(nil), args...)
	hasRepo := false
	searchFilter := len(out) >= 2 && out[0] == "search"
	for index := 0; index < len(out); index++ {
		arg := out[index]
		if arg == "--repo" || arg == "-R" {
			hasRepo = true
			index++
			if index >= len(out) {
				return nil, errRewriteBlocked
			}
			repo, err := normalizeBestEffortRepo(policy, out[index])
			if err != nil {
				return nil, err
			}
			out[index] = bestEffortRepoFlagValue(repo, searchFilter)
			continue
		}
		if value, ok := strings.CutPrefix(arg, "--repo="); ok {
			hasRepo = true
			repo, err := normalizeBestEffortRepo(policy, value)
			if err != nil {
				return nil, err
			}
			out[index] = "--repo=" + bestEffortRepoFlagValue(repo, searchFilter)
			continue
		}
		if value, ok := strings.CutPrefix(arg, "-R"); ok && value != "" {
			hasRepo = true
			repo, err := normalizeBestEffortRepo(policy, strings.TrimPrefix(value, "="))
			if err != nil {
				return nil, err
			}
			out[index] = "--repo=" + bestEffortRepoFlagValue(repo, searchFilter)
		}
	}
	if !hasRepo && bestEffortNeedsRepository(out) {
		repo, err := currentBestEffortRepo(policy)
		if err != nil {
			return nil, err
		}
		out = append(out, "--repo="+repo)
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

func validateBestEffortAPI(args []string) error {
	endpoint := ""
	for index := 1; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--hostname":
			index++
			if index >= len(args) || args[index] != "github.com" {
				return errRewriteBlocked
			}
		case strings.HasPrefix(arg, "--hostname="):
			if strings.TrimPrefix(arg, "--hostname=") != "github.com" {
				return errRewriteBlocked
			}
		case arg == "--header" || arg == "-H":
			index++
			if index >= len(args) || sensitiveBestEffortHeader(args[index]) {
				return errRewriteBlocked
			}
		case strings.HasPrefix(arg, "--header="):
			if sensitiveBestEffortHeader(strings.TrimPrefix(arg, "--header=")) {
				return errRewriteBlocked
			}
		case strings.HasPrefix(arg, "-H") && len(arg) > 2:
			if sensitiveBestEffortHeader(strings.TrimPrefix(arg[2:], "=")) {
				return errRewriteBlocked
			}
		case bestEffortAPISeparateValueFlag(arg):
			index++
			if index >= len(args) {
				return errRewriteBlocked
			}
		case bestEffortAPIAttachedValueFlag(arg):
			continue
		case !strings.HasPrefix(arg, "-") && endpoint == "":
			endpoint = arg
		}
	}
	if endpoint == "" || strings.Contains(endpoint, "://") || rewriteEndpointPlaceholder.MatchString(endpoint) {
		return errRewriteBlocked
	}
	return nil
}

func bestEffortAPISeparateValueFlag(arg string) bool {
	switch arg {
	case "--method", "-X", "--input", "--field", "-F", "--raw-field", "-f", "--jq", "-q":
		return true
	default:
		return false
	}
}

func bestEffortAPIAttachedValueFlag(arg string) bool {
	for _, prefix := range []string{"--method=", "--input=", "--field=", "--raw-field=", "--jq=", "-X", "-F", "-f", "-q"} {
		if strings.HasPrefix(arg, prefix) && len(arg) > len(prefix) {
			return true
		}
	}
	return false
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
