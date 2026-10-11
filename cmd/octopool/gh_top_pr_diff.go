package main

import (
	"bytes"
	"context"
	"io"
	"regexp"
	"strings"
)

func relayPRDiffNames(ctx context.Context, stdout io.Writer, request ghAPIRequest) error {
	var diff bytes.Buffer
	if err := relayTop(ctx, &diff, request, ghTopOptions{}, nil); err != nil {
		return err
	}
	return writePRDiffNames(stdout, diff.String())
}

// Match gh v2.102.0's pkg/cmd/pr/diff.changedFilesNames, including its greedy
// b/ match and preserved Git quoting. Do not unquote, sort, or deduplicate names.
var prDiffHeaderPattern = regexp.MustCompile(`(?:^|\n)diff\s--git.*\s("?)b/(.*)`)

func writePRDiffNames(stdout io.Writer, diff string) error {
	for _, match := range prDiffHeaderPattern.FindAllStringSubmatch(diff, -1) {
		name := strings.TrimSpace(match[1] + match[2])
		if _, err := stdout.Write([]byte(name + "\n")); err != nil {
			return err
		}
	}
	return nil
}
