package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestUpdateShimBlockAppendsAndReplaces(t *testing.T) {
	before := []byte("export EXISTING=1\n")
	first, err := updateShimBlock(before, "/home/alice/.local/share/octopool/bin/gh", "/opt/bin/gh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(first)
	wantShimDir := "octopool_shim_dir='/home/alice/.local/share/octopool/bin'"
	if runtime.GOOS == "windows" {
		wantShimDir = `octopool_shim_dir='\home\alice\.local\share\octopool\bin'`
	}
	for _, want := range []string{
		"export EXISTING=1",
		shimBlockStart,
		"export OCTOPOOL_GH_PATH='/opt/bin/gh'",
		wantShimDir,
		`export PATH="$octopool_path_next"`,
		shimBlockEnd,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("updated block missing %q:\n%s", want, text)
		}
	}

	second, err := updateShimBlock(first, "/home/alice/.local/share/octopool/bin/gh", "/usr/local/bin/gh")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(second), shimBlockStart) != 1 || strings.Contains(string(second), "/opt/bin/gh") {
		t.Fatalf("managed block was not replaced:\n%s", second)
	}
}

func TestUpdateShimBlockKeepsPathIdempotentInZsh(t *testing.T) {
	isolateTestConfig(t)
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("zsh is required to exercise .zshenv PATH behavior")
	}
	home := t.TempDir()
	shimDir := filepath.Join(home, "shim [x]* ' dir")
	shimPath := filepath.Join(shimDir, "gh")
	if err := os.MkdirAll(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	block, err := updateShimBlock(nil, shimPath, "/opt/bin/gh")
	if err != nil {
		t.Fatal(err)
	}

	script := strings.Join([]string{
		"PATH=" + shellSingleQuote(shimDir+":/usr/bin"),
		string(block),
		string(block),
		"printf '%s' \"$PATH\"",
	}, "\n")
	out, err := exec.Command(zsh, "-f", "-c", script).Output()
	if err != nil {
		t.Fatalf("zsh failed: %v", err)
	}
	parts := strings.Split(string(out), ":")
	count := 0
	for _, part := range parts {
		if part == shimDir {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("shim dir appeared %d times in PATH %q", count, out)
	}
}

func TestUpdateShimBlockRejectsIncompleteBlock(t *testing.T) {
	_, err := updateShimBlock([]byte(shimBlockStart+"\n"), "/tmp/shim/gh", "/tmp/real/gh")
	if err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("error = %v", err)
	}
}

func TestApplyShimInstallPlanIsIdempotent(t *testing.T) {
	home := t.TempDir()
	octopoolPath := filepath.Join(home, "tools", "octopool")
	realGHPath := filepath.Join(home, "tools", "gh")
	for _, path := range []string{octopoolPath, realGHPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	shimPath := filepath.Join(home, ".local", "share", "octopool", "bin", "gh")
	startupPath := filepath.Join(home, ".zshenv")
	startupAfter, err := updateShimBlock(nil, shimPath, realGHPath)
	if err != nil {
		t.Fatal(err)
	}
	plan := shimInstallPlan{
		shimPath:       shimPath,
		octopoolPath:   octopoolPath,
		realGHPath:     realGHPath,
		startupPath:    startupPath,
		startupAfter:   startupAfter,
		shimChanged:    true,
		startupChanged: true,
	}
	if err := applyShimInstallPlan(plan); err != nil {
		t.Fatal(err)
	}
	if !samePath(shimPath, octopoolPath) {
		t.Fatalf("shim %s does not point to %s", shimPath, octopoolPath)
	}
	got, err := os.ReadFile(startupPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(startupAfter) {
		t.Fatalf("startup file = %q, want %q", got, startupAfter)
	}

	changed, err := shimNeedsUpdate(shimPath, octopoolPath)
	if err != nil || changed {
		t.Fatalf("shimNeedsUpdate() = %v, %v", changed, err)
	}
	updated, err := updateShimBlock(got, shimPath, realGHPath)
	if err != nil || string(updated) != string(got) {
		t.Fatalf("second update changed startup file: err=%v\n%s", err, updated)
	}
}

func TestVerifyShimInstallChecksLoginShell(t *testing.T) {
	isolateTestConfig(t)
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("zsh is required to verify shell startup behavior")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", home)
	shimDir := filepath.Join(home, "shim")
	shimPath := filepath.Join(shimDir, "gh")
	realGHPath := filepath.Join(home, "bin", "gh")
	for _, path := range []string{shimPath, realGHPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	startupPath := filepath.Join(home, ".zshenv")
	startup, err := updateShimBlock(nil, shimPath, realGHPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(startupPath, startup, 0o600); err != nil {
		t.Fatal(err)
	}
	profilePath := filepath.Join(home, ".zprofile")
	if err := os.WriteFile(profilePath, []byte("export PATH="+shellSingleQuote(shimDir)+":\"$PATH\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := shimInstallPlan{
		shellPath:   zsh,
		shimPath:    shimPath,
		realGHPath:  realGHPath,
		startupPath: startupPath,
	}

	if err := verifyShimInstall(plan); err != nil {
		t.Fatalf("verifyShimInstall() = %v", err)
	}

	shadowDir := filepath.Join(home, "shadow")
	if err := os.MkdirAll(shadowDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shadowDir, "gh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profilePath, []byte("export PATH="+shellSingleQuote(shadowDir)+":\"$PATH\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyShimInstall(plan); err == nil || !strings.Contains(err.Error(), "login zsh") {
		t.Fatalf("verifyShimInstall() = %v, want login-shell shadow error", err)
	}
}

func TestShimNeedsUpdateRejectsRegularFile(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "gh")
	if err := os.WriteFile(shim, []byte("do not replace"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := shimNeedsUpdate(shim, filepath.Join(dir, "octopool"))
	if err == nil || !strings.Contains(err.Error(), "not a symlink") {
		t.Fatalf("error = %v", err)
	}
}

func TestShellSingleQuote(t *testing.T) {
	if got := shellSingleQuote("/tmp/alice's tools"); got != `'/tmp/alice'"'"'s tools'` {
		t.Fatalf("shellSingleQuote() = %q", got)
	}
}

func TestExecutableNamedOctopool(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "octopool")
	if err := os.WriteFile(binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "stable")
	if err := os.Symlink(binary, link); err != nil {
		t.Fatal(err)
	}
	if !executableNamedOctopool(link) {
		t.Fatal("expected symlink to octopool to be accepted")
	}
	other := filepath.Join(dir, "other")
	if err := os.WriteFile(other, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if executableNamedOctopool(other) {
		t.Fatal("expected differently named executable to be rejected")
	}
}

func TestExecutableNamedOctopoolControls(t *testing.T) {
	windows := runtime.GOOS == "windows"
	for _, tt := range []struct {
		name string
		mode os.FileMode
		want bool
	}{
		{"octopool", 0o755, true},
		{"OcToPoOl", 0o755, true},
		{"octopool.exe", 0o755, windows},
		{"OcToPoOl.ExE", 0o755, windows},
		{"octopool", 0o644, windows},
		{"octopool.exe", 0o644, windows},
		{"octopool.cmd", 0o755, false},
		{"octopool.bat", 0o755, false},
		{"octopool.com", 0o755, false},
		{"octopool.exe.bak", 0o755, false},
		{"octopool.exe.exe", 0o755, false},
		{"octopool-gh", 0o755, false},
		{"other.exe", 0o755, false},
	} {
		t.Run(tt.name+"/"+tt.mode.String(), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tt.name)
			if err := os.WriteFile(path, []byte("binary"), tt.mode); err != nil {
				t.Fatal(err)
			}
			// An octopool-named link must not hide a differently named target.
			link := filepath.Join(t.TempDir(), executableName("octopool"))
			if err := os.Symlink(path, link); err != nil {
				t.Fatal(err)
			}
			for _, candidate := range []string{path, link} {
				if got := executableNamedOctopool(candidate); got != tt.want {
					t.Errorf("executableNamedOctopool(%q) = %v, want %v", candidate, got, tt.want)
				}
			}
		})
	}
	for _, kind := range []string{"directory", "absent"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), executableName("octopool"))
			if kind == "directory" {
				if err := os.Mkdir(path, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			link := filepath.Join(t.TempDir(), executableName("octopool"))
			if err := os.Symlink(path, link); err != nil {
				t.Fatal(err)
			}
			for _, candidate := range []string{path, link} {
				if executableNamedOctopool(candidate) {
					t.Errorf("expected %s to be rejected: %s", kind, candidate)
				}
			}
		})
	}
}
