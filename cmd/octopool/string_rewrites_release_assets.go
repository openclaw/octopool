package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf8"
)

const rewriteMaxReleaseBasename = 255

type rewriteReleaseLimits struct {
	count       int
	file, total int64
}

var defaultRewriteReleaseLimits = rewriteReleaseLimits{16, 1 << 30, 4 << 30}

type rewriteReleaseAsset struct {
	source, resolved, name string
	info                   os.FileInfo
	change                 rewriteAssetChange
}

func validRewriteReleaseName(name string) bool {
	if !validRewriteFilesystemComponent(name) || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "-") {
		return false
	}
	// An explicit public-name subset avoids guessing GitHub's filename rewrites.
	for _, c := range []byte(name) {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func validRewriteFilesystemComponent(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > rewriteMaxReleaseBasename || !utf8.ValidString(name) || strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") || strings.ContainsAny(name, "<>:\"/\\|?*") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	base, _, _ := strings.Cut(strings.ToUpper(name), ".")
	base = strings.TrimRight(base, " ")
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
		return false
	}
	if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
		if suffix := []rune(base[3:]); len(suffix) == 1 && strings.ContainsRune("123456789¹²³", suffix[0]) {
			return false
		}
	}
	return true
}

// Release operands have label/glob syntax that ordinary filesystem paths do not.
// Check both original and generated operands before handing them to native gh.
func validRewriteReleasePath(path string) bool {
	return !strings.ContainsAny(path, "#*?[]{}") && validRewriteFilesystemPath(path)
}

// Lexical checks precede operand access, including on Windows where a UNC/device
// path could otherwise contact a server or open a named pipe.
func validRewriteFilesystemPath(path string) bool {
	if path == "" || !utf8.ValidString(path) || strings.HasPrefix(path, `\`) || strings.HasPrefix(path, "//") {
		return false
	}
	if runtime.GOOS == "windows" {
		path = filepath.ToSlash(path)
		if len(path) >= 2 && path[1] == ':' {
			if len(path) < 3 || path[2] != '/' || !((path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z')) {
				return false
			}
			path = path[2:]
		}
	}
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if i == 0 && (part == "" || part == ".") {
			continue
		}
		if !validRewriteFilesystemComponent(part) {
			return false
		}
	}
	return true
}

func (prepared *rewritePreparation) unchangedReleaseText(policy stringRewritePolicy, value string) error {
	result, err := prepared.text(policy, value)
	if err != nil || result != value {
		return errRewriteBlocked
	}
	return nil
}

func (prepared *rewritePreparation) releaseAssets(policy stringRewritePolicy, paths []string, limits rewriteReleaseLimits) ([]rewriteReleaseAsset, error) {
	if len(paths) == 0 || len(paths) > limits.count {
		return nil, errRewriteBlocked
	}
	for _, path := range paths {
		if !validRewriteReleaseName(filepath.Base(path)) || !validRewriteReleasePath(path) || prepared.unchangedReleaseText(policy, path) != nil || prepared.unchangedReleaseText(policy, filepath.Base(path)) != nil {
			return nil, errRewriteBlocked
		}
	}
	assets := make([]rewriteReleaseAsset, 0, len(paths))
	var total int64
	for _, path := range paths {
		if err := prepared.context().Err(); err != nil {
			return nil, err
		}
		resolved, info, change, err := inspectRewriteReleaseAsset(path)
		if err != nil || !validRewriteReleasePath(resolved) || prepared.unchangedReleaseText(policy, resolved) != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limits.file || info.Size() > limits.total-total {
			return nil, errRewriteBlocked
		}
		name := filepath.Base(path)
		for _, seen := range assets {
			if strings.EqualFold(seen.name, name) || os.SameFile(seen.info, info) {
				return nil, errRewriteBlocked
			}
		}
		total += info.Size()
		assets = append(assets, rewriteReleaseAsset{path, resolved, name, info, change})
	}
	return assets, nil
}

func sameRewriteAssetInfo(a, b os.FileInfo) bool {
	return a != nil && b != nil && os.SameFile(a, b) && a.Mode() == b.Mode() && a.Size() == b.Size() && a.ModTime() == b.ModTime()
}

type rewriteSnapshotCopy func(context.Context, io.WriteCloser, io.Reader, int64, int64) (int64, error)

func (prepared *rewritePreparation) snapshotReleaseAsset(asset rewriteReleaseAsset, limit int64, copySnapshot rewriteSnapshotCopy) (string, int64, error) {
	if err := prepared.context().Err(); err != nil {
		return "", 0, err
	}
	input, closeInput, err := openRewriteReleaseAsset(asset.resolved)
	if err != nil {
		return "", 0, errRewriteBlocked
	}
	defer closeInput()
	info, err := input.Stat()
	change, changeErr := rewriteReleaseChange(input, info)
	if err != nil || changeErr != nil || !sameRewriteAssetInfo(asset.info, info) || change != asset.change {
		return "", 0, errRewriteBlocked
	}
	if err := prepared.ensureSnapshotDirectory(); err != nil {
		return "", 0, err
	}
	directory := filepath.Join(prepared.directory, "assets")
	if err := os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) {
		return "", 0, errRewriteBlocked
	}
	path := filepath.Join(directory, asset.name)
	output, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", 0, errRewriteBlocked
	}
	copied, err := copySnapshot(prepared.context(), output, input, info.Size(), limit)
	if err != nil {
		return "", 0, errRewriteBlocked
	}
	after, err := input.Stat()
	afterChange, changeErr := rewriteReleaseChange(input, after)
	if err != nil || changeErr != nil || !sameRewriteAssetInfo(info, after) || change != afterChange {
		return "", 0, errRewriteBlocked
	}
	// Also check the names, since a valid open descriptor survives path replacement.
	for _, source := range []string{asset.source, asset.resolved} {
		resolved, current, currentChange, err := inspectRewriteReleaseAsset(source)
		if err != nil || resolved != asset.resolved || !sameRewriteAssetInfo(info, current) || currentChange != change {
			return "", 0, errRewriteBlocked
		}
	}
	if err := prepared.context().Err(); err != nil {
		return "", 0, err
	}
	return prepared.registerSnapshot(path), copied, nil
}
