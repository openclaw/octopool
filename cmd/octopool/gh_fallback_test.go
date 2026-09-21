package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGHRelayCoolingDownFallsBackAfterOneRetry(t *testing.T) {
	var calls atomic.Int64
	rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writeCLIFallback(t, w, "identities_cooling_down")
	})
	captureRewriteGH(t)
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "")
	t.Setenv("OCTOPOOL_NO_FALLBACK", "")
	sleeps := recordWatchSleeps(t)
	var out, stderr bytes.Buffer
	err := runGH(t.Context(), []string{"api", "repos/acme/repo"}, &out, &stderr)
	if err != nil || calls.Load() != 2 || len(*sleeps) != 1 || (*sleeps)[0] != time.Second || out.String() != "child stdout\n" || !strings.Contains(stderr.String(), "identities_cooling_down; falling back to real gh") {
		t.Fatalf("err=%v calls=%d sleeps=%v out=%q stderr=%q", err, calls.Load(), *sleeps, out.String(), stderr.String())
	}
}

func TestGHRelaySlowReadFallsBackWithoutRetry(t *testing.T) {
	for _, phase := range []string{"headers", "body"} {
		t.Run(phase, func(t *testing.T) {
			captureRewriteGH(t)
			var calls atomic.Int64
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				if phase == "body" {
					w.WriteHeader(http.StatusOK)
					_, _ = io.WriteString(w, `{"status":200,"body":`)
					w.(http.Flusher).Flush()
				}
				select {
				case <-time.After(6 * time.Second):
				case <-r.Context().Done():
				}
			})
			t.Setenv("OCTOPOOL_RELAY_TIMEOUT_SECONDS", "5")
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "3")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			var out, stderr bytes.Buffer
			started := time.Now()
			err := runGH(t.Context(), []string{"api", "repos/acme/repo"}, &out, &stderr)
			elapsed := time.Since(started)
			if err != nil || calls.Load() != 1 || elapsed >= 7500*time.Millisecond || out.String() != "child stdout\n" || !strings.Contains(stderr.String(), "relay_timeout (read timed out; limit 5s); falling back to real gh") {
				t.Fatalf("err=%v calls=%d elapsed=%s out=%q stderr=%q", err, calls.Load(), elapsed, out.String(), stderr.String())
			}
			t.Logf("slow %s: timeout=5s elapsed=%s attempts=%d guarded native fallback=true", phase, elapsed.Round(time.Millisecond), calls.Load())
		})
	}
}

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
