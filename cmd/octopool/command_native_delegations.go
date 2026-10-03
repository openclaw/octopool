package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

type nativeDelegationGroup struct {
	Parent   string `json:"parent"`
	Category string `json:"category"`
	Shape    string `json:"shape"`
	Count    int    `json:"count"`
}

type nativeDelegationSummary struct {
	Since  time.Time               `json:"since"`
	Total  int                     `json:"total"`
	Groups []nativeDelegationGroup `json:"groups"`
}

func runNativeDelegations(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("native-delegations", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	since := fs.String("since", "24h", "local journal window, e.g. 30m, 24h, 7d")
	top := fs.Int("top", 20, "maximum groups to print")
	jsonOutput := fs.Bool("json", false, "print JSON counts")
	if handled, err := parseCommandFlags(fs, args, stdout, "usage: octopool native-delegations [--since 24h] [--top 20] [--json]"); err != nil || handled {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("native-delegations does not accept positional arguments")
	}
	window, err := nativeJournalWindow(*since)
	if err != nil {
		return err
	}
	if *top < 1 {
		return errors.New("--top must be positive")
	}
	paths := []string{}
	if cache, err := os.UserCacheDir(); err == nil {
		paths = append(paths, filepath.Join(cache, "octopool", nativeJournalName))
	}
	if directory, err := fallbackRelaySlotDirectory(); err == nil {
		paths = append(paths, filepath.Join(directory, nativeJournalName))
	}
	summary := aggregateNativeDelegations(paths, time.Now().UTC().Add(-window), *top)
	if *jsonOutput {
		return json.NewEncoder(stdout).Encode(summary)
	}
	if _, err := fmt.Fprintf(stdout, "Native delegations since %s: %d total (local, best effort)\n", summary.Since.Format(time.RFC3339), summary.Total); err != nil {
		return err
	}
	w := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "COUNT\tPARENT\tCATEGORY\tSHAPE"); err != nil {
		return err
	}
	for _, group := range summary.Groups {
		parent := group.Parent
		if parent == "" {
			parent = "(unknown)"
		}
		if _, err := fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", group.Count, parent, group.Category, group.Shape); err != nil {
			return err
		}
	}
	return w.Flush()
}

func nativeJournalWindow(raw string) (time.Duration, error) {
	if days, ok := strings.CutSuffix(raw, "d"); ok {
		count, err := strconv.ParseUint(days, 10, 32)
		if err != nil || count == 0 || count > uint64((1<<63-1)/(24*time.Hour)) {
			return 0, errors.New("--since must be a positive duration, e.g. 30m, 24h, 7d")
		}
		return time.Duration(count) * 24 * time.Hour, nil
	}
	window, err := time.ParseDuration(raw)
	if err != nil || window <= 0 {
		return 0, errors.New("--since must be a positive duration, e.g. 30m, 24h, 7d")
	}
	return window, nil
}

func aggregateNativeDelegations(paths []string, since time.Time, top int) nativeDelegationSummary {
	summary := nativeDelegationSummary{Since: since, Groups: []nativeDelegationGroup{}}
	counts := map[nativeDelegationGroup]int{}
	seen := map[string]bool{}
	for _, path := range paths {
		for _, name := range []string{path + ".1", path} {
			if seen[name] {
				continue
			}
			seen[name] = true
			file, err := openNativeJournalFile(name, os.O_RDONLY)
			if err != nil {
				continue
			}
			scanner := bufio.NewScanner(file)
			for scanner.Scan() {
				var entry nativeDelegation
				if json.Unmarshal(scanner.Bytes(), &entry) != nil || entry.TS.IsZero() || entry.TS.Before(since) || entry.Shape == "" || entry.Category == "" {
					continue
				}
				summary.Total++
				key := nativeDelegationGroup{Parent: entry.Parent, Category: entry.Category, Shape: entry.Shape}
				counts[key]++
			}
			_ = file.Close()
		}
	}
	for group, count := range counts {
		group.Count = count
		summary.Groups = append(summary.Groups, group)
	}
	slices.SortFunc(summary.Groups, func(a, b nativeDelegationGroup) int {
		if a.Count != b.Count {
			return b.Count - a.Count
		}
		if c := strings.Compare(a.Parent, b.Parent); c != 0 {
			return c
		}
		if c := strings.Compare(a.Category, b.Category); c != 0 {
			return c
		}
		return strings.Compare(a.Shape, b.Shape)
	})
	if len(summary.Groups) > top {
		summary.Groups = summary.Groups[:top]
	}
	return summary
}
