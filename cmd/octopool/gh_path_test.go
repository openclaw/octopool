package main

import (
	"debug/buildinfo"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestResolveGHPathSkipsOctopoolWrapper(t *testing.T) {
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "gh")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	self := filepath.Join(dir, "octopool")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec octopool gh \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(self, []byte("octopool"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		self,
		ghPathCandidates(dir+string(os.PathListSeparator)+realDir, nil),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(got, realGH) {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsOctopoolSymlink(t *testing.T) {
	dir := t.TempDir()
	wrapperDir := filepath.Join(dir, "wrapper")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(wrapperDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	octopoolBinary := filepath.Join(dir, "octopool")
	if err := os.WriteFile(octopoolBinary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(octopoolBinary, filepath.Join(wrapperDir, "gh")); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		filepath.Join(dir, "current-octopool"),
		ghPathCandidates(wrapperDir+string(os.PathListSeparator)+realDir, nil),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsGitcrawlShim(t *testing.T) {
	dir := t.TempDir()
	shimDir := filepath.Join(dir, "shim")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitcrawlBinary := filepath.Join(dir, "gitcrawl-gh")
	if err := os.WriteFile(gitcrawlBinary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(gitcrawlBinary, filepath.Join(shimDir, "gh")); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveGHPathFrom(
		"gh",
		filepath.Join(dir, "octopool"),
		ghPathCandidates(shimDir+string(os.PathListSeparator)+realDir, nil),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsCopiedGoShim(t *testing.T) {
	for _, tt := range []struct {
		name     string
		module   string
		command  string
		wantShim bool
	}{
		{"octopool", "github.com/openclaw/octopool", "octopool", true},
		{"gitcrawl", "github.com/openclaw/gitcrawl", "gitcrawl", true},
		{"github-cli", "github.com/cli/cli/v2", "gh", false},
		{"test-command", "github.com/openclaw/octopool", "octopool.test", false},
		{"other-command", "github.com/openclaw/gitcrawl", "gitcrawl-helper", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			binary := buildGHPathFixture(t, tt.module, tt.command)
			dir := t.TempDir()
			// Neutral names and a separate copy prevent name and same-file checks
			// from masking the buildinfo check.
			candidate := filepath.Join(dir, "gh.exe")
			data, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(candidate, data, 0o755); err != nil {
				t.Fatal(err)
			}
			info, err := buildinfo.ReadFile(candidate)
			if err != nil {
				t.Fatalf("read fixture buildinfo: %v", err)
			}
			if want := tt.module + "/cmd/" + tt.command; info.Path != want {
				t.Fatalf("fixture buildinfo Path = %q, want %q", info.Path, want)
			}
			if got := ghShimPath(candidate); got != tt.wantShim {
				t.Errorf("ghShimPath() = %v, want %v", got, tt.wantShim)
			}
			realGH := filepath.Join(dir, "fallback-gh.exe")
			if err := os.WriteFile(realGH, []byte("real gh"), 0o755); err != nil {
				t.Fatal(err)
			}

			want := candidate
			if tt.wantShim {
				want = realGH
			}
			got, err := resolveGHPathFrom("gh", binary, []string{candidate, realGH})
			if err != nil || got != want {
				t.Errorf("resolveGHPathFrom() = %q, %v; want %q, nil", got, err, want)
			}
			got, err = resolveGHPathFrom(candidate, binary, []string{realGH})
			if tt.wantShim {
				if got != "" || err == nil || !strings.Contains(err.Error(), "does not point to the real GitHub CLI") {
					t.Errorf("explicit shim: resolveGHPathFrom() = %q, %v; want rejection", got, err)
				}
			} else if err != nil || got != candidate {
				t.Errorf("explicit non-shim: resolveGHPathFrom() = %q, %v; want %q, nil", got, err, candidate)
			}
		})
	}
}

func buildGHPathFixture(t *testing.T, module, command string) string {
	t.Helper()
	// A test executable can have a .test buildinfo Path, unlike a go build command.
	dir := t.TempDir()
	commandDir := filepath.Join(dir, "cmd", command)
	if err := os.MkdirAll(commandDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module "+module+"\n\ngo 1.26\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(commandDir, "main.go"), []byte("package main\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "fixture.exe")
	goTool := executableName("go")
	// -trimpath can leave GOROOT empty; use PATH only in that case.
	if root := runtime.GOROOT(); root != "" {
		goTool = filepath.Join(root, "bin", goTool)
	}
	goPath, err := exec.LookPath(goTool)
	if err != nil {
		t.Fatalf("locate Go compiler for fixture (%q): %v", goTool, err)
	}
	cmd := exec.CommandContext(t.Context(), goPath, "build", "-buildvcs=false", "-o", binary, "./cmd/"+command)
	cmd.Dir = dir
	// Ignore caller Go configuration, including workspace, flags and experiments.
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "GO") && !strings.HasPrefix(key, "CGO_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "GOENV=off", "GO111MODULE=on", "GOWORK=off", "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build Go fixture: %v\n%s", err, out)
	}
	return binary
}

func TestResolveGHPathRejectsExplicitShim(t *testing.T) {
	dir := t.TempDir()
	gitcrawlBinary := filepath.Join(dir, "gitcrawl-gh")
	if err := os.WriteFile(gitcrawlBinary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "gh")
	if err := os.Symlink(gitcrawlBinary, shim); err != nil {
		t.Fatal(err)
	}

	_, err := resolveGHPathFrom(shim, filepath.Join(dir, "octopool"), nil)
	if err == nil || !strings.Contains(err.Error(), "does not point to the real GitHub CLI") {
		t.Fatalf("resolveGHPathFrom() error = %v", err)
	}
}

func TestResolveGHPathAcceptsExplicitRelativePath(t *testing.T) {
	dir := t.TempDir()
	toolsDir := filepath.Join(dir, "tools")
	if err := os.Mkdir(toolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(toolsDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previousDir); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})

	got, err := resolveGHPathFrom(filepath.Join(".", "tools", "gh"), filepath.Join(dir, "octopool"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(got, realGH) {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathAcceptsExplicitCommandName(t *testing.T) {
	dir := t.TempDir()
	realGH := filepath.Join(dir, "custom-gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	got, err := resolveGHPathFrom("custom-gh", filepath.Join(dir, "octopool"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestResolveGHPathSkipsInvalidCandidates(t *testing.T) {
	dir := t.TempDir()
	nonExecutableDir := filepath.Join(dir, "nonexec")
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(nonExecutableDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nonExecutableDir, "gh"), []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	realGH := filepath.Join(realDir, "gh")
	if err := os.WriteFile(realGH, []byte("#!/bin/sh\necho gh version\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	candidates := ghPathCandidates(
		"relative-bin"+string(os.PathListSeparator)+nonExecutableDir+string(os.PathListSeparator)+realDir,
		nil,
	)
	for _, candidate := range candidates {
		if !filepath.IsAbs(candidate) {
			t.Fatalf("relative candidate was included: %q", candidate)
		}
	}
	got, err := resolveGHPathFrom("gh", filepath.Join(dir, "octopool"), candidates)
	if err != nil {
		t.Fatal(err)
	}
	if got != realGH {
		t.Fatalf("resolveGHPathFrom() = %q, want %q", got, realGH)
	}
}

func TestGHPathCandidatesIncludesWindowsExtensions(t *testing.T) {
	names := ghExecutableNames("windows", ".COM;.EXE;.BAT;.CMD")
	for _, name := range names {
		if name == "gh.exe" {
			return
		}
	}
	t.Fatalf("expected gh.exe in names %#v", names)
}
