package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"testing/synctest"
	"time"
)

func TestStringRewritePolicyRetryStatuses(t *testing.T) {
	for _, code := range []int{429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 301, 400, 401, 403, 404, 409, 408, 501, 505, 525} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				isolateTestConfig(t)
				t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
				t.Setenv("OCTOPOOL_RELAY_RETRIES", "0")
				calls := 0
				useRewritePolicyTestTransport(t, func(r *http.Request) (*http.Response, error) {
					calls++
					if r.Method != "GET" || r.URL.Path != "/v1/pools/selected/string-rewrites" || r.Header.Get("Cache-Control") != "no-cache, no-store" {
						t.Fatal("retry changed policy request")
					}
					status := code
					if calls > 1 {
						status = 200
					}
					return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(rewriteEmptyTestPolicy))}, nil
				})
				client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token", pool: "selected"}
				started := time.Now()
				_, err := client.stringRewritePolicy(t.Context())
				retryable := code == 429 || code == 500 || code >= 502 && code <= 504 || code >= 520 && code <= 524
				if retryable {
					if err != nil || calls != 2 || time.Since(started) < 240*time.Millisecond || time.Since(started) >= 360*time.Millisecond {
						t.Fatalf("retry err=%v calls=%d elapsed=%s", err, calls, time.Since(started))
					}
				} else {
					requireRewritePolicyDiagnostic(t, err, rewritePolicyHTTPStatus, code, "", started)
					if calls != 1 || time.Since(started) != 0 {
						t.Fatalf("nontransient status retried: calls=%d", calls)
					}
				}
			})
		})
	}
}

func TestStringRewritePolicyRetryAfter(t *testing.T) {
	for _, code := range []int{429, 503} {
		for _, value := range []string{"2", "20", "18446744073709551615", "date", "invalid", "-1"} {
			t.Run(fmt.Sprintf("%d/%s", code, value), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					isolateTestConfig(t)
					t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
					calls := 0
					started := time.Now()
					header := value
					if value == "date" {
						header = started.Add(2 * time.Second).UTC().Format(http.TimeFormat)
					}
					useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
						calls++
						status := code
						if calls > 1 {
							status = 200
						}
						return &http.Response{StatusCode: status, Header: http.Header{"Retry-After": {header}}, Body: io.NopCloser(strings.NewReader(rewriteEmptyTestPolicy))}, nil
					})
					client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token"}
					_, err := client.stringRewritePolicy(t.Context())
					if err != nil || calls != 2 {
						t.Fatalf("retry err=%v calls=%d", err, calls)
					}
					elapsed := time.Since(started)
					switch value {
					case "2", "date":
						if elapsed != 2*time.Second {
							t.Fatalf("Retry-After not honored: %s", elapsed)
						}
					case "20", "18446744073709551615":
						if elapsed != 3*time.Second {
							t.Fatalf("Retry-After not capped: %s", elapsed)
						}
					default:
						if elapsed < 240*time.Millisecond || elapsed >= 360*time.Millisecond {
							t.Fatalf("invalid Retry-After changed backoff: %s", elapsed)
						}
					}
				})
			})
		}
	}
}

func TestStringRewritePolicyRetryLastDiagnostic(t *testing.T) {
	for _, last := range []string{"500", "timeout", "validation"} {
		t.Run(last, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				calls := 0
				var lastStarted time.Time
				useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
					calls++
					lastStarted = time.Now()
					status, body := 500, "synthetic-body-secret"
					if calls == 3 {
						if last == "timeout" {
							return nil, &net.DNSError{IsTimeout: true}
						}
						if last == "validation" {
							status, body = 200, `{"rules":[]}`
						}
					}
					return &http.Response{StatusCode: status, Header: http.Header{"Cf-Ray": {fmt.Sprintf("%016x-SJC", calls)}}, Body: io.NopCloser(strings.NewReader(body))}, nil
				})
				client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token"}
				started := time.Now()
				_, err := client.stringRewritePolicy(t.Context())
				class, status, ray := rewritePolicyHTTPStatus, 500, "0000000000000003-SJC"
				if last == "timeout" {
					class, status, ray = rewritePolicyTimeoutClass, 0, ""
				} else if last == "validation" {
					class, status = rewritePolicyServerValidation, 200
				}
				diagnostic := requireRewritePolicyDiagnostic(t, err, class, status, ray, lastStarted, "synthetic-body-secret", "synthetic-token")
				if calls != 3 || !terminalRelayFailure(err) || diagnostic.started != lastStarted || diagnostic.elapsed != 0 || time.Since(started) < 1040*time.Millisecond || time.Since(started) >= 1560*time.Millisecond {
					t.Fatalf("final failure err=%v calls=%d elapsed=%s", err, calls, time.Since(started))
				}
			})
		})
	}
}

type rewritePolicyRetryBody struct{ err error }

func (body rewritePolicyRetryBody) Read([]byte) (int, error) { return 0, body.err }
func (body rewritePolicyRetryBody) Close() error             { return nil }

func TestStringRewritePolicyRetryTransport(t *testing.T) {
	for _, bodyRead := range []bool{false, true} {
		for _, cause := range []error{syscall.ECONNRESET, io.ErrUnexpectedEOF, context.DeadlineExceeded, &net.DNSError{IsTimeout: true}, context.Canceled, &net.DNSError{IsNotFound: true}, errors.New("synthetic-transport-secret")} {
			t.Run(fmt.Sprintf("body=%t/%v", bodyRead, cause), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					isolateTestConfig(t)
					t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
					calls := 0
					useRewritePolicyTestTransport(t, func(*http.Request) (*http.Response, error) {
						calls++
						if calls == 1 {
							if !bodyRead {
								return nil, cause
							}
							return &http.Response{StatusCode: 200, Body: rewritePolicyRetryBody{cause}}, nil
						}
						return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(rewriteEmptyTestPolicy))}, nil
					})
					client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token"}
					started := time.Now()
					_, err := client.stringRewritePolicy(t.Context())
					retryable := cause == syscall.ECONNRESET || cause == io.ErrUnexpectedEOF || cause == context.DeadlineExceeded
					var dns *net.DNSError
					retryable = retryable || errors.As(cause, &dns) && dns.IsTimeout
					if retryable {
						if err != nil || calls != 2 {
							t.Fatalf("retry err=%v calls=%d", err, calls)
						}
					} else {
						class, status := rewritePolicyTransportClass(cause), 0
						if bodyRead {
							class, status = rewritePolicyResponseRead, 200
						}
						requireRewritePolicyDiagnostic(t, err, class, status, "", started, "synthetic-transport-secret")
						if calls != 1 {
							t.Fatalf("permanent error retried: %d", calls)
						}
					}
				})
			})
		}
	}
}

func TestStringRewritePolicyRetryDeadline(t *testing.T) {
	for _, scenario := range []string{"stalled first attempt", "stalled retry", "stalled last retry", "backoff budget", "cancel backoff", "caller deadline"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if scenario == "cancel backoff" {
					go func() { time.Sleep(100 * time.Millisecond); cancel() }()
				} else if scenario == "caller deadline" {
					var deadlineCancel context.CancelFunc
					ctx, deadlineCancel = context.WithTimeout(ctx, 100*time.Millisecond)
					defer deadlineCancel()
				}
				calls := 0
				started := time.Now()
				useRewritePolicyTestTransport(t, func(r *http.Request) (*http.Response, error) {
					calls++
					deadline, ok := r.Context().Deadline()
					limit := 30 * time.Second
					if calls > 1 {
						limit = 6 * time.Second
					}
					wantDeadline := time.Now().Add(limit)
					if parentDeadline, ok := ctx.Deadline(); ok && parentDeadline.Before(wantDeadline) {
						wantDeadline = parentDeadline
					}
					if !ok || !deadline.Equal(wantDeadline) {
						t.Fatalf("attempt %d deadline=%s, want %s", calls, deadline, wantDeadline)
					}
					if scenario == "stalled first attempt" || scenario == "stalled retry" && calls > 1 || scenario == "stalled last retry" && calls == 3 {
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					retryAfter := "3"
					if scenario == "stalled last retry" {
						retryAfter = "2"
					}
					return &http.Response{StatusCode: 503, Header: http.Header{"Retry-After": {retryAfter}}, Body: io.NopCloser(strings.NewReader(""))}, nil
				})
				client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token"}
				_, err := client.stringRewritePolicy(ctx)
				class, status, wantCalls, elapsed := rewritePolicyHTTPStatus, 503, 2, 6*time.Second
				switch scenario {
				case "stalled first attempt":
					class, status, wantCalls, elapsed = rewritePolicyTimeoutClass, 0, 1, 30*time.Second
				case "stalled retry":
					class, status, elapsed = rewritePolicyTimeoutClass, 0, 9*time.Second
				case "stalled last retry":
					class, status, wantCalls, elapsed = rewritePolicyTimeoutClass, 0, 3, 10*time.Second
				case "cancel backoff", "caller deadline":
					wantCalls, elapsed = 1, 100*time.Millisecond
				}
				requireRewritePolicyDiagnostic(t, err, class, status, "", started)
				if calls != wantCalls || time.Since(started) != elapsed {
					t.Fatalf("calls=%d elapsed=%s", calls, time.Since(started))
				}
			})
		})
	}
}

func TestStringRewritePolicySlowFirstAttempt(t *testing.T) {
	for _, code := range []int{200, 500} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				isolateTestConfig(t)
				t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
				delay := 8 * time.Second
				if code == 500 {
					delay = 7 * time.Second
				}
				calls := 0
				useRewritePolicyTestTransport(t, func(r *http.Request) (*http.Response, error) {
					calls++
					deadline, ok := r.Context().Deadline()
					if !ok || deadline.Sub(time.Now()) != 30*time.Second {
						t.Fatal("initial policy timeout changed")
					}
					select {
					case <-time.After(delay):
						return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(rewriteEmptyTestPolicy))}, nil
					case <-r.Context().Done():
						return nil, r.Context().Err()
					}
				})
				client := ghRelayClient{baseURL: "https://synthetic.invalid", token: "synthetic-token"}
				started := time.Now()
				_, err := client.stringRewritePolicy(t.Context())
				if code == 200 {
					if err != nil {
						t.Fatalf("slow healthy policy failed: %v", err)
					}
				} else {
					requireRewritePolicyDiagnostic(t, err, rewritePolicyHTTPStatus, 500, "", started)
					if !terminalRelayFailure(err) {
						t.Fatal("slow failed policy was not terminal")
					}
				}
				if calls != 1 || time.Since(started) != delay {
					t.Fatalf("calls=%d elapsed=%s, want one attempt lasting %s", calls, time.Since(started), delay)
				}
			})
		})
	}
}
