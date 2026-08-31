package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func useHTTPTestTransport(t *testing.T, transport http.RoundTripper) {
	t.Helper()
	original := httpClient
	client := *original
	client.Transport = transport
	httpClient = &client
	t.Cleanup(func() { httpClient = original })
}

type redirectProbe struct {
	requests    atomic.Int32
	credentials atomic.Int32
}

func (probe *redirectProbe) observe(r *http.Request, token string) {
	probe.requests.Add(1)
	body, _ := io.ReadAll(r.Body)
	if strings.Contains(r.Header.Get("Authorization"), token) || strings.Contains(string(body), token) {
		probe.credentials.Add(1)
	}
}

func requireBlockedRedirect(t *testing.T, err error, probe *redirectProbe, secrets ...string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Errorf("expected a redirect error, got %v", err)
	}
	if err != nil {
		for _, secret := range secrets {
			if strings.Contains(err.Error(), secret) {
				t.Error("redirect error exposed a credential")
			}
		}
	}
	if requests, credentials := probe.requests.Load(), probe.credentials.Load(); requests != 0 || credentials != 0 {
		t.Errorf("redirect target received %d requests, %d with credentials; want zero", requests, credentials)
	}
}

func TestAuthenticatedJSONRedirects(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, code := range []int{301, 302, 303, 307, 308} {
			for _, destination := range []string{"direct", "same-origin", "cross-port", "cross-host", "downgrade", "same-origin-then-cross-port"} {
				t.Run(method+"/"+strconv.Itoa(code)+"/"+destination, func(t *testing.T) {
					isolateTestConfig(t)
					token := "synthetic-caller-token"
					if method == http.MethodPost {
						token = "synthetic-admin-token"
					}
					var targetProbe, originProbe redirectProbe
					target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						targetProbe.observe(r, token)
						_, _ = io.WriteString(w, `{"ok":true}`)
					}))
					defer target.Close()
					redirectURL := target.URL + "/capture?token=" + token
					if destination == "cross-host" {
						redirectURL = strings.Replace(redirectURL, "127.0.0.1", "localhost", 1)
					}
					origin := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Header.Get("Authorization") != "Bearer "+token {
							t.Error("origin did not receive expected bearer credential")
						}
						body, _ := io.ReadAll(r.Body)
						wantMethod := method
						if r.URL.Path != "/start" && code < 307 {
							wantMethod = http.MethodGet
						}
						if r.Method != wantMethod || (wantMethod == http.MethodPost && string(body) != `{"payload":"synthetic-body"}`) {
							t.Error("origin request method or body changed unexpectedly")
						}
						originProbe.requests.Add(1)
						if destination == "direct" || r.URL.Path == "/final" {
							_, _ = io.WriteString(w, `{"ok":true}`)
							return
						}
						location := redirectURL
						if destination == "same-origin" {
							location = "/final"
						} else if destination == "same-origin-then-cross-port" && r.URL.Path == "/start" {
							location = "/middle"
						}
						http.Redirect(w, r, location, code)
					}))
					if destination == "downgrade" {
						origin.StartTLS()
					} else {
						origin.Start()
					}
					defer origin.Close()
					useHTTPTestTransport(t, origin.Client().Transport)

					var response *http.Response
					var err error
					if method == http.MethodGet {
						response, err = getJSONRaw(t.Context(), origin.URL+"/start", token)
					} else {
						response, err = postJSONRaw(t.Context(), origin.URL+"/start", token, map[string]any{"payload": "synthetic-body"})
					}
					if response != nil {
						defer response.Body.Close()
					}
					if destination == "direct" || destination == "same-origin" {
						if err != nil {
							t.Fatal(err)
						}
						body, err := io.ReadAll(response.Body)
						if err != nil || response.StatusCode != http.StatusOK || string(body) != `{"ok":true}` {
							t.Fatalf("unexpected success response: status=%d, read error=%v", response.StatusCode, err)
						}
					} else {
						requireBlockedRedirect(t, err, &targetProbe, token, "synthetic-body")
					}
					wantRequests := int32(1)
					if destination == "same-origin" || destination == "same-origin-then-cross-port" {
						wantRequests = 2
					}
					if got := originProbe.requests.Load(); got != wantRequests {
						t.Errorf("origin requests = %d, want %d", got, wantRequests)
					}
				})
			}
		}
	}
}

func TestAuthenticatedJSONRedirectEffectiveOrigin(t *testing.T) {
	for _, scheme := range []string{"http", "https"} {
		for _, explicitFirst := range []bool{false, true} {
			t.Run(scheme+"/explicit-first="+strconv.FormatBool(explicitFirst), func(t *testing.T) {
				isolateTestConfig(t)
				host, port := "LOCALHOST", "80"
				if scheme == "https" {
					host, port = "127.0.0.1", "443"
				}
				first, next := scheme+"://"+host, scheme+"://"+strings.ToLower(host)+":"+port
				if explicitFirst {
					first, next = next, first
				}
				var requests atomic.Int32
				server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					if r.Header.Get("Authorization") != "Bearer synthetic-token" {
						t.Error("same-origin request lost its credential")
					}
					if r.URL.Path == "/start" {
						http.Redirect(w, r, next+"/final", http.StatusTemporaryRedirect)
						return
					}
					_, _ = io.WriteString(w, `{"ok":true}`)
				}))
				if scheme == "https" {
					server.StartTLS()
				} else {
					server.Start()
				}
				defer server.Close()
				transport := server.Client().Transport.(*http.Transport).Clone()
				transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
				}
				defer transport.CloseIdleConnections()
				useHTTPTestTransport(t, transport)
				response, err := getJSONRaw(t.Context(), first+"/start", "synthetic-token")
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				if response.StatusCode != http.StatusOK || requests.Load() != 2 {
					t.Fatalf("status=%d, requests=%d", response.StatusCode, requests.Load())
				}
			})
		}
	}
}

func TestAuthenticatedJSONRedirectLimit(t *testing.T) {
	isolateTestConfig(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Redirect(w, r, "/loop", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	_, err := getJSONRaw(t.Context(), server.URL, "synthetic-token")
	if err == nil || !strings.Contains(err.Error(), "10 redirects") || requests.Load() != 10 {
		t.Fatalf("redirect loop: error=%v, requests=%d", err, requests.Load())
	}
}

func TestAuthenticatedJSONMalformedRedirects(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, code := range []int{307, 308} {
			for _, location := range []string{"token-escape", "token-port", "nonsecret", "same-origin-then-malformed"} {
				t.Run(method+"/"+strconv.Itoa(code)+"/"+location, func(t *testing.T) {
					isolateTestConfig(t)
					token := "synthetic-caller-token"
					if method == http.MethodPost {
						token = "synthetic-admin-token"
					}
					var targetProbe redirectProbe
					target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						targetProbe.observe(r, token)
						_, _ = io.WriteString(w, `{"ok":true}`)
					}))
					defer target.Close()
					var originRequests atomic.Int32
					origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						originRequests.Add(1)
						if r.Method != method || r.Header.Get("Authorization") != "Bearer "+token {
							t.Error("origin did not receive the authenticated request")
						}
						reflected := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
						value := target.URL + "/%zz/" + reflected
						switch location {
						case "token-port":
							value = target.URL + ":" + reflected + "/capture"
						case "nonsecret":
							value = target.URL + "/%zz/nonsecret"
						case "same-origin-then-malformed":
							if r.URL.Path == "/start" {
								value = "/middle?token=" + reflected
							}
						}
						w.Header().Set("Location", value)
						w.WriteHeader(code)
					}))
					defer origin.Close()
					var response *http.Response
					var err error
					if method == http.MethodGet {
						response, err = getJSONRaw(t.Context(), origin.URL+"/start", token)
					} else {
						response, err = postJSONRaw(t.Context(), origin.URL+"/start", token, map[string]any{"payload": "synthetic-body"})
					}
					if response != nil {
						response.Body.Close()
						t.Error("malformed redirect returned a response")
					}
					requireBlockedRedirect(t, err, &targetProbe, token, "synthetic-body")
					wantRequests := int32(1)
					if location == "same-origin-then-malformed" {
						wantRequests = 2
					}
					if originRequests.Load() != wantRequests {
						t.Errorf("origin requests = %d, want %d", originRequests.Load(), wantRequests)
					}
				})
			}
		}
	}
}

func TestAuthenticatedJSONIgnoresUnusedLocations(t *testing.T) {
	for _, code := range []int{200, 300, 304, 307, 308} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			isolateTestConfig(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if code < 307 {
					w.Header().Set("Location", "/%zz/nonsecret")
				}
				w.WriteHeader(code)
			}))
			defer server.Close()
			response, err := getJSONRaw(t.Context(), server.URL, "synthetic-token")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != code {
				t.Errorf("status = %d, want %d", response.StatusCode, code)
			}
		})
	}
}

func TestAuthenticatedJSONRequestErrors(t *testing.T) {
	for _, failure := range []string{"canceled", "deadline", "connection-refused"} {
		t.Run(failure, func(t *testing.T) {
			isolateTestConfig(t)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
			}))
			defer server.Close()
			ctx := t.Context()
			var want error
			switch failure {
			case "canceled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
				want = context.Canceled
			case "deadline":
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer cancel()
				want = context.DeadlineExceeded
			case "connection-refused":
				server.Close()
			}
			_, err := getJSONRaw(ctx, server.URL, "synthetic-token")
			var requestErr *url.Error
			if !errors.As(err, &requestErr) || requestErr.URL != server.URL || requestErr.Op != "Get" {
				t.Fatalf("ordinary request lost its URL error: %v", err)
			}
			if want != nil && (!errors.Is(err, want) || !strings.Contains(err.Error(), want.Error())) {
				t.Errorf("context error lost its cause: %v", err)
			}
			if failure == "deadline" && !requestErr.Timeout() {
				t.Error("deadline error lost its timeout classification")
			}
			if failure == "connection-refused" {
				var networkErr *net.OpError
				if !errors.As(err, &networkErr) || networkErr.Op != "dial" || !strings.Contains(err.Error(), "dial tcp") {
					t.Errorf("transport error lost its network cause: %v", err)
				}
			}
			if requests.Load() != 0 {
				t.Error("failed request unexpectedly reached server")
			}
		})
	}
}

func TestAuthenticatedJSONRedirectRequestErrors(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, code := range []int{307, 308} {
			t.Run(method+"/"+strconv.Itoa(code), func(t *testing.T) {
				isolateTestConfig(t)
				const token = "synthetic-reflected-credential"
				var followed atomic.Bool
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/start" {
						http.Redirect(w, r, "/next?token="+token, code)
						return
					}
					followed.Store(true)
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
				}))
				defer server.Close()
				originalURL := server.URL + "/start"
				var response *http.Response
				var err error
				if method == http.MethodGet {
					response, err = getJSONRaw(t.Context(), originalURL, token)
				} else {
					response, err = postJSONRaw(t.Context(), originalURL, token, map[string]any{"github_token": token})
				}
				if response != nil {
					response.Body.Close()
				}
				if !followed.Load() || err == nil {
					t.Fatal("expected a transport failure after a same-origin redirect")
				}
				if strings.Contains(err.Error(), token) {
					t.Error("redirected request error exposed a reflected credential")
				}
				var requestErr *url.Error
				if !errors.As(err, &requestErr) || requestErr.URL != originalURL || !errors.Is(err, io.EOF) {
					t.Error("redirected request error lost its original URL or transport cause")
				}
			})
		}
	}
}
