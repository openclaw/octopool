package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestReleaseViewMetadataShapeBoundary(t *testing.T) {
	for _, policy := range []string{rewriteEmptyTestPolicy, rewriteActiveTestPolicy} {
		for _, test := range []struct {
			name, fields          string
			tag, fresh, exact, jq bool
		}{
			{"tagged metadata", "tagName,url,isDraft,isPrerelease,publishedAt", true, false, false, false},
			{"latest metadata", "tagName,url,isDraft,isPrerelease,publishedAt", false, false, false, false},
			{"fresh metadata", "tagName,publishedAt", true, true, false, false},
			{"jq metadata", "tagName,url", true, false, false, true},
			{"body stays exact", "tagName,body", true, false, true, false},
			{"creation stays exact", "tagName,createdAt,publishedAt", true, false, true, false},
			{"name stays exact", "tagName,name", true, false, true, false},
		} {
			t.Run(policy+"/"+test.name, func(t *testing.T) {
				body := map[string]any{"tag_name": "v0.6.9", "html_url": "https://github.com/acme/repo/releases/tag/v0.6.9", "draft": false, "prerelease": false, "published_at": "2026-09-20T19:08:46Z", "created_at": "2026-09-20T19:05:45Z", "body": "\r\n## Raw\r\n", "name": ""}
				calls := 0
				rewriteTestServer(t, policy, func(w http.ResponseWriter, r *http.Request) {
					calls++
					request := decodeCLIRequest(t, w, r)
					headers, _ := request["headers"].(map[string]any)
					shape := "release-metadata-v1"
					if test.exact {
						shape = "release-summary-v1"
					}
					path := "/repos/acme/repo/releases/latest"
					if test.tag {
						path = "/repos/acme/repo/releases/tags/v0.6.9"
					}
					if request["path"] != path || headers["x-octopool-public-shape"] != shape {
						t.Errorf("wrong release selection: %#v", request)
					}
					if test.fresh && headers["cache-control"] != "max-age=0" {
						t.Errorf("freshness lost: %#v", headers)
					}
					// Exact bodies also cover a new CLI talking to an older Worker.
					writeCLIEnvelope(t, w, body)
				})
				t.Setenv("OCTOPOOL_FRESH", "")
				if test.fresh {
					t.Setenv("OCTOPOOL_FRESH", "1")
				}
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				capture := captureRewriteGH(t)
				args := []string{"release", "view"}
				if test.tag {
					args = append(args, "v0.6.9")
				}
				args = append(args, "-R", "acme/repo", "--json", test.fields)
				if test.jq {
					args = append(args, "--jq", ".tagName")
				}
				var out, stderr bytes.Buffer
				if err := runGH(t.Context(), args, &out, &stderr); err != nil || calls != 1 || stderr.Len() != 0 {
					t.Fatalf("err=%v calls=%d stdout=%q stderr=%q", err, calls, out.String(), stderr.String())
				}
				if test.jq {
					if out.String() != "v0.6.9\n" {
						t.Fatalf("jq output=%q", out.String())
					}
				} else {
					var got map[string]any
					if err := json.Unmarshal(out.Bytes(), &got); err != nil {
						t.Fatal(err)
					}
					if len(got) != len(strings.Split(test.fields, ",")) || got["tagName"] != "v0.6.9" {
						t.Fatalf("fields=%#v", got)
					}
					if test.name == "body stays exact" && got["body"] != body["body"] {
						t.Fatalf("raw body=%#v", got)
					}
					if test.name == "creation stays exact" && got["createdAt"] != body["created_at"] {
						t.Fatalf("creation timestamp=%#v", got)
					}
					if test.name == "name stays exact" && got["name"] != "" {
						t.Fatalf("empty source name=%#v", got)
					}
				}
				if _, err := os.Stat(capture); !os.IsNotExist(err) {
					t.Fatal("release read dispatched native gh")
				}
			})
		}
	}
}

func TestReleaseViewLatestPolicyDenial(t *testing.T) {
	for _, fields := range []string{"tagName,publishedAt", ""} {
		t.Run(fields, func(t *testing.T) {
			rewriteTestServer(t, `{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"releases/latest","replacement":"public"}]}`, nil)
			capture := captureRewriteGH(t)
			args := []string{"release", "view", "-R", "acme/repo"}
			if fields != "" {
				args = append(args, "--json", fields)
			}
			var out, stderr bytes.Buffer
			if err := runGH(t.Context(), args, &out, &stderr); !errors.Is(err, errRewriteBlocked) || out.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("latest policy denial changed: err=%v stdout=%q stderr=%q", err, out.String(), stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("latest policy denial started native gh")
			}
		})
	}
}
