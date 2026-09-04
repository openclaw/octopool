package main

import (
	"context"
	"io"
	"os"
	"regexp"
	"strings"
)

type rewriteFlag struct {
	name    string
	value   string
	boolean bool
}
type rewriteFlags struct {
	values      map[string]string
	positionals []string
	ordered     []rewriteFlag
}

// Parse only a command-specific vocabulary. Short value flags support -tVALUE
// and -t=VALUE; boolean clusters and repeated/conflicting aliases are refused.
func parseRewriteFlags(args []string, values, booleans map[string]string) (rewriteFlags, error) {
	out := rewriteFlags{values: map[string]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			out.positionals = append(out.positionals, arg)
			continue
		}
		name, value, equals := strings.Cut(arg, "=")
		if !strings.HasPrefix(arg, "--") && len(name) > 2 {
			name = arg[:2]
			value = strings.TrimPrefix(arg[2:], "=")
			equals = true
		}
		canonical, boolean := booleans[name]
		if boolean {
			if equals && value != "true" && value != "false" {
				return out, errRewriteBlocked
			}
			if !equals {
				value = "true"
			}
		} else {
			var ok bool
			canonical, ok = values[name]
			if !ok {
				return out, errRewriteBlocked
			}
			if !equals {
				i++
				if i >= len(args) {
					return out, errRewriteBlocked
				}
				value = args[i]
			}
		}
		if _, exists := out.values[canonical]; exists {
			return out, errRewriteBlocked
		}
		out.values[canonical] = value
		out.ordered = append(out.ordered, rewriteFlag{canonical, value, boolean})
	}
	return out, nil
}
func rewriteFlagNames(spec string) map[string]string {
	out := map[string]string{}
	for _, entry := range strings.Fields(spec) {
		aliases := strings.Split(entry, ",")
		for _, alias := range aliases {
			out[alias] = aliases[0]
		}
	}
	return out
}
func (flags rewriteFlags) has(name string) bool { _, ok := flags.values[name]; return ok }

type rewritePreparation struct {
	ctx               context.Context
	closeDirectory    func()
	preflight         []string
	args              []string
	stdin             io.Reader
	directory         string
	inputBytes        int
	outputBytes       int
	bestEffortSources int
	forceGitHubHost   bool
	snapshots         map[string]bool
	mergeDiagnostics  *ghMergePreparation
}

func (prepared *rewritePreparation) cleanup() {
	if prepared.closeDirectory != nil {
		prepared.closeDirectory()
		prepared.closeDirectory = nil
	}
	if prepared.directory != "" {
		_ = os.RemoveAll(prepared.directory)
	}
}
func (prepared *rewritePreparation) text(policy stringRewritePolicy, text string) (string, error) {
	prepared.inputBytes += len(text)
	if prepared.inputBytes > rewriteMaxContent {
		return "", errRewriteBlocked
	}
	result, err := policy.rewrite(text)
	if err != nil {
		return "", err
	}
	prepared.outputBytes += len(result)
	if prepared.outputBytes > rewriteMaxContent {
		return "", errRewriteBlocked
	}
	return result, nil
}
func (prepared *rewritePreparation) snapshot(data []byte) (string, error) {
	if len(data) > rewriteMaxContent {
		return "", errRewriteBlocked
	}
	if err := prepared.ensureSnapshotDirectory(); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(prepared.directory, "snapshot-")
	if err != nil {
		return "", errRewriteBlocked
	}
	path := file.Name()
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return "", errRewriteBlocked
	}
	return prepared.registerSnapshot(path), nil
}

var rewriteRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var rewriteRefPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_./:-]*$`)

func rewriteRepo(flags *rewriteFlags, policy stringRewritePolicy) error {
	repo := flags.values["--repo"]
	// Pin explicit GitHub URLs and inferred repository context to owner/repo so
	// the child cannot reinterpret another host or repository after validation.
	if repo != "" {
		repo = normalizeRepo(repo)
	} else {
		var ok bool
		repo, ok = repoFromOptionOrCurrent("")
		if !ok {
			return errRewriteBlocked
		}
	}
	if !rewriteRepoPattern.MatchString(repo) || strings.Contains(repo, "..") {
		return errRewriteBlocked
	}
	if err := policy.checkStructural(repo); err != nil {
		return err
	}
	flags.values["--repo"] = repo
	return nil
}
func rewriteContentCommand(args []string) bool {
	if len(args) < 2 {
		return false
	}
	switch args[0] + " " + args[1] {
	case "pr create", "pr edit", "pr comment", "pr review", "issue create", "issue edit", "issue comment", "release create", "release edit":
		return true
	}
	return false
}

func prepareRewriteContent(policy stringRewritePolicy, args []string, stdin io.Reader, prepared *rewritePreparation) error {
	command := args[0] + " " + args[1]
	valueSpec := "--repo,-R"
	booleanSpec := ""
	switch command {
	case "pr create":
		valueSpec += " --title,-t --body,-b --body-file,-F --head,-H --base,-B --label,-l --assignee,-a"
		booleanSpec = "--draft,-d --no-maintainer-edit --dry-run"
	case "pr edit":
		valueSpec += " --title,-t --body,-b --body-file,-F --add-assignee --remove-assignee --add-label --remove-label"
	case "issue edit":
		valueSpec += " --title,-t --body,-b --body-file,-F --add-label --remove-label --add-assignee --remove-assignee"
	case "issue create":
		valueSpec += " --title,-t --body,-b --body-file,-F --label,-l --assignee,-a"
	case "pr comment", "issue comment":
		valueSpec += " --body,-b --body-file,-F"
		booleanSpec = "--edit-last --create-if-none"
	case "pr review":
		valueSpec += " --body,-b --body-file,-F"
		booleanSpec = "--approve,-a --request-changes,-r --comment,-c"
	case "release create", "release edit":
		valueSpec += " --title,-t --notes,-n --notes-file,-F"
		booleanSpec = "--draft,-d --prerelease,-p --latest"
		if args[1] == "create" {
			booleanSpec += " --verify-tag"
		}
	default:
		return errRewriteBlocked
	}
	commandArgs := args[2:]
	valueFlags := rewriteFlagNames(valueSpec)
	var attachments []rewriteAttachment
	var err error
	if command == "pr create" || command == "pr edit" || command == "pr comment" || command == "issue create" || command == "issue edit" || command == "issue comment" {
		commandArgs, attachments, err = extractRewriteAttachments(commandArgs, valueFlags)
		if err != nil {
			return err
		}
	}
	flags, err := parseRewriteFlags(commandArgs, valueFlags, rewriteFlagNames(booleanSpec))
	if err != nil {
		return err
	}
	if err := rewriteRepo(&flags, policy); err != nil {
		return err
	}
	create := args[1] == "create"
	release := args[0] == "release"
	assetMode := command == "release create" && len(flags.positionals) > 1
	if assetMode && (flags.values["--draft"] != "true" || flags.values["--verify-tag"] != "true") {
		return errRewriteBlocked
	}
	if create && !release {
		if len(flags.positionals) != 0 {
			return errRewriteBlocked
		}
	} else {
		if len(flags.positionals) != 1 && !assetMode {
			return errRewriteBlocked
		}
		selector := flags.positionals[0]
		if release {
			if !rewriteRefPattern.MatchString(selector) {
				return errRewriteBlocked
			}
		} else if !isDigits(selector) {
			return errRewriteBlocked
		}
		if err := policy.checkStructural(selector); err != nil {
			return err
		}
	}
	body, file := "--body", "--body-file"
	if release {
		body, file = "--notes", "--notes-file"
	}
	if flags.has(body) && flags.has(file) {
		return errRewriteBlocked
	}
	hasBody := flags.has(body) || flags.has(file)
	if (command == "pr edit" || command == "issue edit") && len(attachments) > 0 && !hasBody {
		// Without an explicit body, native gh republishes uninspected remote text.
		return errRewriteBlocked
	}
	if create && (!flags.has("--title") || !hasBody) {
		return errRewriteBlocked
	}
	metadataEdit := flags.has("--add-assignee") || flags.has("--remove-assignee") || flags.has("--add-label") || flags.has("--remove-label")
	if args[1] == "edit" && !flags.has("--title") && !hasBody && !metadataEdit {
		return errRewriteBlocked
	}
	for _, name := range []string{"--assignee", "--add-assignee", "--remove-assignee"} {
		if flags.has(name) && !validRewriteAssignees(flags.values[name]) {
			return errRewriteBlocked
		}
	}
	for _, name := range []string{"--label", "--add-label", "--remove-label"} {
		if flags.has(name) && !validRewriteLabels(flags.values[name]) {
			return errRewriteBlocked
		}
	}
	attachmentOnlyComment := (command == "pr comment" || command == "issue comment") && len(attachments) > 0 && flags.values["--edit-last"] != "true"
	if (args[1] == "comment" || args[1] == "review") && !hasBody && !attachmentOnlyComment {
		return errRewriteBlocked
	}
	if command == "pr create" {
		// gh explicitly skips all pushing/forking when --head is present, so a
		// missing head is pinned to the current branch instead of blocking the
		// default invocation shape; an unpushed head fails at GitHub, not by push.
		if !flags.has("--head") {
			head, ok := rewriteCurrentBranch()
			if !ok {
				return errRewriteBlocked
			}
			flags.values["--head"] = head
			flags.ordered = append(flags.ordered, rewriteFlag{name: "--head", value: head})
		}
		if !rewriteRefPattern.MatchString(flags.values["--head"]) {
			return errRewriteBlocked
		}
		if flags.has("--base") && !rewriteRefPattern.MatchString(flags.values["--base"]) {
			return errRewriteBlocked
		}
	}
	if command == "release create" && flags.values["--verify-tag"] != "true" {
		return errRewriteBlocked
	}
	if command == "pr review" {
		count := 0
		for _, key := range []string{"--approve", "--request-changes", "--comment"} {
			if flags.values[key] == "true" {
				count++
			}
		}
		if count != 1 {
			return errRewriteBlocked
		}
	}
	positionals := flags.positionals
	var assets []rewriteReleaseAsset
	if assetMode {
		assets, err = prepared.releaseAssets(policy, positionals[1:], defaultRewriteReleaseLimits)
		if err != nil {
			return err
		}
		positionals = positionals[:1]
	}
	prepared.args = append([]string{args[0], args[1]}, positionals...)
	prepared.args = append(prepared.args, "--repo="+flags.values["--repo"])
	attachmentArgs := make([]string, 0, len(attachments))
	attachmentSnapshots := make([]rewriteAttachmentSnapshot, 0, len(attachments))
	remainingAttachmentBytes := rewriteMaxAttachmentBytes
	for _, attachment := range attachments {
		if err := checkRewriteAttachmentPath(policy, attachment.source); err != nil {
			return err
		}
		alt := attachment.alt
		if attachment.kind == rewriteAttachmentKindImage {
			if !attachment.hasAlt {
				alt = rewriteAttachmentDefaultAlt(attachment)
			}
			alt, err = prepared.text(policy, alt)
			if err != nil {
				return err
			}
			if alt == "" && attachment.hasAlt {
				alt, err = prepared.text(policy, rewriteAttachmentDefaultAlt(attachment))
				if err != nil {
					return err
				}
			}
			if alt == "" {
				alt, err = prepared.text(policy, "attachment")
				if err != nil || alt == "" {
					return errRewriteBlocked
				}
			}
		}
		path, size, err := prepared.snapshotAttachment(attachment, remainingAttachmentBytes)
		if err != nil || policy.check(path) != nil {
			return errRewriteBlocked
		}
		remainingAttachmentBytes -= size
		attachmentArgs = append(attachmentArgs, "--attach="+rewriteAttachmentArgument(attachment, path, alt))
		attachmentSnapshots = append(attachmentSnapshots, rewriteAttachmentSnapshot{source: attachment.source, snapshot: path})
	}
	for _, flag := range flags.ordered {
		if flag.name == "--repo" {
			continue
		}
		switch flag.name {
		case "--title", body, file:
			text := flag.value
			if flag.name == file {
				data, err := readRewriteFile(flag.value, stdin, rewriteMaxContent-prepared.inputBytes)
				if err != nil {
					return err
				}
				text = string(data)
			}
			original := text
			text, err = prepared.text(policy, text)
			if err != nil {
				return err
			}
			if assetMode && text != original {
				return errRewriteBlocked
			}
			if flag.name != "--title" {
				previousLength := len(text)
				text, err = rewriteBodyAttachmentReferences(text, attachmentSnapshots)
				prepared.outputBytes += len(text) - previousLength
				if err != nil || prepared.outputBytes < 0 || prepared.outputBytes > rewriteMaxContent || policy.check(text) != nil || policy.containsRuleMaterial(text) {
					return errRewriteBlocked
				}
			}
			// Empty create fields can re-enable gh's prompts/default generation.
			if create && strings.TrimSpace(text) == "" {
				return errRewriteBlocked
			}
			if flag.name == "--title" {
				prepared.args = append(prepared.args, "--title="+text)
			} else {
				path, err := prepared.snapshot([]byte(text))
				if err != nil {
					return err
				}
				prepared.args = append(prepared.args, file+"="+path)
			}
		default:
			if err := policy.checkStructural(flag.value); err != nil {
				return err
			}
			prepared.args = append(prepared.args, flag.name+"="+flag.value)
		}
	}
	prepared.args = append(prepared.args, attachmentArgs...)
	remaining := defaultRewriteReleaseLimits.total
	for _, asset := range assets {
		path, size, err := prepared.snapshotReleaseAsset(asset, min(remaining, defaultRewriteReleaseLimits.file), copyRewriteSnapshot)
		if err != nil || !validRewriteReleasePath(path) || policy.check(path) != nil {
			return errRewriteBlocked
		}
		remaining -= size
		prepared.args = append(prepared.args, path)
	}
	prepared.stdin = strings.NewReader("")
	return nil
}
