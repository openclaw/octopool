package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const prStateTestHead = "96b73e3bc5c058b57ca73ee3337ec351c3c727df"
const prStateTestTime = "2026-08-27T04:41:05Z"

func TestCLIEndToEndPRViewLifecycleProjection(t *testing.T) {
	if testing.Short() || !jqAvailable() {
		t.Skip("builds and executes the CLI binary with jq")
	}
	bin := buildCLIBinary(t)
	server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
		request := decodeCLIRequest(t, w, r)
		if request == nil {
			return
		}
		headers, _ := request["headers"].(map[string]any)
		pr := map[string]any{
			"state": "open", "draft": true, "head": map[string]any{"sha": prStateTestHead},
			"updated_at": prStateTestTime, "merged_at": nil,
		}
		if headers["x-octopool-public-shape"] == "pr-summary-v1" {
			pr["state"] = "DRAFT"
			delete(pr, "draft")
			delete(pr, "updated_at")
		}
		writeCLIEnvelope(t, w, pr)
	})
	for _, fields := range []string{"state,headRefOid", "state,headRefOid,isDraft,updatedAt"} {
		t.Run(fields, func(t *testing.T) {
			result := runCLI(t, bin, server.URL, map[string]string{
				"OCTOPOOL_NO_FALLBACK": "1", "OCTOPOOL_FRESH": "1",
			}, "gh", "pr", "view", "1025", "--repo", "openclaw/clawsweeper", "--json", fields, "--jq", ".")
			if result.err != nil {
				t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
			}
			var got map[string]any
			if err := json.Unmarshal([]byte(result.stdout), &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"state": "OPEN", "headRefOid": prStateTestHead}
			if strings.Contains(fields, "isDraft") {
				want["isDraft"] = true
				want["updatedAt"] = prStateTestTime
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("projection = %#v, want %#v", got, want)
			}
		})
	}
}

func TestNormalizePRViewState(t *testing.T) {
	for _, test := range []struct {
		name string
		pr   map[string]any
		want any
	}{
		{"merged flag", map[string]any{"state": "closed", "merged": true}, "MERGED"},
		{"merge timestamp", map[string]any{"state": "closed", "merged_at": prStateTestTime}, "MERGED"},
		{"page merged", map[string]any{"state": "MERGED"}, "MERGED"},
		{"closed draft display", map[string]any{"state": "DRAFT", "closed_at": prStateTestTime}, "CLOSED"},
		{"draft does not reopen", map[string]any{"state": "closed", "draft": true}, "CLOSED"},
		{"no lifecycle requested", map[string]any{"head": map[string]any{"sha": prStateTestHead}}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			normalizePRViewState(test.pr)
			if test.pr["state"] != test.want {
				t.Errorf("state = %v, want %v", test.pr["state"], test.want)
			}
		})
	}
}

func TestRunGHPRViewLifecycleProjection(t *testing.T) {
	for _, lifecycle := range []struct {
		name, webState, restState, wantState string
		draft, closed, merged                bool
	}{
		{"draft", "DRAFT", "open", "OPEN", true, false, false},
		{"open", "OPEN", "open", "OPEN", false, false, false},
		{"closed", "CLOSED", "closed", "CLOSED", false, true, false},
		{"closed-draft", "CLOSED", "closed", "CLOSED", true, true, false},
		{"merged", "MERGED", "closed", "MERGED", false, true, true},
	} {
		t.Run(lifecycle.name, func(t *testing.T) {
			for _, transport := range []string{"web", "rest"} {
				t.Run(transport, func(t *testing.T) {
					for _, fields := range []string{
						"state", "state,headRefOid", "state,isDraft", "state,headRefOid,isDraft",
						"state,updatedAt", "state,headRefOid,updatedAt", "state,isDraft,updatedAt",
						"state,headRefOid,isDraft,updatedAt", "isDraft,state,headRefOid",
						"isDraft", "headRefOid", "headRefOid,isDraft",
						"state,comments", "state,headRefOid,comments", "state,isDraft,comments",
						"state,headRefOid,isDraft,comments",
					} {
						t.Run(fields, func(t *testing.T) {
							// REST may also serve a public shape after a page parser misses.
							wantShape := !strings.Contains(fields, "isDraft") && !strings.Contains(fields, "updatedAt")
							prCalls, commentCalls := 0, 0
							relayTestServer(t, func(request map[string]any) any {
								if request["path"] == "/repos/openclaw/clawsweeper/issues/1025/comments" {
									commentCalls++
									return []any{}
								}
								if request["path"] != "/repos/openclaw/clawsweeper/pulls/1025" {
									t.Fatalf("unexpected path: %v", request["path"])
								}
								prCalls++
								headers, _ := request["headers"].(map[string]any)
								shape, _ := headers["x-octopool-public-shape"].(string)
								if (wantShape && shape != "pr-summary-v1") || (!wantShape && shape != "") {
									t.Fatalf("shape = %q, want public shape = %v", shape, wantShape)
								}
								pr := map[string]any{
									"state": lifecycle.restState, "draft": lifecycle.draft, "merged": lifecycle.merged,
									"head": map[string]any{"sha": prStateTestHead}, "updated_at": prStateTestTime,
									"closed_at": nil, "merged_at": nil,
								}
								if lifecycle.closed {
									pr["closed_at"] = prStateTestTime
								}
								if lifecycle.merged {
									pr["merged_at"] = prStateTestTime
								}
								if wantShape && transport == "web" {
									pr["state"] = lifecycle.webState
									delete(pr, "draft")
									delete(pr, "merged")
									delete(pr, "updated_at")
								}
								return pr
							})
							var out bytes.Buffer
							result := handleGHPR(t.Context(), []string{
								"view", "1025", "--repo", "openclaw/clawsweeper", "--json", fields,
							}, &out)
							if result.err != nil || result.action != ghComplete {
								t.Fatalf("action=%v err=%v", result.action, result.err)
							}
							var got map[string]any
							if err := json.Unmarshal(out.Bytes(), &got); err != nil {
								t.Fatal(err)
							}
							all := map[string]any{
								"state": lifecycle.wantState, "isDraft": lifecycle.draft,
								"headRefOid": prStateTestHead, "updatedAt": prStateTestTime, "comments": []any{},
							}
							want := map[string]any{}
							for _, field := range strings.Split(fields, ",") {
								want[field] = all[field]
							}
							if !reflect.DeepEqual(got, want) {
								t.Errorf("projection = %#v, want %#v", got, want)
							}
							wantComments := 0
							if strings.Contains(fields, "comments") {
								wantComments = 1
							}
							if prCalls != 1 || commentCalls != wantComments {
								t.Errorf("requests: PR=%d comments=%d, want 1/%d", prCalls, commentCalls, wantComments)
							}
						})
					}
				})
			}
		})
	}
}

func TestRunGHPRViewLifecycleJQ(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq is not installed")
	}
	for _, fields := range []string{"state,headRefOid", "state,headRefOid,isDraft,updatedAt"} {
		for _, jq := range []string{".", ".state", "has(\"isDraft\")", "has(\"merged_at\")"} {
			t.Run(fields+"/"+jq, func(t *testing.T) {
				expanded := strings.Contains(fields, "isDraft")
				relayTestServer(t, func(request map[string]any) any {
					if expanded {
						return map[string]any{
							"state": "open", "draft": true, "head": map[string]any{"sha": prStateTestHead},
							"updated_at": prStateTestTime, "merged_at": nil,
						}
					}
					return map[string]any{"state": "DRAFT", "head": map[string]any{"sha": prStateTestHead}, "merged_at": nil}
				})
				var out bytes.Buffer
				result := handleGHPR(t.Context(), []string{
					"view", "1025", "--repo", "openclaw/clawsweeper", "--json", fields, "--jq", jq,
				}, &out)
				if result.err != nil || result.action != ghComplete {
					t.Fatalf("action=%v err=%v", result.action, result.err)
				}
				want := "OPEN\n"
				switch jq {
				case ".":
					var got map[string]any
					if err := json.Unmarshal(out.Bytes(), &got); err != nil {
						t.Fatal(err)
					}
					want := map[string]any{"state": "OPEN", "headRefOid": prStateTestHead}
					if expanded {
						want["isDraft"] = true
						want["updatedAt"] = prStateTestTime
					}
					if !reflect.DeepEqual(got, want) {
						t.Errorf("projection = %#v, want %#v", got, want)
					}
					return
				case "has(\"isDraft\")":
					want = "false\n"
					if expanded {
						want = "true\n"
					}
				case "has(\"merged_at\")":
					want = "false\n"
				}
				if out.String() != want {
					t.Errorf("jq output = %q, want %q", out.String(), want)
				}
			})
		}
	}
}

func TestRunGHPRStatePreservesOtherContracts(t *testing.T) {
	for _, state := range []string{"open", "closed"} {
		t.Run(state, func(t *testing.T) {
			pr := map[string]any{"state": state, "draft": true, "merged_at": nil}
			relayTestServer(t, func(request map[string]any) any {
				if request["path"] == "/search/issues" {
					return map[string]any{"items": []any{pr}}
				}
				return pr
			})
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"api", "repos/openclaw/clawsweeper/pulls/1025"}, &out, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, pr) {
				t.Errorf("raw REST = %#v, want %#v", got, pr)
			}
			out.Reset()
			result := handleGHSearch(t.Context(), []string{"prs", "cache", "-R", "openclaw/clawsweeper", "--json", "state"}, &out)
			if result.err != nil || result.action != ghComplete {
				t.Fatalf("action=%v err=%v", result.action, result.err)
			}
			if want := "[{\"state\":\"" + state + "\"}]\n"; out.String() != want {
				t.Errorf("search = %q, want %q", out.String(), want)
			}
			wantHuman := "DRAFT"
			if state == "closed" {
				wantHuman = "CLOSED"
			}
			if got := humanPRState(pr); got != wantHuman {
				t.Errorf("human state = %q, want %q", got, wantHuman)
			}
		})
	}
}
