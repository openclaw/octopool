package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() {
	if isGHArgv(os.Args[0]) {
		args := os.Args[1:]
		var err error
		if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
			err = execRealGH(context.Background(), args, os.Stdout, os.Stderr)
		} else {
			err = runGH(context.Background(), args, os.Stdout, os.Stderr)
		}
		if err != nil {
			var exit exitCodeError
			if errors.As(err, &exit) {
				os.Exit(exit.Code)
			}
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		var exit exitCodeError
		if errors.As(err, &exit) {
			os.Exit(exit.Code)
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

type exitCodeError struct {
	Code int
}

func (e exitCodeError) Error() string {
	return fmt.Sprintf("exit status %d", e.Code)
}

func run(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stderr)
		return errors.New("missing command")
	}
	switch args[0] {
	case "version", "--version":
		fmt.Fprintln(stdout, versionLine())
		return nil
	case "login":
		return runLogin(ctx, args[1:], stdout)
	case "install-shim":
		return runInstallShim(args[1:], stdout)
	case "whoami":
		return runWhoami(args[1:], stdout)
	case "gh":
		return runGH(ctx, args[1:], stdout, stderr)
	case "health":
		return runHealth(ctx, args[1:], stdout)
	case "stats":
		return runStats(ctx, args[1:], stdout)
	case "native-delegations":
		return runNativeDelegations(args[1:], stdout)
	case "request":
		return runRequest(ctx, args[1:], stdout)
	case "admin":
		return runAdmin(ctx, args[1:], stdout)
	case "help", "-h", "--help":
		usage(stdout)
		return nil
	default:
		usage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func versionLine() string {
	infoVersion, infoCommit, infoDate := buildInfoVersion()
	displayVersion := version
	if displayVersion == "dev" && infoVersion != "" {
		displayVersion = infoVersion
	}
	displayCommit := commit
	if displayCommit == "unknown" && infoCommit != "" {
		displayCommit = infoCommit
	}
	displayDate := date
	if displayDate == "unknown" && infoDate != "" {
		displayDate = infoDate
	}
	return fmt.Sprintf("octopool %s (%s, %s)", displayVersion, displayCommit, displayDate)
}

func buildInfoVersion() (string, string, string) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "", "", ""
	}
	infoVersion := ""
	if info.Main.Version != "" && info.Main.Version != "(devel)" {
		infoVersion = strings.TrimPrefix(info.Main.Version, "v")
	}
	infoCommit := ""
	infoDate := ""
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			if len(setting.Value) >= 7 {
				infoCommit = setting.Value[:7]
			} else {
				infoCommit = setting.Value
			}
		case "vcs.time":
			infoDate = setting.Value
		}
	}
	return infoVersion, infoCommit, infoDate
}

func isGHArgv(argv0 string) bool {
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(argv0)), ".exe")
	return base == "gh" || base == "octopool-gh"
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: octopool <login|install-shim|whoami|gh|health|stats|native-delegations|request|admin> [flags]")
}

func parseCommandFlags(fs *flag.FlagSet, args []string, stdout io.Writer, usageLine string) (bool, error) {
	err := fs.Parse(args)
	if !errors.Is(err, flag.ErrHelp) {
		return false, err
	}
	fmt.Fprintln(stdout, usageLine)
	fs.SetOutput(stdout)
	fs.PrintDefaults()
	fs.SetOutput(io.Discard)
	return true, nil
}
