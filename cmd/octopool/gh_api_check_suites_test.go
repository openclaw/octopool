package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
)

const suiteAPIPath = "/repos/acme/repo/check-suites/42"

func TestGHAPICheckSuiteReads(t *testing.T) {
	for _, tail := range []string{"", "/check-runs"} {
		for _, headerFlag := range []string{"-H", "--header", "--header=", "-H=", "-Hattached"} {
			t.Run(tail+headerFlag, func(t *testing.T) {
				calls := 0
				body := json.RawMessage(`{"id":42,"status":"completed","name":"CI <checks> & tests"}`)
				if tail != "" {
					body = json.RawMessage(`{"total_count":0,"check_runs":[]}`)
				}
				rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					request := decodeCLIRequest(t, w, r)
					headers, _ := request["headers"].(map[string]any)
					if request["method"] != "GET" || request["path"] != suiteAPIPath+tail || headers["accept"] != "application/vnd.github+json" || headers["x-github-api-version"] != "2022-11-28" || headers["cache-control"] != "max-age=0" {
						t.Errorf("request = %#v", request)
					}
					// Keep upstream JSON order and escaping visible in the byte assertion.
					_, _ = w.Write([]byte(`{"status":200,"body_encoding":"json","body":` + string(body) + `}`))
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				capture := captureRewriteGH(t)
				args := []string{"api", suiteAPIPath + tail, "--method", "GET", "--hostname=github.com"}
				for _, header := range []string{"aCcEpT: application/vnd.github+json", "X-GitHub-Api-Version: 2022-11-28"} {
					if headerFlag == "-Hattached" {
						args = append(args, "-H"+header)
					} else if strings.HasSuffix(headerFlag, "=") {
						args = append(args, headerFlag+header)
					} else {
						args = append(args, headerFlag, header)
					}
				}
				var out bytes.Buffer
				if err := runGH(t.Context(), args, &out, io.Discard); err != nil || calls != 1 || out.String() != string(body) {
					t.Fatalf("err=%v calls=%d out=%q", err, calls, out.String())
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("read delegated to native gh")
				}
			})
		}
	}
}

func TestGHAPICheckSuiteHeaderAndQueryBoundaries(t *testing.T) {
	for _, tail := range []string{"", "/check-runs"} {
		for _, header := range []string{"Accept: application/vnd.github.v3+json", "X-GitHub-Api-Version: 2022-11-28", "If-None-Match: fixture", "If-Modified-Since: Wed, 01 Oct 2025 00:00:00 GMT", "Cache-Control: max-age=60"} {
			req, fallback, err := parseGHAPIArgs([]string{suiteAPIPath + tail, "--header", header})
			if err != nil || fallback || !safeRelayRequest(req) {
				t.Fatalf("header %q: fallback=%v err=%v", header, fallback, err)
			}
		}
		for _, key := range []string{"app_id", "unknown", "ref"} {
			req, _, err := parseGHAPIArgs([]string{suiteAPIPath + tail + "?" + key + "=1"})
			if err != nil || safeRelayRequest(req) {
				t.Fatalf("query %q accepted: %#v %v", key, req, err)
			}
		}
		for _, flags := range [][]string{{"-X", "POST"}, {"-H", "Authorization: fixture"}, {"-H", "X-Unknown: value"}, {"--hostname=example.com"}} {
			_, fallback, err := parseGHAPIArgs(append([]string{suiteAPIPath + tail}, flags...))
			if err != nil || !fallback {
				t.Fatalf("flags %q relayed: fallback=%v err=%v", flags, fallback, err)
			}
		}
	}
	req, fallback, err := parseGHAPIArgs([]string{suiteAPIPath + "/check-runs", "-X", "GET", "-f", "check_name=CI", "-f", "status=completed", "-f", "filter=latest", "-F", "per_page=2", "-F", "page=1"})
	if err != nil || fallback || !safeRelayRequest(req) || len(req.query) != 5 {
		t.Fatalf("documented queries rejected: %#v fallback=%v err=%v", req, fallback, err)
	}
	for _, path := range []string{suiteAPIPath + "?page=1", suiteAPIPath + "/check-runs?filter=all&filter=latest"} {
		req, _, err := parseGHAPIArgs([]string{path})
		if err != nil || safeRelayRequest(req) {
			t.Fatalf("unsupported query accepted: %#v %v", req, err)
		}
	}
}

func TestGHAPICheckSuitePaginationBytes(t *testing.T) {
	for _, links := range []bool{false, true} {
		for _, slurp := range []bool{false, true} {
			t.Run(strings.Join([]string{strconv.FormatBool(links), strconv.FormatBool(slurp)}, "/"), func(t *testing.T) {
				calls := 0
				first := `{"total_count":3,"check_runs":[{"id":7},{"id":8}]}`
				last := `{"total_count":3,"check_runs":[{"id":9}]}`
				relayTestServer(t, func(request map[string]any) any {
					calls++
					query := request["query"].(map[string]any)
					if query["per_page"] != "2" || query["filter"] != "latest" || request["path"] != suiteAPIPath+"/check-runs" {
						t.Errorf("request = %#v", request)
					}
					body := first
					headers := map[string]string{}
					if calls == 1 {
						if query["page"] != "1" {
							t.Errorf("page = %v", query["page"])
						}
						if links {
							headers["link"] = `<https://api.github.com` + suiteAPIPath + `/check-runs?filter=latest&per_page=2&page=2>; rel="next"`
						}
					} else {
						if query["page"] != "2" {
							t.Errorf("page = %v", query["page"])
						}
						body = last
						if links {
							headers["link"] = `<https://api.github.com` + suiteAPIPath + `/check-runs?filter=latest&per_page=2&page=1>; rel="prev"`
						}
					}
					return relayTestResponse{Body: json.RawMessage(body), Headers: headers}
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				args := []string{"api", suiteAPIPath + "/check-runs?per_page=2&filter=latest", "--paginate", "--hostname", "github.com", "--header=Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"}
				want := first + last
				if slurp {
					args = append(args, "--slurp")
					want = "[" + first + "," + last + "]"
				}
				var out bytes.Buffer
				if err := runGH(t.Context(), args, &out, io.Discard); err != nil || out.String() != want || calls != 2 {
					t.Fatalf("err=%v calls=%d out=%q want=%q", err, calls, out.String(), want)
				}
			})
		}
	}
}

func TestGHAPICheckSuiteFallback(t *testing.T) {
	for _, scenario := range []string{"route_denied", "repo_not_public", "changed_total", "empty_early", "link_incomplete", "wrong_shape"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			relayTestServer(t, func(map[string]any) any {
				calls++
				if scenario == "route_denied" || scenario == "repo_not_public" {
					return relayTestResponse{Status: 424, Body: map[string]any{"error": map[string]any{"code": "fallback_local", "details": map[string]any{"reason": scenario}}}}
				}
				body := `{"total_count":2,"check_runs":[{"id":7}]}`
				headers := map[string]string{}
				if calls == 1 && scenario == "changed_total" {
					headers["link"] = `<https://api.github.com` + suiteAPIPath + `/check-runs?per_page=1&page=2>; rel="next"`
				}
				if calls == 1 && scenario == "link_incomplete" {
					headers["link"] = ""
				}
				if calls == 2 {
					switch scenario {
					case "changed_total":
						body = `{"total_count":3,"check_runs":[{"id":8}]}`
					case "empty_early":
						body = `{"total_count":2,"check_runs":[]}`
					case "wrong_shape":
						body = `{"total_count":2,"jobs":[{"id":8}]}`
					}
				}
				return relayTestResponse{Body: json.RawMessage(body), Headers: headers}
			})
			t.Setenv("OCTOPOOL_NO_FALLBACK", "")
			capture := captureRewriteGH(t)
			args := []string{"api", suiteAPIPath + "/check-runs?per_page=1", "--paginate", "--slurp"}
			var out bytes.Buffer
			if err := runGH(t.Context(), args, &out, io.Discard); err != nil {
				t.Fatal(err)
			}
			if got := readRewriteCapture(t, capture); !slices.Equal(got.Args, args) {
				t.Fatalf("fallback args=%q", got.Args)
			}
			if strings.Contains(out.String(), "check_runs") {
				t.Fatalf("partial output before fallback: %q", out.String())
			}
		})
	}
}
