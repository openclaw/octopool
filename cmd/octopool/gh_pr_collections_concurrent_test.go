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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPRViewCollectionsOverlap(t *testing.T) {
	for _, fields := range []string{"files,statusCheckRollup", "statusCheckRollup,files"} {
		for _, moved := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/moved=%v", fields, moved), func(t *testing.T) {
				checks := newPRChecksFixture()
				started := make(chan string, 2)
				release := make(chan struct{})
				unblock := sync.OnceFunc(func() { close(release) })
				var requests, heads atomic.Int64
				var filesDone, checksDone atomic.Bool
				runMetadataTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
					requests.Add(1)
					path := body["path"].(string)
					if path == "/repos/acme/repo/pulls/7" {
						if heads.Add(1) == 2 {
							if !filesDone.Load() || !checksDone.Load() {
								t.Error("head verification ran before both collections finished")
							}
							if moved {
								return runMetadataResponse(t, map[string]any{"head": map[string]any{"sha": strings.Repeat("b", 40)}}), nil
							}
						}
						return runMetadataResponse(t, prDetailExportResponse(t, checks, body)), nil
					}
					files := strings.HasSuffix(path, "/files")
					page, _ := body["query"].(map[string]any)
					if (files && page["page"] == "1") || strings.HasSuffix(path, "/check-runs") {
						started <- path
						select {
						case <-release:
						case <-request.Context().Done():
							return nil, request.Context().Err()
						}
					}
					if files {
						hint, _ := body["route_hint"].(map[string]any)
						if hint["pr_head_sha"] != metadataHead || page["per_page"] != "100" {
							t.Errorf("files lost head or pagination: %v", page)
						}
						start, end := 0, 100
						if page["page"] == "2" {
							start, end = 100, 101
							filesDone.Store(true)
						}
						items := make([]any, 0, end-start)
						for i := start; i < end; i++ {
							items = append(items, map[string]any{"filename": fmt.Sprintf("file%03d.go", i), "status": "added", "additions": 1, "deletions": 0})
						}
						return runMetadataResponse(t, items), nil
					}
					if strings.HasSuffix(path, "/actions/workflows") {
						checksDone.Store(true)
					}
					return runMetadataResponse(t, prDetailExportResponse(t, checks, body)), nil
				})
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				type result struct {
					err            error
					stdout, stderr string
				}
				done := make(chan result, 1)
				go func() {
					defer close(done)
					var out, stderr bytes.Buffer
					err := runGH(ctx, []string{"pr", "view", "7", "-R", "acme/repo", "--json", fields}, &out, &stderr)
					done <- result{err, out.String(), stderr.String()}
				}()
				defer func() { cancel(); unblock(); <-done }()
				seen := map[string]bool{}
				for range 2 {
					select {
					case path := <-started:
						seen[path] = true
					case <-ctx.Done():
						t.Fatal("files and check collections did not overlap")
					}
				}
				if !seen["/repos/acme/repo/pulls/7/files"] || !seen["/repos/acme/repo/commits/"+metadataHead+"/check-runs"] {
					t.Fatalf("unexpected collection paths: %v", seen)
				}
				unblock()
				got := <-done
				if requests.Load() != 8 || heads.Load() != 2 {
					t.Fatalf("unexpected request counts: all=%d heads=%d", requests.Load(), heads.Load())
				}
				if moved {
					if !isLocalFallback(got.err) || !strings.Contains(got.err.Error(), "head changed") || got.stdout != "" || got.stderr != "" {
						t.Fatalf("changed head escaped verification: %+v", got)
					}
					return
				}
				var output struct {
					Files  []struct{ Path, ChangeType string }
					Rollup []struct{ Name, WorkflowName, Conclusion string } `json:"statusCheckRollup"`
				}
				if got.err != nil || got.stderr != "" || json.Unmarshal([]byte(got.stdout), &output) != nil || len(output.Files) != 101 || len(output.Rollup) != 1 {
					t.Fatalf("incomplete PR output: %+v", got)
				}
				for i, file := range output.Files {
					if file.Path != fmt.Sprintf("file%03d.go", i) || file.ChangeType != "ADDED" {
						t.Fatalf("file order or projection changed at %d: %+v", i, file)
					}
				}
				if row := output.Rollup[0]; row.Name != "unit" || row.WorkflowName != "CI" || row.Conclusion != "SUCCESS" {
					t.Fatalf("check projection changed: %+v", row)
				}
			})
		}
	}
}

func TestPRViewCollectionDenialCancelsSibling(t *testing.T) {
	for _, denied := range []string{"/files", "/check-runs"} {
		t.Run(denied, func(t *testing.T) {
			checks := newPRChecksFixture()
			started := make(chan struct{})
			var settled atomic.Bool
			runMetadataTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
				path := body["path"].(string)
				if !strings.HasSuffix(path, "/files") && !strings.HasSuffix(path, "/check-runs") {
					return runMetadataResponse(t, prDetailExportResponse(t, checks, body)), nil
				}
				if strings.HasSuffix(path, denied) {
					select {
					case <-started:
					case <-request.Context().Done():
						return nil, request.Context().Err()
					}
					return &http.Response{StatusCode: http.StatusForbidden, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"string_rewrite_denied"}}`))}, nil
				}
				close(started)
				<-request.Context().Done()
				settled.Store(true)
				return nil, request.Context().Err()
			})
			capture := captureRewriteGH(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var out, stderr bytes.Buffer
			err := runGH(ctx, []string{"pr", "view", "7", "-R", "acme/repo", "--json", "files,statusCheckRollup"}, &out, &stderr)
			var relay *relayResponseError
			if !errors.As(err, &relay) || relay.Status != http.StatusForbidden || relay.Code != "string_rewrite_denied" || !settled.Load() || out.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("denial or cancellation lost: err=%v settled=%v out=%q stderr=%q", err, settled.Load(), out.String(), stderr.String())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("denied collection started native gh")
			}
		})
	}
}
