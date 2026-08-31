package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	shimBlockStart = "# >>> octopool gh shim >>>"
	shimBlockEnd   = "# <<< octopool gh shim <<<"
)

type shimInstallPlan struct {
	shellPath      string
	shimPath       string
	octopoolPath   string
	realGHPath     string
	startupPath    string
	startupAfter   []byte
	shimChanged    bool
	startupChanged bool
}

func runInstallShim(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("install-shim", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	shell := fs.String("shell", "", "shell to configure (default: $SHELL, currently zsh only)")
	dryRun := fs.Bool("dry-run", false, "show changes without writing them")
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool install-shim [--shell zsh] [--dry-run]"); err != nil {
		return err
	} else if handled {
		return nil
	}
	if fs.NArg() != 0 {
		return errors.New("install-shim does not accept positional arguments")
	}

	plan, err := buildShimInstallPlan(*shell)
	if err != nil {
		return err
	}
	if !*dryRun {
		if err := applyShimInstallPlan(plan); err != nil {
			return err
		}
		if err := verifyShimInstall(plan); err != nil {
			return err
		}
	}

	prefix := "installed"
	if *dryRun {
		prefix = "would install"
	} else if !plan.shimChanged && !plan.startupChanged {
		prefix = "already installed"
	}
	fmt.Fprintf(stdout, "%s gh shim: %s\n", prefix, plan.shimPath)
	fmt.Fprintf(stdout, "startup file: %s\n", plan.startupPath)
	fmt.Fprintf(stdout, "real gh: %s\n", plan.realGHPath)
	if !*dryRun {
		fmt.Fprintln(stdout, "verified: non-interactive and login zsh resolve gh through Octopool")
	}
	return nil
}

func buildShimInstallPlan(shellFlag string) (shimInstallPlan, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return shimInstallPlan{}, fmt.Errorf("find home directory: %w", err)
	}
	shellName := strings.TrimSpace(shellFlag)
	if shellName == "" {
		shellName = filepath.Base(strings.TrimSpace(os.Getenv("SHELL")))
	}
	if shellName == "" {
		shellName = "zsh"
	}
	if shellName != "zsh" {
		return shimInstallPlan{}, fmt.Errorf("unsupported shell %q; install-shim currently supports zsh", shellName)
	}
	shellPath, err := exec.LookPath("zsh")
	if err != nil {
		return shimInstallPlan{}, errors.New("zsh not found")
	}

	realGHPath, err := resolveGHPath(envDefault("OCTOPOOL_GH_PATH", "gh"))
	if err != nil {
		return shimInstallPlan{}, err
	}
	octopoolPath, err := stableOctopoolPath()
	if err != nil {
		return shimInstallPlan{}, err
	}

	dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	} else if !filepath.IsAbs(dataHome) {
		return shimInstallPlan{}, errors.New("XDG_DATA_HOME must be an absolute path")
	}
	shimPath := filepath.Join(dataHome, "octopool", "bin", "gh")

	zdotdir := strings.TrimSpace(os.Getenv("ZDOTDIR"))
	if zdotdir == "" {
		zdotdir = home
	} else if !filepath.IsAbs(zdotdir) {
		return shimInstallPlan{}, errors.New("ZDOTDIR must be an absolute path")
	}
	startupPath, err := writableStartupPath(filepath.Join(zdotdir, ".zshenv"))
	if err != nil {
		return shimInstallPlan{}, err
	}
	startupBefore, err := readOptionalFile(startupPath)
	if err != nil {
		return shimInstallPlan{}, fmt.Errorf("read %s: %w", startupPath, err)
	}
	startupAfter, err := updateShimBlock(startupBefore, shimPath, realGHPath)
	if err != nil {
		return shimInstallPlan{}, fmt.Errorf("update %s: %w", startupPath, err)
	}
	shimChanged, err := shimNeedsUpdate(shimPath, octopoolPath)
	if err != nil {
		return shimInstallPlan{}, err
	}

	return shimInstallPlan{
		shellPath:      shellPath,
		shimPath:       shimPath,
		octopoolPath:   octopoolPath,
		realGHPath:     realGHPath,
		startupPath:    startupPath,
		startupAfter:   startupAfter,
		shimChanged:    shimChanged,
		startupChanged: !bytes.Equal(startupBefore, startupAfter),
	}, nil
}

func stableOctopoolPath() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find octopool executable: %w", err)
	}
	if installed, installedErr := exec.LookPath("octopool"); installedErr == nil && executableNamedOctopool(installed) {
		absolute, absoluteErr := filepath.Abs(installed)
		if absoluteErr == nil {
			return absolute, nil
		}
	}
	for _, candidate := range []string{os.Args[0]} {
		resolved, resolveErr := exec.LookPath(candidate)
		if resolveErr == nil && samePath(resolved, self) {
			absolute, absoluteErr := filepath.Abs(resolved)
			if absoluteErr == nil {
				return absolute, nil
			}
		}
	}
	return self, nil
}

func executableNamedOctopool(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		resolved = path
	}
	base := filepath.Base(resolved)
	return strings.EqualFold(base, "octopool") || (runtime.GOOS == "windows" && strings.EqualFold(base, "octopool.exe"))
}

func writableStartupPath(path string) (string, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return path, nil
	}
	if err != nil {
		return "", fmt.Errorf("inspect %s: %w", path, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return path, nil
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", path, err)
	}
	return resolved, nil
}

func readOptionalFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func updateShimBlock(before []byte, shimPath string, realGHPath string) ([]byte, error) {
	text := string(before)
	start := strings.Index(text, shimBlockStart)
	end := strings.Index(text, shimBlockEnd)
	if (start >= 0) != (end >= 0) || start > end {
		return nil, errors.New("found an incomplete Octopool managed block")
	}
	if start >= 0 && strings.Contains(text[end+len(shimBlockEnd):], shimBlockStart) {
		return nil, errors.New("found multiple Octopool managed blocks")
	}

	shimDir := filepath.Dir(shimPath)
	block := strings.Join([]string{
		shimBlockStart,
		"export OCTOPOOL_GH_PATH=" + shellSingleQuote(realGHPath),
		"octopool_shim_dir=" + shellSingleQuote(shimDir),
		"octopool_path_next=\"$octopool_shim_dir\"",
		"for octopool_path_part in \"${(@s/:/)PATH}\"; do",
		"  [ \"$octopool_path_part\" = \"$octopool_shim_dir\" ] && continue",
		"  octopool_path_next=\"$octopool_path_next:$octopool_path_part\"",
		"done",
		"export PATH=\"$octopool_path_next\"",
		"unset octopool_shim_dir octopool_path_next octopool_path_part",
		shimBlockEnd,
	}, "\n")
	if start >= 0 {
		afterEnd := end + len(shimBlockEnd)
		return []byte(text[:start] + block + text[afterEnd:]), nil
	}

	if len(text) > 0 && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	if len(text) > 0 && !strings.HasSuffix(text, "\n\n") {
		text += "\n"
	}
	return []byte(text + block + "\n"), nil
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func shimNeedsUpdate(shimPath string, octopoolPath string) (bool, error) {
	info, err := os.Lstat(shimPath)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect %s: %w", shimPath, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return false, fmt.Errorf("%s exists and is not a symlink", shimPath)
	}
	return !samePath(shimPath, octopoolPath), nil
}

func applyShimInstallPlan(plan shimInstallPlan) error {
	if plan.shimChanged {
		if err := replaceSymlink(plan.shimPath, plan.octopoolPath); err != nil {
			return err
		}
	}
	if plan.startupChanged {
		if err := writeFileAtomic(plan.startupPath, plan.startupAfter); err != nil {
			return err
		}
	}
	return nil
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect %s: %w", path, err)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".octopool-zshenv-*")
	if err != nil {
		return fmt.Errorf("create temporary startup file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}

func replaceSymlink(path string, target string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create shim directory: %w", err)
	}
	placeholder, err := os.CreateTemp(filepath.Dir(path), ".octopool-gh-*")
	if err != nil {
		return fmt.Errorf("create temporary gh shim: %w", err)
	}
	temp := placeholder.Name()
	if err := placeholder.Close(); err != nil {
		os.Remove(temp)
		return err
	}
	if err := os.Remove(temp); err != nil {
		return err
	}
	if err := os.Symlink(target, temp); err != nil {
		return fmt.Errorf("create gh shim: %w", err)
	}
	defer os.Remove(temp)
	if err := os.Rename(temp, path); err != nil {
		return fmt.Errorf("replace gh shim: %w", err)
	}
	return nil
}

func verifyShimInstall(plan shimInstallPlan) error {
	for _, probe := range []struct {
		name string
		flag string
	}{
		{name: "non-interactive", flag: "-c"},
		{name: "login", flag: "-lc"},
	} {
		command := exec.Command(plan.shellPath, probe.flag, `command -v gh; print -r -- "${OCTOPOOL_GH_PATH:-}"`)
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		if err := command.Run(); err != nil {
			return fmt.Errorf("verify %s zsh: %w: %s", probe.name, err, strings.TrimSpace(stderr.String()))
		}
		lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
		if len(lines) != 2 || !samePath(strings.TrimSpace(lines[0]), plan.shimPath) || !samePath(strings.TrimSpace(lines[1]), plan.realGHPath) {
			return fmt.Errorf("%s zsh did not resolve the installed shim (got %q); ensure login startup files do not prepend another gh after %s", probe.name, strings.TrimSpace(stdout.String()), plan.startupPath)
		}
	}
	return nil
}
