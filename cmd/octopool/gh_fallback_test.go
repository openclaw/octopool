package main

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"testing"
)

func TestRunJQPreservesOutputBytes(t *testing.T) {
	isolateTestConfig(t)
	if !jqAvailable() {
		t.Skip("jq is required")
	}
	for _, tt := range []struct {
		name, input, expr, want string
	}{
		{"LF", `"left\nright"`, ".", "left\nright\n"},
		{"CRLF", `"left\r\nright"`, ".", "left\r\nright\n"},
		{"CR", `"left\rright"`, ".", "left\rright\n"},
		{"Unicode", `"caf\u00e9 日本語 🦞"`, ".", "café 日本語 🦞\n"},
		{"empty string", `""`, ".", "\n"},
		{"trailing LF", `"tail\n"`, ".", "tail\n\n"},
		{"trailing CRLF", `"tail\r\n"`, ".", "tail\r\n\n"},
		{"trailing CR", `"tail\r"`, ".", "tail\r\n"},
		{"multiple results", `["a\n", "b\r\n", "c\r", "雪", "", true, 42]`, ".[]", "a\n\nb\r\n\nc\r\n雪\n\ntrue\n42\n"},
		{"input stream", "\"a\\r\\nb\"\n\"雪\"\n", ".", "a\r\nb\n雪\n"},
		{"no results", `[]`, ".[]", ""},
		{"negative filter", `42`, "-.", "-42\n"},
		{"double-negative filter", `[1,2,3]`, "--length", "3\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := runJQ(t.Context(), &out, []byte(tt.input), tt.expr); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(out.Bytes(), []byte(tt.want)) {
				t.Fatalf("output = %q, want %q", out.Bytes(), tt.want)
			}
		})
	}
}

func TestRunJQErrorsAndCancellation(t *testing.T) {
	isolateTestConfig(t)
	if !jqAvailable() {
		t.Skip("jq is required")
	}
	for _, tt := range []struct{ name, input, expr string }{
		{"invalid expression", `null`, ".["},
		{"help is a filter, not an option", `null`, "--help"},
		{"version is a filter, not an option", `null`, "--version"},
		{"invalid input", `{"unfinished":`, "."},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			err := runJQ(t.Context(), &out, []byte(tt.input), tt.expr)
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || out.Len() != 0 {
				t.Fatalf("error = %v, output = %q; want jq failure without output", err, out.Bytes())
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	var out bytes.Buffer
	if err := runJQ(ctx, &out, []byte(`"unused"`), "."); !errors.Is(err, context.Canceled) || out.Len() != 0 {
		t.Fatalf("canceled run: error = %v, output = %q", err, out.Bytes())
	}
}
