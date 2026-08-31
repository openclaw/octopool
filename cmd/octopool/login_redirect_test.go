package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLoginRedirects(t *testing.T) {
	const githubToken = "synthetic-github-token"
	const loginJSON = `{"caller":{"github_login":"alice","pool":"core","client_name":"test-mac"},"token":"synthetic-caller-token"}`
	for _, code := range []int{307, 308} {
		for _, destination := range []string{"direct", "same-origin", "cross-port", "cross-host", "downgrade", "same-origin-then-cross-port", "trusted-discovery", "trusted-discovery-same-origin", "insecure-opt-in"} {
			t.Run(strconv.Itoa(code)+"/"+destination, func(t *testing.T) {
				isolateTestConfig(t)
				t.Setenv("GH_TOKEN", githubToken)
				t.Setenv("GITHUB_TOKEN", "")
				t.Setenv("OCTOPOOL_POOL", "")
				t.Setenv("OCTOPOOL_ALLOW_INSECURE_LOGIN", "")
				t.Setenv("OCTOPOOL_GH_PATH", filepath.Join(t.TempDir(), "must-not-run-gh"))
				if destination == "insecure-opt-in" {
					t.Setenv("OCTOPOOL_ALLOW_INSECURE_LOGIN", "1")
				}
				var targetProbe redirectProbe
				target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					targetProbe.observe(r, githubToken)
					_, _ = io.WriteString(w, loginJSON)
				}))
				defer target.Close()
				redirectURL := target.URL + "/capture?github_token=" + githubToken
				if destination == "cross-host" {
					redirectURL = strings.Replace(redirectURL, "127.0.0.1", "localhost", 1)
				}
				var loginRequests atomic.Int32
				var api *httptest.Server
				api = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/.well-known/octopool" {
						writeRedirectTestDiscovery(w, api.URL)
						return
					}
					loginRequests.Add(1)
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || r.Method != http.MethodPost || body["github_token"] != githubToken || body["pool"] != "core" || body["client_name"] != "test-mac" {
						t.Error("login did not preserve its POST body")
						http.Error(w, "unexpected login body", http.StatusBadRequest)
						return
					}
					if destination == "direct" || r.URL.Path == "/complete" {
						_, _ = io.WriteString(w, loginJSON)
						return
					}
					location := redirectURL
					if destination == "same-origin" || destination == "trusted-discovery-same-origin" {
						location = "/complete"
					} else if destination == "same-origin-then-cross-port" && r.URL.Path == "/v1/login/github-cli" {
						location = "/middle"
					}
					http.Redirect(w, r, location, code)
				}))
				if destination == "downgrade" || destination == "insecure-opt-in" {
					api.StartTLS()
				} else {
					api.Start()
				}
				defer api.Close()
				useHTTPTestTransport(t, api.Client().Transport)
				args := []string{api.URL, "--client", "test-mac"}
				if strings.HasPrefix(destination, "trusted-discovery") {
					discovery := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Header.Get("Authorization") != "" || r.Method != http.MethodGet {
							t.Error("discovery received credentials or an unexpected method")
						}
						writeRedirectTestDiscovery(w, api.URL)
					}))
					defer discovery.Close()
					args[0] = discovery.URL
					args = append(args, "--trust-discovery-redirect")
				}

				var stdout bytes.Buffer
				err := runLogin(t.Context(), args, &stdout)
				if destination == "direct" || destination == "same-origin" || destination == "trusted-discovery-same-origin" {
					if err != nil {
						t.Fatal(err)
					}
					auth, err := loadAuth()
					if err != nil || auth.URL != api.URL || auth.Token != "synthetic-caller-token" || auth.Pool != "core" || auth.Client != "test-mac" || auth.Login != "alice" {
						t.Fatalf("login did not save the expected auth: %v", err)
					}
					if !strings.Contains(stdout.String(), "logged in to "+api.URL) {
						t.Error("missing successful login output")
					}
				} else {
					requireBlockedRedirect(t, err, &targetProbe, githubToken, "synthetic-caller-token")
					if stdout.Len() != 0 {
						t.Error("rejected login printed success output")
					}
					authFilePath, pathErr := authPath()
					if pathErr != nil {
						t.Fatal(pathErr)
					}
					if _, statErr := os.Stat(authFilePath); !os.IsNotExist(statErr) {
						t.Errorf("rejected login wrote auth: stat error=%v", statErr)
					}
				}
				wantRequests := int32(1)
				if destination == "same-origin" || destination == "same-origin-then-cross-port" || destination == "trusted-discovery-same-origin" {
					wantRequests = 2
				}
				if got := loginRequests.Load(); got != wantRequests {
					t.Errorf("login requests = %d, want %d", got, wantRequests)
				}
			})
		}
	}
}

func writeRedirectTestDiscovery(w http.ResponseWriter, apiBase string) {
	_ = json.NewEncoder(w).Encode(map[string]any{
		"service": "octopool", "version": 1, "api_base": apiBase, "default_pool": "core",
		"auth": map[string]bool{"cli_github_token": true},
	})
}

func TestLoginDiscoveryHTTPRedirect(t *testing.T) {
	isolateTestConfig(t)
	var targetRequests atomic.Int32
	var discoveryURL string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetRequests.Add(1)
		if r.Header.Get("Authorization") != "" || r.Method != http.MethodGet {
			t.Error("discovery redirect received credentials or an unexpected method")
		}
		writeRedirectTestDiscovery(w, discoveryURL)
	}))
	defer target.Close()
	discovery := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer discovery.Close()
	discoveryURL = discovery.URL
	resolved, err := discoverLoginServer(t.Context(), discovery.URL, "core", false)
	if err != nil || resolved.APIBase != discovery.URL || targetRequests.Load() != 1 {
		t.Fatalf("discovery redirect: error=%v, target requests=%d", err, targetRequests.Load())
	}
}

func TestLoginMalformedRedirects(t *testing.T) {
	const token = "synthetic-github-token"
	for _, code := range []int{307, 308} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			isolateTestConfig(t)
			t.Setenv("GH_TOKEN", token)
			t.Setenv("GITHUB_TOKEN", "")
			t.Setenv("OCTOPOOL_POOL", "")
			t.Setenv("OCTOPOOL_GH_PATH", filepath.Join(t.TempDir(), "must-not-run-gh"))
			var targetProbe redirectProbe
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				targetProbe.observe(r, token)
			}))
			defer target.Close()
			var loginRequests atomic.Int32
			var api *httptest.Server
			api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/.well-known/octopool" {
					writeRedirectTestDiscovery(w, api.URL)
					return
				}
				loginRequests.Add(1)
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || r.Method != http.MethodPost || body["github_token"] != token {
					t.Error("origin did not receive the login credential")
					http.Error(w, "unexpected login body", http.StatusBadRequest)
					return
				}
				w.Header().Set("Location", target.URL+"/%zz/"+body["github_token"])
				w.WriteHeader(code)
			}))
			defer api.Close()
			var stdout bytes.Buffer
			err := runLogin(t.Context(), []string{api.URL, "--client", "test-mac"}, &stdout)
			requireBlockedRedirect(t, err, &targetProbe, token)
			if stdout.Len() != 0 || loginRequests.Load() != 1 {
				t.Errorf("rejected login: output bytes=%d, login requests=%d", stdout.Len(), loginRequests.Load())
			}
			authFilePath, err := authPath()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(authFilePath); !os.IsNotExist(err) {
				t.Errorf("rejected login wrote auth: stat error=%v", err)
			}
		})
	}
}
