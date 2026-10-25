package main

import (
	"errors"
	"io"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestProtectedUnmodeledContentShape(t *testing.T) {
	for _, args := range [][]string{
		{"release", "edit", "v0.9.10", "--repo=openclaw/octopool", "--draft=false", "--latest"},
		{"pr", "edit", "7", "--repo=acme/repo", "--body=safe", "--future-private-input=/private/path"},
		{"issue", "comment", "7", "--repo=acme/repo", "--body=safe", "--web"},
	} {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capture := captureRewriteGH(t)
			err := runGH(t.Context(), args, io.Discard, io.Discard)
			if !errors.Is(err, errRewriteCommandShape) || errors.Is(err, errRewriteBlocked) || errors.Is(err, errRewriteUnsupported) {
				t.Fatalf("wrong refusal boundary: %v", err)
			}
			want := "octopool: string rewrite protection does not model this gh command shape; run it with ghx (the native gh CLI) if it publishes no protected text, or see docs/cli.md"
			if err.Error() != want {
				t.Fatalf("unexpected error: %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unmodeled protected shape reached native execution")
			}
		})
	}
}

func TestProtectedShapePolicyAndMalformedInputKeepBlock(t *testing.T) {
	for _, args := range [][]string{
		{"release", "edit", "v1", "--repo=internal-model/repo", "--draft=false", "--latest"},
		{"pr", "edit", "7", "--repo=acme/repo", "--body=safe", "--body=duplicate"},
		{"release", "edit", "v1", "--repo=acme/repo", "--draft=malformed"},
		{"issue", "comment", "7", "--repo=acme/repo", "--body"},
	} {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			rewriteTestServer(t, rewriteActiveTestPolicy, nil)
			capture := captureRewriteGH(t)
			err := runGH(t.Context(), args, io.Discard, io.Discard)
			if !errors.Is(err, errRewriteBlocked) || err.Error() != "string rewrite protection blocked unsafe input" {
				t.Fatalf("policy/malformed input message changed: %v", err)
			}
			assertNoRESTWriteChild(t, capture)
		})
	}
}

func TestProtectedUnknownSubcommandKeepsBestEffortFiltering(t *testing.T) {
	rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	capture := captureRewriteGH(t)
	args := []string{"release", "future-private-input", "--repo=acme/repo", "--future=internal-model"}
	if err := execRealGH(t.Context(), args, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	child := readRewriteCapture(t, capture)
	if !slices.Contains(child.Args, "--future=public") {
		t.Fatalf("unmodeled delegation lost filtering: %v", child.Args)
	}
}
