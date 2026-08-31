package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

const (
	rewriteMaxAttachments          = 16
	rewriteMaxAttachmentBytes      = int64(100 << 20)
	rewriteMaxImageAttachment      = int64(10 << 20)
	rewriteMaxVideoAttachment      = int64(100 << 20)
	rewriteMaxAttachmentReferences = 64
	rewriteMaxAttachmentCandidates = 256
	rewriteAttachmentKindImage     = "image"
	rewriteAttachmentKindVideo     = "video"
)

var rewriteAttachmentExtensions = map[string]string{
	".gif":  rewriteAttachmentKindImage,
	".jpeg": rewriteAttachmentKindImage,
	".jpg":  rewriteAttachmentKindImage,
	".mov":  rewriteAttachmentKindVideo,
	".mp4":  rewriteAttachmentKindVideo,
	".png":  rewriteAttachmentKindImage,
	".webm": rewriteAttachmentKindVideo,
	".webp": rewriteAttachmentKindImage,
}

type rewriteAttachment struct {
	source string
	alt    string
	hasAlt bool
	kind   string
	info   os.FileInfo
}

func extractRewriteAttachments(args []string, valueFlags map[string]string) ([]string, []rewriteAttachment, error) {
	remaining := make([]string, 0, len(args))
	attachments := make([]rewriteAttachment, 0, 4)
	var totalBytes int64
	for index := 0; index < len(args); index++ {
		arg := args[index]
		value := ""
		switch {
		case arg == "--attach":
			index++
			if index >= len(args) {
				return nil, nil, errRewriteBlocked
			}
			value = args[index]
		case strings.HasPrefix(arg, "--attach="):
			value = strings.TrimPrefix(arg, "--attach=")
		default:
			remaining = append(remaining, arg)
			if rewriteFlagConsumesNext(arg, valueFlags) && index+1 < len(args) {
				index++
				remaining = append(remaining, args[index])
			}
			continue
		}
		if value == "" || len(attachments) >= rewriteMaxAttachments {
			return nil, nil, errRewriteBlocked
		}
		attachment, err := newRewriteAttachment(value)
		if err != nil || attachment.info.Size() > rewriteMaxAttachmentBytes-totalBytes {
			return nil, nil, errRewriteBlocked
		}
		for _, seen := range attachments {
			if os.SameFile(seen.info, attachment.info) {
				return nil, nil, errRewriteBlocked
			}
		}
		totalBytes += attachment.info.Size()
		attachments = append(attachments, attachment)
	}
	return remaining, attachments, nil
}

func rewriteFlagConsumesNext(arg string, valueFlags map[string]string) bool {
	name, _, equals := strings.Cut(arg, "=")
	if !strings.HasPrefix(arg, "--") && len(name) > 2 {
		name = arg[:2]
		equals = true
	}
	_, ok := valueFlags[name]
	return ok && !equals
}

func newRewriteAttachment(value string) (rewriteAttachment, error) {
	source, alt, hasAlt := splitRewriteAttachment(value)
	extension := strings.ToLower(filepath.Ext(source))
	kind := rewriteAttachmentExtensions[extension]
	if source == "" || kind == "" || (kind == rewriteAttachmentKindVideo && hasAlt && alt != "") {
		return rewriteAttachment{}, errRewriteBlocked
	}
	// Follow symlinks like native gh. Only the checked alias and a private byte
	// snapshot reach the child; the target path is never exposed.
	info, err := os.Stat(source)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return rewriteAttachment{}, errRewriteBlocked
	}
	limit := rewriteMaxVideoAttachment
	if kind == rewriteAttachmentKindImage {
		limit = rewriteMaxImageAttachment
	}
	if info.Size() > limit {
		return rewriteAttachment{}, errRewriteBlocked
	}
	return rewriteAttachment{source: source, alt: alt, hasAlt: hasAlt, kind: kind, info: info}, nil
}

// GitHub CLI treats the complete value as a path when it exists. Otherwise it
// scans hashes from right to left so filenames containing hashes remain usable.
func splitRewriteAttachment(value string) (string, string, bool) {
	if rewriteAttachmentPathExists(value) {
		return value, "", false
	}
	for end := len(value); end > 0; {
		index := strings.LastIndex(value[:end], "#")
		if index <= 0 {
			break
		}
		if rewriteAttachmentPathExists(value[:index]) {
			return value[:index], value[index+1:], true
		}
		end = index
	}
	if index := strings.LastIndex(value, "#"); index > 0 {
		return value[:index], value[index+1:], true
	}
	return value, "", false
}

func rewriteAttachmentPathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func checkRewriteAttachmentPath(policy stringRewritePolicy, path string) error {
	if strings.ContainsAny(path, "\x00\r\n") {
		return errRewriteBlocked
	}
	return policy.check(path)
}

func rewriteAttachmentDefaultAlt(attachment rewriteAttachment) string {
	name := filepath.Base(attachment.source)
	name = strings.TrimSuffix(name, filepath.Ext(name))
	return strings.ReplaceAll(name, ".", " ")
}

func rewriteAttachmentArgument(attachment rewriteAttachment, snapshot, alt string) string {
	if attachment.kind == rewriteAttachmentKindImage {
		return snapshot + "#" + alt
	}
	return snapshot
}

type rewriteAttachmentSnapshot struct {
	source   string
	snapshot string
}

type rewriteAttachmentEdit struct {
	start       int
	stop        int
	replacement string
}

type rewriteAttachmentRange struct {
	start int
	stop  int
}

type rewriteAttachmentLinkState struct {
	image       bool
	destination string
	title       string
	reference   bool
	depth       int
}

func rewriteBodyAttachmentReferences(body string, snapshots []rewriteAttachmentSnapshot) (string, error) {
	if len(snapshots) == 0 {
		return body, nil
	}
	byPath := make(map[string]string, len(snapshots))
	for _, snapshot := range snapshots {
		path, err := filepath.Abs(snapshot.source)
		if err != nil {
			return "", errRewriteBlocked
		}
		byPath[path] = snapshot.snapshot
	}
	candidateAttempts := 0
	for rewritten := 0; rewritten <= rewriteMaxAttachmentReferences; rewritten++ {
		source := []byte(body)
		nodes, states := rewriteAttachmentLinkStates(source)
		target, snapshot := -1, ""
		for index, state := range states {
			if value, matched := rewriteAttachmentDestinationSnapshot(state.destination, byPath); matched {
				target, snapshot = index, value
				break
			}
		}
		if target < 0 {
			return body, nil
		}
		if states[target].reference || rewritten == rewriteMaxAttachmentReferences {
			return "", errRewriteBlocked
		}
		edit, ok := rewriteValidatedAttachmentEdit(source, nodes[target], states, target, snapshot, &candidateAttempts)
		if !ok {
			return "", errRewriteBlocked
		}
		body = body[:edit.start] + edit.replacement + body[edit.stop:]
	}
	return "", errRewriteBlocked
}

func rewriteAttachmentLinkStates(source []byte) ([]ast.Node, []rewriteAttachmentLinkState) {
	document := goldmark.New().Parser().Parse(text.NewReader(source))
	nodes := []ast.Node{}
	states := []rewriteAttachmentLinkState{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		state := rewriteAttachmentLinkState{}
		switch value := node.(type) {
		case *ast.Image:
			state.image, state.destination, state.title, state.reference = true, string(value.Destination), string(value.Title), value.Reference != nil
		case *ast.Link:
			state.destination, state.title, state.reference = string(value.Destination), string(value.Title), value.Reference != nil
		default:
			return ast.WalkContinue, nil
		}
		for parent := node.Parent(); parent != nil; parent = parent.Parent() {
			state.depth++
		}
		nodes = append(nodes, node)
		states = append(states, state)
		return ast.WalkContinue, nil
	})
	return nodes, states
}

func rewriteValidatedAttachmentEdit(source []byte, node ast.Node, states []rewriteAttachmentLinkState, target int, snapshot string, candidateAttempts *int) (rewriteAttachmentEdit, bool) {
	_, high, ok := rewriteAttachmentBlockRange(node, len(source))
	if !ok {
		return rewriteAttachmentEdit{}, false
	}
	for index := node.Pos(); index+1 < high; index++ {
		if source[index] != ']' || source[index+1] != '(' || rewriteAttachmentEscaped(source, index) {
			continue
		}
		range_ := rewriteAttachmentDestinationRange(source, index+2, high)
		if range_.start >= range_.stop || rewriteAttachmentComparableSource(string(source[range_.start:range_.stop])) != rewriteUnescapeMarkdownPath(states[target].destination) {
			continue
		}
		*candidateAttempts++
		if *candidateAttempts > rewriteMaxAttachmentCandidates {
			return rewriteAttachmentEdit{}, false
		}
		replacement := rewriteAttachmentMarkdownPath(snapshot, source[range_.start:range_.stop])
		expectedDestination := rewriteAttachmentMarkdownDestination(snapshot)
		candidate := string(source[:range_.start]) + replacement + string(source[range_.stop:])
		_, candidateStates := rewriteAttachmentLinkStates([]byte(candidate))
		if rewriteAttachmentStateTransition(states, candidateStates, target, expectedDestination) {
			return rewriteAttachmentEdit{range_.start, range_.stop, replacement}, true
		}
	}
	return rewriteAttachmentEdit{}, false
}

func rewriteAttachmentStateTransition(before, after []rewriteAttachmentLinkState, target int, expectedDestination string) bool {
	if len(before) != len(after) || target < 0 || target >= len(before) {
		return false
	}
	for index := range before {
		if before[index].image != after[index].image || before[index].title != after[index].title || before[index].reference != after[index].reference || before[index].depth != after[index].depth {
			return false
		}
		if index == target {
			if after[index].destination != expectedDestination {
				return false
			}
		} else if before[index].destination != after[index].destination {
			return false
		}
	}
	return true
}

func rewriteAttachmentDestinationSnapshot(destination string, byPath map[string]string) (string, bool) {
	if destination == "" || strings.HasPrefix(destination, "#") || rewriteAttachmentDestinationRemote(destination) {
		return "", false
	}
	for _, candidate := range rewriteAttachmentCandidatePaths(destination) {
		path, err := filepath.Abs(candidate)
		if err == nil {
			if snapshot, ok := byPath[path]; ok {
				return snapshot, true
			}
		}
	}
	return "", false
}

func rewriteAttachmentMarkdownDestination(path string) string {
	return (&url.URL{Path: filepath.ToSlash(path)}).EscapedPath()
}

func rewriteAttachmentMarkdownPath(path string, raw []byte) string {
	encoded := rewriteAttachmentMarkdownDestination(path)
	if len(raw) >= 2 && raw[0] == '<' && raw[len(raw)-1] == '>' {
		return "<" + encoded + ">"
	}
	return encoded
}

func rewriteAttachmentBlockRange(node ast.Node, size int) (int, int, bool) {
	for current := node.Parent(); current != nil; current = current.Parent() {
		if current.Type() != ast.TypeBlock {
			continue
		}
		lines := current.Lines()
		if lines == nil || lines.Len() == 0 {
			return 0, 0, false
		}
		low, high := lines.At(0).Start, lines.At(lines.Len()-1).Stop
		return low, high, low >= 0 && low <= high && high <= size
	}
	return 0, 0, false
}

func rewriteAttachmentDestinationRange(source []byte, index, high int) rewriteAttachmentRange {
	index = rewriteAttachmentSkipSpace(source, index, high)
	if index < high && source[index] == '<' {
		for stop := index + 1; stop < high && source[stop] != '\n'; stop++ {
			if source[stop] == '\\' && stop+1 < high {
				stop++
				continue
			}
			if source[stop] == '>' {
				return rewriteAttachmentRange{index, stop + 1}
			}
		}
		return rewriteAttachmentRange{}
	}
	start, depth := index, 0
	for index < high {
		switch source[index] {
		case '\\':
			if index+1 < high {
				index++
			}
		case ' ', '\t', '\n', '\r':
			if depth == 0 {
				return rewriteAttachmentRange{start, index}
			}
		case '(':
			depth++
		case ')':
			if depth == 0 {
				return rewriteAttachmentRange{start, index}
			}
			depth--
		}
		index++
	}
	return rewriteAttachmentRange{start, index}
}

func rewriteAttachmentComparableSource(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '<' && value[len(value)-1] == '>' {
		value = value[1 : len(value)-1]
	}
	return rewriteUnescapeMarkdownPath(value)
}

func rewriteAttachmentEscaped(source []byte, index int) bool {
	count := 0
	for previous := index - 1; previous >= 0 && source[previous] == '\\'; previous-- {
		count++
	}
	return count%2 == 1
}

func rewriteAttachmentSkipSpace(source []byte, index, high int) int {
	for index < high && (source[index] == ' ' || source[index] == '\t' || source[index] == '\n' || source[index] == '\r') {
		index++
	}
	return index
}

func rewriteAttachmentDestinationRemote(destination string) bool {
	parsed, err := url.Parse(destination)
	if err != nil {
		return false
	}
	return len(parsed.Scheme) > 1 || parsed.Host != ""
}

func rewriteAttachmentCandidatePaths(destination string) []string {
	paths := []string{destination}
	if unescaped := rewriteUnescapeMarkdownPath(destination); unescaped != destination {
		paths = append(paths, unescaped)
	}
	for _, path := range append([]string(nil), paths...) {
		if decoded, err := url.PathUnescape(path); err == nil && decoded != path {
			paths = append(paths, decoded)
		}
	}
	return paths
}

func rewriteUnescapeMarkdownPath(path string) string {
	if !strings.Contains(path, `\`) {
		return path
	}
	const punctuation = `!"#$%&'()*+,-./:;<=>?@[\]^_` + "`" + `{|}~`
	var out strings.Builder
	out.Grow(len(path))
	for index := 0; index < len(path); index++ {
		if path[index] == '\\' && index+1 < len(path) && strings.IndexByte(punctuation, path[index+1]) >= 0 {
			index++
		}
		out.WriteByte(path[index])
	}
	return out.String()
}

func (prepared *rewritePreparation) snapshotAttachment(attachment rewriteAttachment, remaining int64) (string, int64, error) {
	if remaining < 0 {
		return "", 0, errRewriteBlocked
	}
	input, err := openRewriteAttachment(attachment.source)
	if err != nil {
		return "", 0, errRewriteBlocked
	}
	defer input.Close()
	info, err := input.Stat()
	limit := rewriteMaxVideoAttachment
	if attachment.kind == rewriteAttachmentKindImage {
		limit = rewriteMaxImageAttachment
	}
	if remaining < limit {
		limit = remaining
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > limit || !os.SameFile(attachment.info, info) {
		return "", 0, errRewriteBlocked
	}
	if err := prepared.ensureSnapshotDirectory(); err != nil {
		return "", 0, err
	}
	extension := strings.ToLower(filepath.Ext(attachment.source))
	output, err := os.CreateTemp(prepared.directory, "attachment-*"+extension)
	if err != nil {
		return "", 0, errRewriteBlocked
	}
	path := output.Name()
	copied, copyErr := copyRewriteSnapshot(prepared.context(), output, input, info.Size(), limit)
	if copyErr != nil {
		return "", 0, errRewriteBlocked
	}
	return prepared.registerSnapshot(path), copied, nil
}
