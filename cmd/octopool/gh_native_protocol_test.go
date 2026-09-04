package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Deliberately opt-in: ordinary tests must never discover or run an installed gh.
func TestNativeGHMergeHeaderProtocol(t *testing.T) {
	bin := os.Getenv("OCTOPOOL_TEST_NATIVE_GH")
	if bin == "" {
		t.Skip("set OCTOPOOL_TEST_NATIVE_GH to an explicit native test binary")
	}
	if !filepath.IsAbs(bin) {
		t.Fatal("native test binary must be absolute")
	}
	for _, code := range []int{200, 403} {
		for _, color := range []bool{false, true} {
			t.Run(fmt.Sprintf("status_%d_color_%t", code, color), func(t *testing.T) {
				const body = `{"message":"synthetic response"}`
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.URL.Path != "/synthetic" || r.Method != "PUT" {
						t.Error("unexpected synthetic request shape")
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Content-Length", strconv.Itoa(len(body)))
					w.Header().Set("Date", "Wed, 01 Jan 2025 00:00:00 GMT")
					w.Header().Set("X-Github-Request-Id", "ABCD:1234:5678:90EF")
					w.Header().Set("X-Ratelimit-Remaining", "0")
					w.WriteHeader(code)
					_, _ = w.Write([]byte(body))
				}))
				defer server.Close()
				if !strings.HasPrefix(server.URL, "http://127.0.0.1:") {
					t.Fatal("fixture must use literal IPv4 loopback")
				}
				home := t.TempDir()
				// No inherited environment, credential helpers, config, proxy, or tracing.
				env := []string{
					"HOME=" + home, "XDG_CONFIG_HOME=" + home, "GH_CONFIG_DIR=" + home,
					"XDG_CACHE_HOME=" + home, "XDG_DATA_HOME=" + home, "TMPDIR=" + home,
					"GH_TOKEN=synthetic", "GH_ENTERPRISE_TOKEN=synthetic", "GH_HOST=github.com",
					"GH_NO_UPDATE_NOTIFIER=1", "GH_NO_EXTENSION_UPDATE_NOTIFIER=1",
					"GH_PROMPT_DISABLED=1", "GH_PAGER=cat", "TERM=dumb",
				}
				if color {
					env = append(env, "CLICOLOR_FORCE=1", "GH_FORCE_TTY=80")
				} else {
					env = append(env, "NO_COLOR=1")
				}
				run := func(include bool) (string, string, int) {
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					args := []string{"api", server.URL + "/synthetic", "--method=PUT", "--input=-", "--silent=true"}
					if include {
						args = append(args, "--include=true")
					}
					cmd := exec.CommandContext(ctx, bin, args...)
					cmd.Env, cmd.Dir, cmd.Stdin = env, home, strings.NewReader(`{"synthetic":true}`)
					var stdout, stderr bytes.Buffer
					cmd.Stdout, cmd.Stderr = &stdout, &stderr
					before := calls.Load()
					err := cmd.Run()
					if cmd.ProcessState == nil || ctx.Err() != nil {
						t.Fatal("native fixture did not complete")
					}
					exit := cmd.ProcessState.ExitCode()
					if (err != nil) != (exit != 0) || calls.Load()-before != 1 {
						t.Fatal("expected exactly one completed loopback request")
					}
					return stdout.String(), stderr.String(), exit
				}
				plainOut, plainErr, plainExit := run(false)
				includedOut, includedErr, includedExit := run(true)
				wantExit := 0
				if code == 403 {
					wantExit = 1
				}
				if plainOut != "" || plainErr != includedErr || plainExit != wantExit || includedExit != wantExit {
					t.Fatal("silent stdout, native stderr, or exit contract changed")
				}
				name := func(s string) string {
					if color {
						return "\x1b[1;34m" + s + "\x1b[m"
					}
					return s
				}
				want := fmt.Sprintf("HTTP/1.1 %d %s\n", code, http.StatusText(code))
				for _, field := range [][2]string{
					{"Content-Length", strconv.Itoa(len(body))}, {"Content-Type", "application/json"},
					{"Date", "Wed, 01 Jan 2025 00:00:00 GMT"}, {"X-Github-Request-Id", "ABCD:1234:5678:90EF"},
					{"X-Ratelimit-Remaining", "0"},
				} {
					want += name(field[0]) + ": " + field[1] + "\r\n"
				}
				want += "\r\n"
				if includedOut != want {
					t.Fatalf("synthetic header framing mismatch: got %q want %q", includedOut, want)
				}
				collector := &ghMergeHeaderCollector{}
				for _, b := range []byte(includedOut) {
					_, _ = collector.Write([]byte{b})
				}
				if fields, ok := collector.result(); !ok || fields.status != code || fields.requestID != "ABCD:1234:5678:90EF" || fields.numbers[1] == nil || *fields.numbers[1] != 0 {
					t.Fatal("collector rejected proven native frame")
				}
				t.Log("one request per mode; exact header-only frame; native stderr and exit preserved")
			})
		}
	}
}
