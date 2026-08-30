package main

import (
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

const (
	rewriteMaxAttachments      = 16
	rewriteMaxAttachmentBytes  = int64(100 << 20)
	rewriteMaxImageAttachment  = int64(10 << 20)
	rewriteMaxVideoAttachment  = int64(100 << 20)
	rewriteAttachmentKindImage = "image"
	rewriteAttachmentKindVideo = "video"
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

func rewriteBodyReferencesAttachment(body string, attachments []rewriteAttachment) bool {
	if len(attachments) == 0 {
		return false
	}
	byPath := make(map[string]bool, len(attachments))
	for _, attachment := range attachments {
		path, err := filepath.Abs(attachment.source)
		if err == nil {
			byPath[path] = true
		}
	}
	document := goldmark.New().Parser().Parse(text.NewReader([]byte(body)))
	found := false
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var destination string
		switch value := node.(type) {
		case *ast.Image:
			destination = string(value.Destination)
		case *ast.Link:
			destination = string(value.Destination)
		default:
			return ast.WalkContinue, nil
		}
		if rewriteAttachmentDestinationMatches(destination, byPath) {
			found = true
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	return found
}

func rewriteAttachmentDestinationMatches(destination string, byPath map[string]bool) bool {
	if destination == "" || strings.HasPrefix(destination, "#") || rewriteAttachmentDestinationRemote(destination) {
		return false
	}
	for _, candidate := range rewriteAttachmentCandidatePaths(destination) {
		path, err := filepath.Abs(candidate)
		if err == nil && byPath[path] {
			return true
		}
	}
	return false
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
	if prepared.directory == "" {
		directory, err := os.MkdirTemp("", "octopool-content-")
		if err != nil {
			return "", 0, errRewriteBlocked
		}
		prepared.directory = directory
	}
	extension := strings.ToLower(filepath.Ext(attachment.source))
	output, err := os.CreateTemp(prepared.directory, "attachment-*"+extension)
	if err != nil {
		return "", 0, errRewriteBlocked
	}
	path := output.Name()
	copied, copyErr := io.CopyN(output, input, limit+1)
	if errors.Is(copyErr, io.EOF) {
		copyErr = nil
	}
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || copied != info.Size() || copied > limit {
		return "", 0, errRewriteBlocked
	}
	path = filepath.Clean(path)
	if prepared.snapshots == nil {
		prepared.snapshots = map[string]bool{}
	}
	prepared.snapshots[path] = true
	return path, copied, nil
}
