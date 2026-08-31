package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWriteLocalUserLogin(t *testing.T) {
	isolateTestConfig(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/pools/maintainers/health" || request.Header.Get("authorization") != "Bearer op_token" {
			t.Fatalf("unexpected health request: %s auth=%q", request.URL.Path, request.Header.Get("authorization"))
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	if err := saveAuth(authFile{
		URL: server.URL, Pool: "maintainers", Token: "op_token", Login: "alice", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	request := ghAPIRequest{method: "GET", path: "/user", query: map[string]any{}, headers: map[string]string{}, jq: ".login"}
	var out bytes.Buffer
	handled, err := writeLocalUserLogin(t.Context(), request, &out)
	if err != nil || !handled || out.String() != "alice\n" {
		t.Fatalf("handled=%v err=%v out=%q", handled, err, out.String())
	}
}

func TestWriteLocalUserLoginRejectsOverridesAndBroaderShapes(t *testing.T) {
	isolateTestConfig(t)
	if err := saveAuth(authFile{
		URL: "https://octopool.dev", Pool: "maintainers", Token: "op_token", Login: "alice", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	base := ghAPIRequest{method: "GET", path: "/user", query: map[string]any{}, headers: map[string]string{}, jq: ".login"}
	t.Setenv("OCTOPOOL_TOKEN", "override")
	if handled, _ := writeLocalUserLogin(t.Context(), base, &bytes.Buffer{}); handled {
		t.Fatal("token override must not use the stored login")
	}
	t.Setenv("OCTOPOOL_TOKEN", "")
	for _, request := range []ghAPIRequest{
		{method: "GET", path: "/user", query: map[string]any{}, headers: map[string]string{}, jq: ".id"},
		{method: "GET", path: "/user", query: map[string]any{}, headers: map[string]string{"accept": "application/json"}, jq: ".login"},
		{method: "GET", path: "/users/alice", query: map[string]any{}, headers: map[string]string{}, jq: ".login"},
	} {
		if handled, _ := writeLocalUserLogin(t.Context(), request, &bytes.Buffer{}); handled {
			t.Fatalf("broader request was handled: %#v", request)
		}
	}
}

func TestNormalizeClientName(t *testing.T) {
	for input, expected := range map[string]string{
		"clawstudio.local":   "clawstudio",
		"clawstudio.LOCAL":   "clawstudio",
		" clawstudio.local ": "clawstudio",
		"clawstudio":         "clawstudio",
		"local":              "local",
	} {
		if got := normalizeClientName(input); got != expected {
			t.Fatalf("normalizeClientName(%q)=%q want %q", input, got, expected)
		}
	}
}
