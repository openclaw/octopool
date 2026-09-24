package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestRelayConcurrencySetting(t *testing.T) {
	for _, test := range []struct {
		value string
		want  int
	}{{"", 8}, {"4", 4}, {"0", 0}, {" 12 ", 12}, {"-1", 8}, {"invalid", 8}, {"999999999999999999999999", 8}} {
		t.Run(test.value, func(t *testing.T) {
			t.Setenv("OCTOPOOL_RELAY_CONCURRENCY", test.value)
			if got := relayConcurrency(); got != test.want {
				t.Fatalf("concurrency = %d, want %d", got, test.want)
			}
		})
	}
}

// Spawn this test binary so each client has independent memory and lock handles.
func TestRelaySlotProcess(t *testing.T) {
	mode := os.Getenv("OCTOPOOL_TEST_SLOT_PROCESS")
	if mode == "" {
		return
	}
	if mode == "hold" {
		file := acquireRelaySlot(t.Context(), 1, time.Second)
		if file == nil {
			t.Fatal("could not acquire child slot")
		}
		defer file.Close()
	}
	fmt.Println("ready")
	var start [1]byte
	if _, err := io.ReadFull(os.Stdin, start[:]); err != nil {
		t.Fatal(err)
	}
	if mode == "read" {
		var out, stderr bytes.Buffer
		if err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		if out.String() != "{\"ok\":true}\n" || stderr.Len() != 0 {
			t.Fatalf("output=%q stderr=%q", out.String(), stderr.String())
		}
	}
}

type relaySlotProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr bytes.Buffer
}

func startRelaySlotProcess(t *testing.T, mode string) *relaySlotProcess {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := &relaySlotProcess{cmd: exec.CommandContext(t.Context(), executable, "-test.run=^TestRelaySlotProcess$", "-test.timeout=45s")}
	child.cmd.Env = append(os.Environ(), "OCTOPOOL_TEST_SLOT_PROCESS="+mode)
	child.cmd.Stderr = &child.stderr
	child.stdin, err = child.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := child.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.stdout = bufio.NewReader(stdout)
	if err := child.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = child.stdin.Close()
		if child.cmd.ProcessState == nil {
			_ = child.cmd.Process.Kill()
			_ = child.cmd.Wait()
		}
	})
	return child
}

func (child *relaySlotProcess) ready(t *testing.T) {
	t.Helper()
	line, err := child.stdout.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("child not ready: %q %v", line, err)
	}
}

func TestRelaySlotCrossProcessConcurrency(t *testing.T) {
	for _, concurrency := range []string{"4", "0"} {
		t.Run(concurrency, func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("OCTOPOOL_RELAY_CONCURRENCY", concurrency)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
			t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
			var active, peak, relayActive, relayPeak, policies, reads atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				current := active.Add(1)
				defer active.Add(-1)
				updateRelaySlotPeak(&peak, current)
				switch r.URL.Path {
				case "/v1/pools/maintainers/string-rewrites":
					policies.Add(1)
					time.Sleep(100 * time.Millisecond)
					_, _ = io.WriteString(w, rewriteEmptyTestPolicy)
				case "/v1/github/request":
					reads.Add(1)
					current := relayActive.Add(1)
					defer relayActive.Add(-1)
					updateRelaySlotPeak(&relayPeak, current)
					time.Sleep(200 * time.Millisecond)
					writeCLIEnvelope(t, w, map[string]any{"ok": true})
				default:
					t.Error("unexpected request", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			t.Cleanup(server.Close)
			t.Setenv("OCTOPOOL_URL", server.URL)
			t.Setenv("OCTOPOOL_TOKEN", "synthetic-token")
			t.Setenv("OCTOPOOL_POOL", "maintainers")
			children := make([]*relaySlotProcess, 20)
			for i := range children {
				children[i] = startRelaySlotProcess(t, "read")
			}
			for _, child := range children {
				child.ready(t)
			}
			for _, child := range children {
				if _, err := child.stdin.Write([]byte{1}); err != nil {
					t.Fatal(err)
				}
			}
			for _, child := range children {
				output, readErr := io.ReadAll(child.stdout)
				if err := child.cmd.Wait(); err != nil || readErr != nil {
					t.Fatalf("child failed: %v / %v\n%s\n%s", err, readErr, output, child.stderr.String())
				}
			}
			if reads.Load() != 20 || policies.Load() != 40 {
				t.Fatalf("reads=%d policies=%d", reads.Load(), policies.Load())
			}
			if concurrency == "4" && (peak.Load() > 4 || relayPeak.Load() > 4) {
				t.Fatalf("cap exceeded: all=%d relay=%d", peak.Load(), relayPeak.Load())
			}
			if concurrency == "0" && (peak.Load() <= 4 || relayPeak.Load() <= 4) {
				t.Fatalf("disabled limiter still serialized requests: all=%d relay=%d", peak.Load(), relayPeak.Load())
			}
			t.Logf("20 processes: concurrency=%s, peak all requests=%d, peak relay POSTs=%d", concurrency, peak.Load(), relayPeak.Load())
		})
	}
}

func updateRelaySlotPeak(peak *atomic.Int64, current int64) {
	for previous := peak.Load(); current > previous; previous = peak.Load() {
		if peak.CompareAndSwap(previous, current) {
			return
		}
	}
}

func TestRelaySlotKilledProcessReleasesLock(t *testing.T) {
	isolateTestConfig(t)
	child := startRelaySlotProcess(t, "hold")
	child.ready(t)
	if file := acquireRelaySlot(t.Context(), 1, 50*time.Millisecond); file != nil {
		file.Close()
		t.Fatal("acquired slot while child held it")
	}
	if err := child.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.cmd.Wait()
	file := acquireRelaySlot(t.Context(), 1, time.Second)
	if file == nil {
		t.Fatal("killed process did not release slot")
	}
	file.Close()
}

func TestRelaySlotFailOpen(t *testing.T) {
	for _, mode := range []string{"unwritable directory", "invalid cache directory", "invalid slot file"} {
		t.Run(mode, func(t *testing.T) {
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, _ *http.Request) {
				writeCLIEnvelope(t, w, map[string]any{"ok": true})
			})
			t.Setenv("OCTOPOOL_RELAY_CONCURRENCY", "1")
			t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			cache, err := os.UserCacheDir()
			if err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(cache, "octopool", "relay-slots")
			if err := os.MkdirAll(directory, 0700); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "unwritable directory":
				if runtime.GOOS == "windows" {
					t.Skip("Windows read-only mode does not prohibit creating directory entries; invalid-path fail-open is tested separately")
				}
				if err := os.Chmod(directory, 0500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(directory, 0700) })
				probe, err := os.Create(filepath.Join(directory, "probe"))
				if err == nil {
					probe.Close()
					t.Skip("current user bypasses directory permissions")
				}
			case "invalid cache directory":
				if err := os.Remove(directory); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(directory, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid slot file":
				if err := os.Mkdir(filepath.Join(directory, "slot-0"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			var out, stderr bytes.Buffer
			if err := run(t.Context(), []string{"gh", "api", "repos/acme/repo"}, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			if out.String() != "{\"ok\":true}\n" || stderr.Len() != 0 {
				t.Fatalf("output=%q stderr=%q", out.String(), stderr.String())
			}
		})
	}
}

func TestRelaySlotWaitBoundAndCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		isolateTestConfig(t)
		held := acquireRelaySlot(t.Context(), 1, relaySlotWait)
		if held == nil {
			t.Fatal("could not hold slot")
		}
		defer held.Close()
		for _, cancelAfter := range []time.Duration{0, 50 * time.Millisecond} {
			ctx := t.Context()
			if cancelAfter != 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, cancelAfter)
				defer cancel()
			}
			started := time.Now()
			if file := acquireRelaySlot(ctx, 1, relaySlotWait); file != nil {
				file.Close()
				t.Fatal("acquired occupied slot")
			}
			want := relaySlotWait
			if cancelAfter != 0 {
				want = cancelAfter
			}
			if elapsed := time.Since(started); elapsed != want {
				t.Fatalf("wait=%s, want %s", elapsed, want)
			}
		}
	})
}

func TestRelaySlotWaitPreservesPolicyRetryAndReadBudgets(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		isolateTestConfig(t)
		t.Setenv("OCTOPOOL_RELAY_CONCURRENCY", "1")
		t.Setenv("OCTOPOOL_RELAY_TIMEOUT_SECONDS", "20")
		t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
		held := acquireRelaySlot(t.Context(), 1, relaySlotWait)
		if held == nil {
			t.Fatal("could not hold slot")
		}
		defer held.Close()
		go func() {
			time.Sleep(8 * time.Second)
			held.Close()
		}()
		policies, reads := 0, 0
		transport := rewritePolicyTestTransport(func(r *http.Request) (*http.Response, error) {
			wantBudget := 20 * time.Second
			body := `{"status":200,"body":{"ok":true},"body_encoding":"json"}`
			code := 200
			if strings.HasSuffix(r.URL.Path, "/string-rewrites") {
				policies++
				wantBudget = rewritePolicyTimeout
				body = rewriteEmptyTestPolicy
				if policies == 1 {
					code = 503
				} else {
					wantBudget = rewritePolicyRetryTimeout
				}
			} else {
				reads++
			}
			deadline, ok := r.Context().Deadline()
			if !ok || time.Until(deadline) != wantBudget {
				t.Errorf("request budget=%s, want %s", time.Until(deadline), wantBudget)
			}
			if file := acquireRelaySlot(t.Context(), 1, time.Millisecond); file != nil {
				file.Close()
				t.Error("request ran without its slot")
			}
			return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body))}, nil
		})
		useRewritePolicyTestTransport(t, transport)
		useHTTPTestTransport(t, transport)
		client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token"}
		started := time.Now()
		if _, err := client.doOnce(t.Context(), ghAPIRequest{method: "GET", path: "/repos/acme/repo"}); err != nil {
			t.Fatal(err)
		}
		if policies != 2 || reads != 1 || time.Since(started) < 8*time.Second || time.Since(started) > 9*time.Second {
			t.Fatalf("policies=%d reads=%d elapsed=%s", policies, reads, time.Since(started))
		}
		file := acquireRelaySlot(t.Context(), 1, time.Second)
		if file == nil {
			t.Fatal("completed attempt retained its slot")
		}
		file.Close()
	})
}
