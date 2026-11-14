package main

import (
	"debug/buildinfo"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func resolveGHPath(configured string) (string, error) {
	self, _ := os.Executable()
	return resolveGHPathFrom(configured, self, ghPathCandidates(os.Getenv("PATH"), defaultGHCandidates()))
}

func defaultGHCandidates() []string {
	return []string{
		"/opt/homebrew/opt/gh/bin/gh",
		"/opt/homebrew/bin/gh",
		"/usr/local/bin/gh",
		"/usr/bin/gh",
	}
}

func ghPathCandidates(pathEnv string, fallback []string) []string {
	return ghPathCandidatesFor(pathEnv, fallback, runtime.GOOS, os.Getenv("PATHEXT"))
}

func ghPathCandidatesFor(pathEnv string, fallback []string, goos string, pathExt string) []string {
	seen := map[string]struct{}{}
	candidates := []string{}
	add := func(path string) {
		if path == "" {
			return
		}
		if _, ok := seen[path]; ok {
			return
		}
		seen[path] = struct{}{}
		candidates = append(candidates, path)
	}
	names := ghExecutableNames(goos, pathExt)
	for _, dir := range filepath.SplitList(pathEnv) {
		if !filepath.IsAbs(dir) {
			continue
		}
		for _, name := range names {
			add(filepath.Join(dir, name))
		}
	}
	for _, path := range fallback {
		add(path)
	}
	return candidates
}

func ghExecutableNames(goos string, pathExt string) []string {
	if goos != "windows" {
		return []string{"gh"}
	}
	names := []string{"gh"}
	extensions := strings.FieldsFunc(pathExt, func(r rune) bool {
		return r == ';' || r == ':'
	})
	if len(extensions) == 0 || strings.TrimSpace(pathExt) == "" {
		extensions = []string{".COM", ".EXE", ".BAT", ".CMD"}
	}
	for _, extension := range extensions {
		extension = strings.TrimSpace(extension)
		if extension == "" {
			continue
		}
		if !strings.HasPrefix(extension, ".") {
			extension = "." + extension
		}
		names = append(names, "gh"+strings.ToLower(extension))
	}
	return names
}

func resolveGHPathFrom(configured string, self string, candidates []string) (string, error) {
	if configured != "" && configured != "gh" {
		resolved, err := resolveConfiguredGHPath(configured)
		if err == nil && usableGHPath(resolved, self) {
			return resolved, nil
		}
		return "", fmt.Errorf("OCTOPOOL_GH_PATH does not point to the real GitHub CLI: %s", configured)
	}
	for _, candidate := range candidates {
		if usableGHPath(candidate, self) {
			return candidate, nil
		}
	}
	return "", errors.New("real gh not found; set OCTOPOOL_GH_PATH or install GitHub CLI")
}

func resolveConfiguredGHPath(configured string) (string, error) {
	if filepath.IsAbs(configured) {
		return configured, nil
	}
	for i := 0; i < len(configured); i++ {
		if os.IsPathSeparator(configured[i]) {
			return filepath.Abs(configured)
		}
	}
	return exec.LookPath(configured)
}

func usableGHPath(path string, self string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	if samePath(path, self) {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return false
	}
	return !ghShimPath(path)
}

func ghShimPath(path string) bool {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		base := strings.TrimSuffix(strings.ToLower(filepath.Base(resolved)), strings.ToLower(filepath.Ext(resolved)))
		switch base {
		case "octopool", "octopool-gh", "gitcrawl", "gitcrawl-gh":
			return true
		}
	}
	if info, err := buildinfo.ReadFile(path); err == nil {
		switch info.Path {
		case "github.com/openclaw/octopool/cmd/octopool", "github.com/openclaw/gitcrawl/cmd/gitcrawl":
			return true
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	// Read one byte past the script limit to reject oversized candidates
	// without loading an entire executable into memory.
	data, err := io.ReadAll(io.LimitReader(file, 8193))
	if err != nil || len(data) == 0 || len(data) > 8192 {
		return false
	}
	body := string(data)
	return strings.Contains(body, "octopool gh") || strings.Contains(body, "gitcrawl gh moved")
}

func samePath(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return left == right
	}
	leftInfo, leftStat := os.Stat(leftAbs)
	rightInfo, rightStat := os.Stat(rightAbs)
	if leftStat == nil && rightStat == nil {
		return os.SameFile(leftInfo, rightInfo)
	}
	return leftAbs == rightAbs
}
