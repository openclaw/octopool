package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestRESTPRWriteGrammar(t *testing.T) {
	for _, test := range []struct {
		args []string
		want bool
	}{
		{[]string{"pr", "comment", "7", "-R", "acme/repo", "--body", "hello"}, true},
		{[]string{"pr", "comment", "7", "-Racme/repo", "-F-"}, true},
		{[]string{"pr", "comment", "--body-file=body.md", "7", "--repo=acme/repo"}, true},
		{[]string{"pr", "edit", "7", "-b="}, true},
		{[]string{"pr", "edit", "007", "-F", "-"}, true},
		{[]string{"pr", "close", "7"}, true},
		{[]string{"pr", "close", "7", "--comment", "hello"}, true},
		{[]string{"pr", "close", "7", "-chello", "--repo", "acme/repo"}, true},
		{[]string{"pr", "close", "7", "--comment="}, true},
		{[]string{"pr", "comment", "7"}, false},
		{[]string{"pr", "edit", "7"}, false},
		{[]string{"pr", "edit", "-b", "hello"}, false},
		{[]string{"pr", "comment", "branch", "-b", "hello"}, false},
		{[]string{"pr", "comment", "https://github.com/acme/repo/pull/7", "-b", "hello"}, false},
		{[]string{"pr", "comment", "0", "-b", "hello"}, false},
		{[]string{"pr", "comment", "9999999999999999999999", "-b", "hello"}, false},
		{[]string{"pr", "comment", "7", "8", "-b", "hello"}, false},
		{[]string{"pr", "comment", "7", "--body", "one", "-b", "two"}, false},
		{[]string{"pr", "edit", "7", "--body=one", "-F", "body.md"}, false},
		{[]string{"pr", "edit", "7", "--body=one", "--title=two"}, false},
		{[]string{"pr", "edit", "7", "--body=one", "--add-label=bug"}, false},
		{[]string{"pr", "comment", "7", "-b", "hello", "--edit-last=false"}, false},
		{[]string{"pr", "comment", "7", "-b", "hello", "--attach=pic.png"}, false},
		{[]string{"pr", "comment", "7", "-b", "hello", "--web"}, false},
		{[]string{"pr", "comment", "7", "-b", "hello", "-R", "a/b", "--repo=c/d"}, false},
		{[]string{"pr", "comment", "7", "-b", "hello", "--repo="}, false},
		{[]string{"pr", "comment", "7", "--body-file="}, false},
		{[]string{"pr", "comment", "7", "--body"}, false},
		{[]string{"pr", "close", "7", "--delete-branch=false"}, false},
		{[]string{"pr", "close", "7", "-d"}, false},
		{[]string{"pr", "close", "7", "-b", "hello"}, false},
		{[]string{"pr", "close", "7", "--", "extra"}, false},
		{[]string{"pr", "ready", "7"}, false},
		{[]string{"pr", "create", "-b", "hello"}, false},
		{[]string{"issue", "comment", "7", "-b", "hello"}, false},
	} {
		t.Run(strings.Join(test.args, " "), func(t *testing.T) {
			if _, ok := parseRESTPRWrite(test.args); ok != test.want {
				t.Fatalf("accepted = %v, want %v", ok, test.want)
			}
		})
	}
}

type restWriteTransport func(*http.Request) (*http.Response, error)

func (f restWriteTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type restWriteRequest struct {
	method, path string
	body         map[string]string
}

const restWriteTestToken = "synthetic-native-rest-writer"
const restWritePRJSON = `{"number":7,"html_url":"https://github.com/acme/repo/pull/7","title":"A title","state":"open","merged":false}`
const restWriteCommentJSON = `{"html_url":"https://github.com/acme/repo/pull/7#issuecomment-42"}`

func restWriteFixture(t *testing.T, policy string, handler func(*http.Request) (*http.Response, error)) string {
	t.Helper()
	rewriteTestServer(t, policy, nil)
	capture := captureRewriteGH(t)
	for key, value := range map[string]string{"OCTOPOOL_REST_WRITES": "", "GH_TOKEN": restWriteTestToken, "GITHUB_TOKEN": "wrong-synthetic-token", "GH_HOST": "", "GH_REPO": "", "GH_FORCE_TTY": ""} {
		t.Setenv(key, value)
	}
	previous := http.DefaultTransport
	http.DefaultTransport = restWriteTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.github.com" {
			return previous.RoundTrip(r)
		}
		if r.URL.Scheme != "https" || r.Header.Get("Authorization") != "Bearer "+restWriteTestToken {
			t.Error("incorrect native REST credentials or scheme")
		}
		if r.Header.Get("Accept") != "application/vnd.github+json" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			t.Error("missing REST headers")
		}
		return handler(r)
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	return capture
}

func restWriteResponse(code int, body string) (*http.Response, error) {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
}

func assertNoRESTWriteChild(t *testing.T, capture string) {
	t.Helper()
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatal("native child unexpectedly ran")
	}
}

func TestRESTPRWriteRequestsAndGuard(t *testing.T) {
	for _, policy := range []string{rewriteEmptyTestPolicy, rewriteActiveTestPolicy} {
		for _, command := range []string{"comment", "edit", "close"} {
			for _, source := range []string{"inline", "file", "stdin"} {
				if command == "close" && source != "inline" {
					continue
				}
				t.Run(command+"/"+source+"/"+policy, func(t *testing.T) {
					var requests []restWriteRequest
					capture := restWriteFixture(t, policy, func(r *http.Request) (*http.Response, error) {
						var body map[string]string
						if r.Method != "GET" {
							if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
								t.Fatal(err)
							}
						}
						requests = append(requests, restWriteRequest{r.Method, r.URL.Path, body})
						if r.Method == "POST" {
							return restWriteResponse(201, restWriteCommentJSON)
						}
						if r.Method == "GET" {
							return restWriteResponse(200, restWritePRJSON)
						}
						return restWriteResponse(200, strings.ReplaceAll(restWritePRJSON, `"open"`, `"closed"`))
					})
					args := []string{"pr", command, "7", "-R", "acme/repo"}
					body := "hello internal-model\n@literal \"quoted\""
					var input io.Reader = strings.NewReader("")
					switch source {
					case "inline":
						flag := "-b"
						if command == "close" {
							flag = "-c"
						}
						args = append(args, flag, body)
					case "file":
						path := filepath.Join(t.TempDir(), "body.md")
						if err := os.WriteFile(path, []byte(body), 0600); err != nil {
							t.Fatal(err)
						}
						args = append(args, "-F", path)
					case "stdin":
						args = append(args, "--body-file=-")
						input = strings.NewReader(body)
					}
					var out, stderr bytes.Buffer
					if err := execRealGHWithStdin(t.Context(), args, input, &out, &stderr); err != nil {
						t.Fatalf("%v: %s", err, stderr.String())
					}
					wantBody := body
					if policy == rewriteActiveTestPolicy {
						wantBody = strings.ReplaceAll(body, "internal-model", "public")
					}
					var want []restWriteRequest
					if command != "edit" {
						want = append(want, restWriteRequest{"GET", "/repos/acme/repo/pulls/7", nil})
					}
					if command != "edit" {
						want = append(want, restWriteRequest{"POST", "/repos/acme/repo/issues/7/comments", map[string]string{"body": wantBody}})
					}
					if command != "comment" {
						payload := map[string]string{"body": wantBody}
						if command == "close" {
							payload = map[string]string{"state": "closed"}
						}
						want = append(want, restWriteRequest{"PATCH", "/repos/acme/repo/pulls/7", payload})
					}
					if !reflect.DeepEqual(requests, want) {
						t.Fatalf("requests = %#v; want %#v", requests, want)
					}
					wantOut, wantErr := "https://github.com/acme/repo/pull/7\n", ""
					if command == "comment" {
						wantOut = "https://github.com/acme/repo/pull/7#issuecomment-42\n"
					}
					if command == "close" {
						wantOut, wantErr = "", "✓ Closed pull request acme/repo#7 (A title)\n"
					}
					if out.String() != wantOut || stderr.String() != wantErr {
						t.Fatalf("stdout=%q stderr=%q", out.String(), stderr.String())
					}
					assertNoRESTWriteChild(t, capture)
				})
			}
		}
	}
}

func TestRESTPRCloseStates(t *testing.T) {
	for _, test := range []struct {
		state   string
		merged  bool
		comment string
		wantErr bool
		want    string
		writes  int
	}{
		{"closed", false, "never post", false, "! Pull request acme/repo#7 (A title) is already closed\n", 0},
		{"closed", true, "never post", true, "X Pull request acme/repo#7 (A title) can't be closed because it was already merged\n", 0},
		{"open", false, "", false, "✓ Closed pull request acme/repo#7 (A title)\n", 1},
	} {
		t.Run(fmt.Sprintf("%s/%v", test.state, test.merged), func(t *testing.T) {
			writes := 0
			capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(r *http.Request) (*http.Response, error) {
				if r.Method != "GET" {
					writes++
				}
				state := test.state
				if r.Method == "PATCH" {
					state = "closed"
				}
				return restWriteResponse(200, fmt.Sprintf(`{"number":7,"html_url":"https://github.com/acme/repo/pull/7","title":"A title","state":%q,"merged":%v}`, state, test.merged))
			})
			var out, stderr bytes.Buffer
			err := execRealGHWithStdin(t.Context(), []string{"pr", "close", "7", "-Racme/repo", "-c", test.comment}, nil, &out, &stderr)
			if (err != nil) != test.wantErr || out.Len() != 0 || stderr.String() != test.want || writes != test.writes {
				t.Fatalf("err=%v stdout=%q stderr=%q writes=%d", err, out.String(), stderr.String(), writes)
			}
			assertNoRESTWriteChild(t, capture)
		})
	}
}

func TestRESTPRWriteNeverRetries(t *testing.T) {
	for _, failure := range []string{"404", "422", "500", "unexpected-success", "redirect", "transport", "bad-json", "bad-url", "close-patch"} {
		t.Run(failure, func(t *testing.T) {
			writes := 0
			capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(r *http.Request) (*http.Response, error) {
				if r.Method == "GET" {
					return restWriteResponse(200, restWritePRJSON)
				}
				writes++
				switch failure {
				case "404":
					return restWriteResponse(404, `{"message":"Not Found"}`)
				case "422":
					return restWriteResponse(422, `{"message":"Validation Failed"}`)
				case "500":
					return restWriteResponse(500, `{"message":"`+restWriteTestToken+`"}`)
				case "unexpected-success":
					return restWriteResponse(202, `{}`)
				case "redirect":
					response, _ := restWriteResponse(307, `{}`)
					response.Header.Set("Location", "https://api.github.com/stolen?token="+restWriteTestToken)
					return response, nil
				case "transport":
					return nil, errors.New(restWriteTestToken)
				case "bad-json":
					return restWriteResponse(201, `{`)
				case "bad-url":
					return restWriteResponse(201, `{"html_url":"https://evil.example/`+restWriteTestToken+`"}`)
				case "close-patch":
					if r.Method == "POST" {
						return restWriteResponse(201, restWriteCommentJSON)
					}
					return restWriteResponse(422, `{"message":"Validation Failed"}`)
				}
				panic("unreachable")
			})
			args := []string{"pr", "comment", "7", "-Racme/repo", "-b", "body"}
			wantWrites := 1
			if failure == "close-patch" {
				args = []string{"pr", "close", "7", "-Racme/repo", "-c", "body"}
				wantWrites = 2
			}
			var out, stderr bytes.Buffer
			err := execRealGHWithStdin(t.Context(), args, nil, &out, &stderr)
			var exit exitCodeError
			if !errors.As(err, &exit) || exit.Code != 1 || out.Len() != 0 || stderr.Len() == 0 || writes != wantWrites {
				t.Fatalf("err=%v stdout=%q stderr=%q writes=%d", err, out.String(), stderr.String(), writes)
			}
			if strings.Contains(stderr.String()+fmt.Sprint(err), restWriteTestToken) {
				t.Fatal("token was printed")
			}
			if failure == "422" && stderr.String() != "HTTP 422: Validation Failed (https://api.github.com/repos/acme/repo/issues/7/comments)\n" {
				t.Fatalf("stderr=%q", stderr.String())
			}
			assertNoRESTWriteChild(t, capture)
		})
	}
}

func TestRESTPRWriteNativeBoundaries(t *testing.T) {
	for _, reason := range []string{"kill-switch", "enterprise", "enterprise-repo", "extra-flag", "force-tty", "missing-token", "ambiguous-repo"} {
		t.Run(reason, func(t *testing.T) {
			requests := 0
			capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(*http.Request) (*http.Response, error) { requests++; return nil, errors.New("unexpected REST") })
			args := []string{"pr", "comment", "7", "-Racme/repo", "-b", "body"}
			switch reason {
			case "kill-switch":
				t.Setenv("OCTOPOOL_REST_WRITES", "0")
			case "enterprise":
				t.Setenv("GH_HOST", "enterprise.example")
			case "enterprise-repo":
				args[3] = "-Renterprise.example/acme/repo"
			case "extra-flag":
				args = append(args, "--edit-last")
			case "force-tty":
				t.Setenv("GH_FORCE_TTY", "1")
			case "missing-token":
				t.Setenv("GH_TOKEN", "")
				t.Setenv("GITHUB_TOKEN", "")
				t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", "")
			case "ambiguous-repo":
				t.Chdir(t.TempDir())
				args = []string{"pr", "comment", "7", "-b", "body"}
			}
			var out, stderr bytes.Buffer
			if err := execRealGHWithStdin(t.Context(), args, strings.NewReader("untouched"), &out, &stderr); err != nil {
				t.Fatal(err)
			}
			got := readRewriteCapture(t, capture)
			if requests != 0 || !reflect.DeepEqual(got.Args, args) || got.Stdin != "untouched" {
				t.Fatalf("requests=%d child=%#v", requests, got)
			}
		})
	}
}

func TestRESTPRWriteUsesPreparedSnapshot(t *testing.T) {
	capture := restWriteFixture(t, rewriteActiveTestPolicy, func(r *http.Request) (*http.Response, error) {
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["body"] != "public" {
			t.Fatalf("body=%q", payload["body"])
		}
		return restWriteResponse(200, restWritePRJSON)
	})
	path := filepath.Join(t.TempDir(), "body.md")
	if err := os.WriteFile(path, []byte("internal-model"), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"pr", "edit", "7", "-Racme/repo", "-F", path}
	prepared, err := prepareProtectedGH(t.Context(), args, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.cleanup()
	if err := os.WriteFile(path, []byte("unguarded later content"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	handled, err := execRESTPRWrite(t.Context(), os.Getenv("OCTOPOOL_GH_PATH"), args, prepared, os.Environ(), &out, &stderr)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v stderr=%q", handled, err, stderr.String())
	}
	assertNoRESTWriteChild(t, capture)
}

func TestRESTPRWritePolicyFailureBlocks(t *testing.T) {
	for _, policy := range []string{`invalid`, strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "acme"), strings.ReplaceAll(rewriteActiveTestPolicy, "internal-model", "/issues/")} {
		t.Run(policy, func(t *testing.T) {
			writes := 0
			capture := restWriteFixture(t, policy, func(r *http.Request) (*http.Response, error) {
				if r.Method != "GET" {
					writes++
				}
				return restWriteResponse(200, restWritePRJSON)
			})
			var out, stderr bytes.Buffer
			err := execRealGHWithStdin(t.Context(), []string{"pr", "comment", "7", "-Racme/repo", "-b", "body"}, nil, &out, &stderr)
			if err == nil || writes != 0 {
				t.Fatalf("err=%v writes=%d", err, writes)
			}
			assertNoRESTWriteChild(t, capture)
		})
	}
}

func TestRESTPRWriteNativeTokenPrecedence(t *testing.T) {
	for _, test := range []struct {
		env  []string
		want string
	}{
		{[]string{"GH_TOKEN=first", "GITHUB_TOKEN=second"}, "first"},
		{[]string{"GH_TOKEN=", "GITHUB_TOKEN=second"}, "second"},
		{[]string{"GH_TOKEN=first", "GH_TOKEN=last"}, "last"},
	} {
		got, err := nativeRESTWriteToken(context.Background(), "must-not-execute", test.env)
		if err != nil || got != test.want {
			t.Fatal("native token precedence changed")
		}
	}
}

func TestRESTPRWritePreflightRejectsIssue(t *testing.T) {
	writes := 0
	capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(r *http.Request) (*http.Response, error) {
		if r.Method != "GET" {
			writes++
		}
		return restWriteResponse(404, `{"message":"Not Found"}`)
	})
	var out, stderr bytes.Buffer
	err := execRealGHWithStdin(t.Context(), []string{"pr", "comment", "7", "-Racme/repo", "-b", "body"}, nil, &out, &stderr)
	if err == nil || writes != 0 || !strings.Contains(stderr.String(), "HTTP 404: Not Found") {
		t.Fatalf("err=%v stderr=%q writes=%d", err, stderr.String(), writes)
	}
	assertNoRESTWriteChild(t, capture)
}

func TestRESTPRWriteStoredNativeToken(t *testing.T) {
	capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(r *http.Request) (*http.Response, error) {
		return restWriteResponse(200, restWritePRJSON)
	})
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("OCTOPOOL_TEST_REWRITE_STDOUT", restWriteTestToken+"\n")
	t.Setenv("OCTOPOOL_TEST_REWRITE_STDERR", restWriteTestToken+"\n")
	var out, stderr bytes.Buffer
	if err := runGH(t.Context(), []string{"pr", "edit", "7", "-Racme/repo", "-b", ""}, &out, &stderr); err != nil {
		t.Fatalf("%v: %s", err, stderr.String())
	}
	got := readRewriteCapture(t, capture)
	if !reflect.DeepEqual(got.Args, []string{"auth", "token", "--hostname", "github.com"}) || got.Stdin != "" {
		t.Fatalf("unexpected native invocation: %#v", got)
	}
	if out.String() != "https://github.com/acme/repo/pull/7\n" || stderr.Len() != 0 {
		t.Fatal("credential lookup output leaked")
	}
}

func TestRESTPRWriteRepositoryResolution(t *testing.T) {
	for _, source := range []string{"env", "origin", "ambiguous"} {
		t.Run(source, func(t *testing.T) {
			requests := 0
			capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(r *http.Request) (*http.Response, error) {
				requests++
				if r.URL.Path != "/repos/acme/repo/pulls/7" {
					t.Fatalf("path = %s", r.URL.Path)
				}
				return restWriteResponse(200, restWritePRJSON)
			})
			if source == "env" {
				t.Setenv("GH_REPO", "acme/repo")
			} else {
				t.Chdir(t.TempDir())
				if _, err := gitProbe("init", "-q"); err != nil {
					t.Fatal(err)
				}
				name := "origin"
				if source == "ambiguous" {
					name = "one"
				}
				if _, err := gitProbe("remote", "add", name, "https://github.com/acme/repo.git"); err != nil {
					t.Fatal(err)
				}
				if source == "ambiguous" {
					if _, err := gitProbe("remote", "add", "two", "https://github.com/other/repo.git"); err != nil {
						t.Fatal(err)
					}
				}
			}
			var out, stderr bytes.Buffer
			if err := execRealGHWithStdin(t.Context(), []string{"pr", "edit", "7", "-b", "body"}, nil, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			if source == "ambiguous" {
				readRewriteCapture(t, capture)
				if requests != 0 {
					t.Fatal("ambiguous repository was written")
				}
			} else {
				if requests != 1 {
					t.Fatalf("requests = %d", requests)
				}
				assertNoRESTWriteChild(t, capture)
			}
		})
	}
}

func TestRESTPRWriteEffectiveChildEnvironment(t *testing.T) {
	for _, mode := range []string{"cleared-repo", "explicit-repo", "kill-switch", "git-context"} {
		t.Run(mode, func(t *testing.T) {
			requests := 0
			capture := restWriteFixture(t, rewriteEmptyTestPolicy, func(r *http.Request) (*http.Response, error) {
				requests++
				if r.URL.Path != "/repos/acme/repo/pulls/7" {
					t.Fatalf("wrong target: %s", r.URL.Path)
				}
				return restWriteResponse(200, restWritePRJSON)
			})
			t.Setenv("GH_REPO", "wrong/parent")
			env := os.Environ()
			args := []string{"pr", "edit", "7", "-b", "body"}
			switch mode {
			case "cleared-repo":
				env = append(env, "GH_REPO=")
			case "explicit-repo":
				env = append(env, "GH_REPO=acme/repo")
			case "kill-switch":
				env = append(env, "OCTOPOOL_REST_WRITES=0")
				args = append(args, "-Racme/repo")
			case "git-context":
				env = append(env, "GH_REPO=", "GIT_DIR="+t.TempDir())
			}
			var out, stderr bytes.Buffer
			if err := execRealGHWithStdinAndEnv(t.Context(), args, nil, &out, &stderr, env); err != nil {
				t.Fatal(err)
			}
			if mode == "explicit-repo" {
				if requests != 1 {
					t.Fatalf("requests=%d", requests)
				}
				assertNoRESTWriteChild(t, capture)
			} else {
				if requests != 0 {
					t.Fatal("wrote using parent environment")
				}
				got := readRewriteCapture(t, capture)
				if !reflect.DeepEqual(got.Args, args) || got.Env["GH_REPO"] != restWriteEnv(env, "GH_REPO") {
					t.Fatalf("native child changed: %#v", got)
				}
			}
		})
	}
}
