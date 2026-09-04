package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type quotaNoticeWriter struct {
	bytes.Buffer
	stdout *bytes.Buffer
	t      *testing.T
}

func (writer *quotaNoticeWriter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte(ghRelayQuotaNotice)) && writer.stdout.String() != "{\"remaining\":42}\n" {
		writer.t.Error("quota notice preceded successful body output")
	}
	return writer.Buffer.Write(p)
}
func (writer *quotaNoticeWriter) WriteString(s string) (int, error) { return writer.Write([]byte(s)) }

func TestGHRelayQuotaNotice(t *testing.T) {
	for _, mode := range []string{"success", "leading_slash", "paginate", "pagination_fallback", "output_failure", "newline_failure", "short_write", "github_error", "relay_error", "fallback", "native_include", "other_path"} {
		t.Run(mode, func(t *testing.T) {
			data := 0
			rewriteTestServer(t, rewriteEmptyTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				data++
				switch mode {
				case "relay_error":
					w.WriteHeader(401)
				case "fallback":
					writeCLIFallback(t, w, "unsupported_route")
				case "github_error":
					writeRawCLIEnvelope(t, w, 403, "json", map[string]any{"message": "synthetic failure"})
				case "paginate":
					_ = json.NewEncoder(w).Encode(relayEnvelope{Status: 200, Body: json.RawMessage(`{"remaining":42}`), BodyEncoding: "json", Headers: map[string]string{"link": ""}})
				default:
					writeCLIEnvelope(t, w, map[string]any{"remaining": 42})
				}
			})
			capturePath := captureRewriteGH(t)
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			args := []string{"api", "rate_limit"}
			if mode == "leading_slash" {
				args[1] = "/rate_limit"
			}
			if mode == "other_path" {
				args[1] = "user"
			}
			if mode == "native_include" {
				args = append(args, "--include")
			}
			if mode == "paginate" || mode == "pagination_fallback" {
				args = append(args, "--paginate")
			}
			var stdout bytes.Buffer
			stderr := &quotaNoticeWriter{stdout: &stdout, t: t}
			var output io.Writer = &stdout
			if mode == "output_failure" {
				output = mergeFailWriter{}
			}
			if mode == "newline_failure" || mode == "short_write" {
				output = quotaEdgeWriter{short: mode == "short_write"}
			}
			err := runGH(t.Context(), args, output, stderr)
			wantNotice := mode == "success" || mode == "leading_slash" || mode == "paginate"
			if strings.Count(stderr.String(), ghRelayQuotaNotice) != map[bool]int{false: 0, true: 1}[wantNotice] {
				t.Fatal("quota notice escaped successful relay boundary")
			}
			wantError := mode == "output_failure" || mode == "github_error" || mode == "relay_error"
			if (err != nil) != wantError {
				t.Fatalf("unexpected result: %v", err)
			}
			if wantNotice || mode == "other_path" {
				if stdout.String() != "{\"remaining\":42}\n" {
					t.Fatal("relay JSON changed")
				}
			}
			_, childErr := os.Stat(capturePath)
			wantChild := mode == "fallback" || mode == "native_include" || mode == "pagination_fallback"
			if (childErr == nil) != wantChild || data != map[bool]int{false: 1, true: 0}[mode == "native_include"] {
				t.Fatal("quota routing changed")
			}
		})
	}
}

func TestGHRelayQuotaNoticeSavedLogin(t *testing.T) {
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	for _, key := range []string{"OCTOPOOL_TOKEN", "OCTOPOOL_URL", "OCTOPOOL_POOL"} {
		t.Setenv(key, "")
	}
	policies, health := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/pools/maintainers/string-rewrites":
			policies++
			_, _ = io.WriteString(w, rewriteEmptyTestPolicy)
		case "/v1/pools/maintainers/health":
			health++
			w.WriteHeader(200)
		default:
			t.Error("saved login shortcut made a data request")
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	if err := saveAuth(authFile{URL: server.URL, Pool: "maintainers", Token: "synthetic", Login: "synthetic", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	capturePath := captureRewriteGH(t)
	var stdout, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"api", "user", "--jq", ".login"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != "synthetic\n" || stderr.Len() != 0 || policies != 1 || health != 1 {
		t.Fatal("saved login shortcut acquired quota chatter or data reads")
	}
	if _, err := os.Stat(capturePath); !os.IsNotExist(err) {
		t.Fatal("saved login shortcut ran a child")
	}
}

type quotaEdgeWriter struct{ short bool }

func (writer quotaEdgeWriter) Write(p []byte) (int, error) {
	if writer.short {
		return len(p) - 1, nil
	}
	if string(p) == "\n" {
		return 0, errMergeWriter
	}
	return len(p), nil
}
