package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type prCheckReadResult struct {
	err            error
	stdout, stderr string
}

func startPRCheckRead(ctx context.Context, args []string) <-chan prCheckReadResult {
	done := make(chan prCheckReadResult, 1)
	go func() {
		defer close(done)
		var stdout, stderr bytes.Buffer
		err := runGH(ctx, args, &stdout, &stderr)
		done <- prCheckReadResult{err, stdout.String(), stderr.String()}
	}()
	return done
}

func prCheckReadTransport(t *testing.T, respond func(*http.Request, map[string]any) (*http.Response, error)) *atomic.Int64 {
	t.Helper()
	_, policies := rewriteTestServer(t, rewriteEmptyTestPolicy, nil)
	t.Setenv("OCTOPOOL_NO_FALLBACK", "")
	original := http.DefaultTransport
	useRewritePolicyTestTransport(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/github/request" {
			return original.RoundTrip(request)
		}
		defer request.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			return nil, err
		}
		return respond(request, body)
	})
	return policies
}

func prCheckReadResponse(t *testing.T, body any) *http.Response {
	t.Helper()
	w := httptest.NewRecorder()
	writeCLIEnvelope(t, w, body)
	return w.Result()
}

func TestPRCheckCollectionsOverlap(t *testing.T) {
	for _, command := range []string{"checks", "view"} {
		t.Run(command, func(t *testing.T) {
			f := newPRChecksFixture()
			f.checks[0].(map[string]any)["app"] = map[string]any{"id": 999, "slug": "third-party"}
			f.statuses = []any{map[string]any{"id": 2, "context": "legacy", "state": "success"}}
			entered := make(chan string, 2)
			release := make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			policies := prCheckReadTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
				path := body["path"].(string)
				if strings.HasSuffix(path, "/check-runs") || strings.HasSuffix(path, "/status") {
					entered <- path
					select {
					case <-release:
					case <-request.Context().Done():
						return nil, request.Context().Err()
					}
				}
				return prCheckReadResponse(t, f.response(t, body)), nil
			})
			field := "name"
			if command == "view" {
				field = "statusCheckRollup"
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			done := startPRCheckRead(ctx, []string{"pr", command, "7", "-R", "acme/repo", "--json", field})
			defer func() { cancel(); unblock(); <-done }()
			seen := map[string]bool{}
			for range 2 {
				select {
				case path := <-entered:
					seen[path] = true
				case <-ctx.Done():
					t.Fatal("check-runs and statuses did not overlap")
				}
			}
			if len(seen) != 2 {
				t.Fatalf("expected two independent collections, got %v", seen)
			}
			unblock()
			result := <-done
			if result.err != nil || result.stderr != "" {
				t.Fatalf("read failed: %+v", result)
			}
			if command == "checks" {
				if result.stdout != "[{\"name\":\"unit\"},{\"name\":\"legacy\"}]\n" {
					t.Fatalf("checks output changed: %s", result.stdout)
				}
			} else {
				var resultBody map[string][]map[string]any
				if err := json.Unmarshal([]byte(result.stdout), &resultBody); err != nil {
					t.Fatal(err)
				}
				rows := resultBody["statusCheckRollup"]
				if len(rows) != 2 || rows[0]["__typename"] != "CheckRun" || rows[0]["name"] != "unit" || rows[1]["__typename"] != "StatusContext" || rows[1]["context"] != "legacy" {
					t.Fatalf("rollup lost check-before-status order: %s", result.stdout)
				}
			}
			if policies.Load() != int64(1+len(f.requests)) || f.calls("/check-runs") != 1 || f.calls("/status") != 1 {
				t.Fatalf("policy/data budget changed: policies=%d data=%v", policies.Load(), f.requests)
			}
		})
	}
}

func TestPRCheckCollectionsStatusDenialOverridesCheckFailure(t *testing.T) {
	for _, failure := range []string{"fallback", "decode"} {
		t.Run(failure, func(t *testing.T) {
			f := newPRChecksFixture()
			checksReturned := make(chan struct{})
			prCheckReadTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
				switch path := body["path"].(string); {
				case strings.HasSuffix(path, "/check-runs"):
					defer close(checksReturned)
					var value any = map[string]any{"total_count": 1, "check_runs": []any{}}
					if failure == "decode" {
						value = []any{}
					}
					return prCheckReadResponse(t, value), nil
				case strings.HasSuffix(path, "/status"):
					select {
					case <-checksReturned:
					case <-request.Context().Done():
						return nil, request.Context().Err()
					}
					return &http.Response{StatusCode: http.StatusForbidden, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"string_rewrite_denied"}}`))}, nil
				default:
					return prCheckReadResponse(t, f.response(t, body)), nil
				}
			})
			capture := captureRewriteGH(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var stdout, stderr bytes.Buffer
			err := runGH(ctx, []string{"pr", "checks", "7", "-R", "acme/repo", "--json", "name"}, &stdout, &stderr)
			var relay *relayResponseError
			if !errors.As(err, &relay) || relay.Status != http.StatusForbidden || relay.Code != "string_rewrite_denied" || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("status denial was hidden: err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("status denial started native gh")
			}
		})
	}
}

func TestPRCheckCollectionsCancelAndJoin(t *testing.T) {
	for _, mode := range []string{"checks-denial", "caller"} {
		t.Run(mode, func(t *testing.T) {
			f := newPRChecksFixture()
			started := make(chan struct{}, 2)
			canceled := make(chan struct{}, 2)
			release := make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			var settled atomic.Int64
			prCheckReadTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
				path := body["path"].(string)
				if !strings.HasSuffix(path, "/check-runs") && !strings.HasSuffix(path, "/status") {
					return prCheckReadResponse(t, f.response(t, body)), nil
				}
				if mode == "checks-denial" && strings.HasSuffix(path, "/check-runs") {
					select {
					case <-started:
					case <-request.Context().Done():
						return nil, request.Context().Err()
					}
					return &http.Response{StatusCode: http.StatusUnauthorized, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_auth"}}`))}, nil
				}
				started <- struct{}{}
				<-request.Context().Done()
				canceled <- struct{}{}
				<-release
				settled.Add(1)
				return nil, request.Context().Err()
			})
			capture := captureRewriteGH(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			done := make(chan prCheckReadResult, 1)
			var settledAtReturn int64
			go func() {
				defer close(done)
				var stdout, stderr bytes.Buffer
				err := runGH(ctx, []string{"pr", "checks", "7", "-R", "acme/repo", "--json", "name"}, &stdout, &stderr)
				settledAtReturn = settled.Load()
				done <- prCheckReadResult{err, stdout.String(), stderr.String()}
			}()
			defer func() { cancel(); unblock(); <-done }()
			wantCanceled := 1
			if mode == "caller" {
				wantCanceled = 2
				for range 2 {
					select {
					case <-started:
					case <-ctx.Done():
						t.Fatal("both collectors did not start before caller cancellation")
					}
				}
				cancel()
			}
			for range wantCanceled {
				select {
				case <-canceled:
				case <-time.After(5 * time.Second):
					t.Fatal("collector cancellation did not reach the transport")
				}
			}
			select {
			case result := <-done:
				t.Fatalf("command returned before collectors settled: %+v", result)
			default:
			}
			unblock()
			result := <-done
			if settledAtReturn != int64(wantCanceled) || result.stdout != "" || result.stderr != "" {
				t.Fatalf("canceled acquisition leaked work or output: settled=%d result=%+v", settledAtReturn, result)
			}
			if mode == "checks-denial" {
				var relay *relayResponseError
				if !errors.As(result.err, &relay) || relay.Status != http.StatusUnauthorized || relay.Code != "invalid_auth" {
					t.Fatalf("initiating denial was replaced: %v", result.err)
				}
			} else if !errors.Is(result.err, context.Canceled) {
				t.Fatalf("caller cancellation was replaced: %v", result.err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("canceled acquisition started native gh")
			}
		})
	}
}

type prCheckCanceledPolicyBody struct{ ctx context.Context }

func (body prCheckCanceledPolicyBody) Read([]byte) (int, error) {
	<-body.ctx.Done()
	return 0, body.ctx.Err()
}

func (prCheckCanceledPolicyBody) Close() error { return nil }

func TestPRCheckCollectionsKeepDenialBeforePolicyCancellation(t *testing.T) {
	for _, mode := range []string{"transport", "body"} {
		t.Run(mode, func(t *testing.T) {
			f := newPRChecksFixture()
			policyStarted := make(chan struct{})
			prCheckReadTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
				if strings.HasSuffix(body["path"].(string), "/pulls/7") {
					return prCheckReadResponse(t, f.response(t, body)), nil
				}
				select {
				case <-policyStarted:
				case <-request.Context().Done():
					return nil, request.Context().Err()
				}
				return &http.Response{StatusCode: http.StatusUnauthorized, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_auth"}}`))}, nil
			})
			transport := http.DefaultTransport
			var policies atomic.Int64
			useRewritePolicyTestTransport(t, func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/string-rewrites") && policies.Add(1) == 4 {
					// The other collection has passed its policy; this one must be
					// canceled without replacing that collection's observed denial.
					close(policyStarted)
					if mode == "body" {
						return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: prCheckCanceledPolicyBody{request.Context()}}, nil
					}
					<-request.Context().Done()
					return nil, request.Context().Err()
				}
				return transport.RoundTrip(request)
			})
			capture := captureRewriteGH(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var stdout, stderr bytes.Buffer
			err := runGH(ctx, []string{"pr", "checks", "7", "-R", "acme/repo", "--json", "name"}, &stdout, &stderr)
			var relay *relayResponseError
			if !errors.As(err, &relay) || relay.Status != http.StatusUnauthorized || relay.Code != "invalid_auth" || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("policy cancellation replaced denial: err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("policy cancellation started native gh")
			}
		})
	}
}
