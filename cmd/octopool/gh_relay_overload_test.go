package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func overloadTestClient(t *testing.T, respond func(*http.Request, int) (int, string)) (ghRelayClient, *int, *int) {
	t.Helper()
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	t.Setenv("OCTOPOOL_RELAY_CONCURRENCY", "1")
	t.Setenv("OCTOPOOL_RELAY_RETRIES", "")
	t.Setenv("OCTOPOOL_RELAY_TIMEOUT_SECONDS", "20")
	reads, policies := 0, 0
	transport := rewritePolicyTestTransport(func(r *http.Request) (*http.Response, error) {
		code, body := 200, rewriteEmptyTestPolicy
		if strings.HasSuffix(r.URL.Path, "/string-rewrites") {
			policies++
		} else {
			reads++
			code, body = respond(r, reads)
		}
		if err := r.Context().Err(); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	useRewritePolicyTestTransport(t, transport)
	useHTTPTestTransport(t, transport)
	return ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token", pool: "maintainers"}, &reads, &policies
}

func TestRelayOverloadRetrySchedule(t *testing.T) {
	for _, test := range []struct {
		name, reason, retries string
		failures, wantRetries int
		graphql               bool
	}{
		{name: "overload recovers", reason: "relay_overloaded", failures: 3, wantRetries: 3},
		{name: "GraphQL overload recovers", reason: "relay_overloaded", failures: 3, wantRetries: 3, graphql: true},
		{name: "overload exhausted", reason: "relay_overloaded", failures: 99, wantRetries: 3},
		{name: "disabled", reason: "relay_overloaded", retries: "0", failures: 99},
		{name: "one override", reason: "relay_overloaded", retries: "1", failures: 99, wantRetries: 1},
		{name: "two override", reason: "relay_overloaded", retries: "2", failures: 2, wantRetries: 2},
		{name: "invalid override", reason: "relay_overloaded", retries: "bad", failures: 3, wantRetries: 3},
		{name: "negative override", reason: "relay_overloaded", retries: "-1", failures: 3, wantRetries: 3},
		{name: "cooldown", reason: "identities_cooling_down", failures: 99, wantRetries: 1},
		{name: "pool depleted", reason: "identity_pool_depleted", failures: 99, wantRetries: 1},
		{name: "identity depleted", reason: "github_identity_depleted", failures: 99, wantRetries: 1},
		{name: "rate limited", reason: "github_rate_limited", failures: 99, wantRetries: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				client, reads, policies := overloadTestClient(t, func(_ *http.Request, call int) (int, string) {
					if call <= test.failures {
						return 424, `{"error":{"code":"fallback_local","details":{"reason":"` + test.reason + `"}}}`
					}
					return 200, `{"status":200,"body":{"ok":true},"body_encoding":"json"}`
				})
				t.Setenv("OCTOPOOL_RELAY_RETRIES", test.retries)
				original := sleepContext
				var sleeps []time.Duration
				sleepContext = func(ctx context.Context, delay time.Duration) error {
					// A second caller must be able to use the only slot during backoff.
					file := acquireRelaySlot(t.Context(), 1, time.Millisecond)
					if file == nil {
						t.Fatal("retry backoff retained the relay slot")
					}
					file.Close()
					sleeps = append(sleeps, delay)
					return original(ctx, delay)
				}
				t.Cleanup(func() { sleepContext = original })
				request := ghAPIRequest{method: "GET", path: "/repos/acme/repo"}
				if test.graphql {
					request = ghAPIRequest{method: "POST", path: "/graphql", graphql: &graphQLReadRequest{Query: `query { repository(owner:"acme",name:"repo") { name } }`}}
				}
				_, err := client.do(t.Context(), request)
				wantFallback := test.failures > test.wantRetries
				if (err != nil) != wantFallback || isLocalFallback(err) != wantFallback || *reads != test.wantRetries+1 || *policies != *reads || len(sleeps) != test.wantRetries {
					t.Fatalf("err=%v reads=%d policies=%d sleeps=%v", err, *reads, *policies, sleeps)
				}
				for i, delay := range sleeps {
					if test.reason == "relay_overloaded" {
						base := (500 * time.Millisecond) << min(i, 2)
						if delay < base || delay >= 2*base {
							t.Fatalf("retry %d delay=%s, want [%s, %s)", i, delay, base, 2*base)
						}
					} else if delay != time.Second {
						t.Fatalf("ordinary transient delay=%s", delay)
					}
				}
			})
		})
	}
}

func TestRelayOverloadRetryBudget(t *testing.T) {
	for _, mode := range []string{"wait cap", "slow refusal", "slow retry", "caller deadline", "caller cancellation"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				client, reads, _ := overloadTestClient(t, func(r *http.Request, call int) (int, string) {
					if mode == "slow refusal" {
						time.Sleep(4600 * time.Millisecond)
					}
					if mode == "slow retry" {
						if call == 1 {
							time.Sleep(4 * time.Second)
						} else {
							<-r.Context().Done()
							return 200, ""
						}
					}
					return 424, `{"error":{"code":"fallback_local","details":{"reason":"relay_overloaded"}}}`
				})
				t.Setenv("OCTOPOOL_RELAY_RETRIES", "100")
				if mode == "slow refusal" || mode == "slow retry" {
					t.Setenv("OCTOPOOL_RELAY_TIMEOUT_SECONDS", "5")
				}
				ctx := t.Context()
				if mode == "caller deadline" {
					var cancel context.CancelFunc
					ctx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
					defer cancel()
				} else if mode == "caller cancellation" {
					var cancel context.CancelFunc
					ctx, cancel = context.WithCancel(ctx)
					defer cancel()
					time.AfterFunc(100*time.Millisecond, cancel)
				}
				started := time.Now()
				_, err := client.do(ctx, ghAPIRequest{method: "GET", path: "/repos/acme/repo"})
				elapsed := time.Since(started)
				if mode == "caller deadline" || mode == "caller cancellation" {
					if !errors.Is(err, ctx.Err()) || *reads != 1 || elapsed != 100*time.Millisecond {
						t.Fatalf("err=%v reads=%d elapsed=%s", err, *reads, elapsed)
					}
					return
				}
				if !isLocalFallback(err) {
					t.Fatalf("expected bounded fallback, got %v", err)
				}
				switch mode {
				case "wait cap":
					if elapsed > 8*time.Second || *reads < 4 || *reads > 6 {
						t.Fatalf("reads=%d wait=%s", *reads, elapsed)
					}
				case "slow refusal":
					if *reads != 1 || elapsed != 4600*time.Millisecond {
						t.Fatalf("reads=%d wait=%s", *reads, elapsed)
					}
				case "slow retry":
					if *reads != 2 || elapsed != 5*time.Second {
						t.Fatalf("reads=%d wait=%s", *reads, elapsed)
					}
				}
			})
		})
	}
}
