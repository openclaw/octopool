package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunViewMetadataReadsOverlap(t *testing.T) {
	fixture := newRunExportFixture()
	started := make(chan string, 2)
	release := make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	var requests atomic.Int64
	concurrentReadTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
		requests.Add(1)
		path := body["path"].(string)
		if path == "/repos/acme/repo/actions/runs/42" {
			return concurrentReadResponse(t, fixture.run), nil
		}
		if strings.HasSuffix(path, "/jobs") {
			query := body["query"].(map[string]any)
			if query["page"] == "2" {
				return concurrentReadResponse(t, map[string]any{"total_count": 101, "jobs": []any{runExportJob(101)}}), nil
			}
		}
		started <- path
		select {
		case <-release:
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
		if strings.HasSuffix(path, "/jobs") {
			jobs := make([]any, 100)
			for i := range jobs {
				jobs[i] = runExportJob(i + 1)
			}
			return concurrentReadResponse(t, map[string]any{"total_count": 101, "jobs": jobs}), nil
		}
		if path != "/repos/acme/repo/actions/workflows/9" {
			t.Errorf("unexpected metadata path %s", path)
		}
		return concurrentReadResponse(t, fixture.lookups["9"]), nil
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	done := startConcurrentRead(ctx, runExportArgs("view", "headSha,jobs,workflowName"))
	defer func() { cancel(); unblock(); <-done }()
	seen := map[string]bool{}
	for range 2 {
		select {
		case path := <-started:
			seen[path] = true
		case <-ctx.Done():
			t.Fatal("jobs and workflow metadata did not overlap")
		}
	}
	if !seen["/repos/acme/repo/actions/runs/42/attempts/3/jobs"] || !seen["/repos/acme/repo/actions/workflows/9"] {
		t.Fatalf("metadata paths %v", seen)
	}
	unblock()
	got := <-done
	if got.err != nil || got.stderr != "" {
		t.Fatalf("run view failed: %+v", got)
	}
	var output struct {
		HeadSHA      string `json:"headSha"`
		WorkflowName string `json:"workflowName"`
		Jobs         []struct {
			ID int `json:"databaseId"`
		} `json:"jobs"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &output); err != nil {
		t.Fatal(err)
	}
	if output.HeadSHA != runExportHead || output.WorkflowName != "Real CI" || len(output.Jobs) != 101 || requests.Load() != 4 {
		t.Fatalf("incomplete run export: requests=%d output=%+v", requests.Load(), output)
	}
	for i, job := range output.Jobs {
		if job.ID != i+1 {
			t.Fatalf("job order changed at %d: %d", i, job.ID)
		}
	}
}

func TestRunViewMetadataDenialCancelsSibling(t *testing.T) {
	for _, denied := range []string{"/jobs", "/workflows/9"} {
		t.Run(denied, func(t *testing.T) {
			fixture := newRunExportFixture()
			started := make(chan struct{})
			var settled atomic.Bool
			concurrentReadTransport(t, func(request *http.Request, body map[string]any) (*http.Response, error) {
				path := body["path"].(string)
				if path == "/repos/acme/repo/actions/runs/42" {
					return concurrentReadResponse(t, fixture.run), nil
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
			var stdout, stderr bytes.Buffer
			err := runGH(ctx, runExportArgs("view", "jobs,workflowName"), &stdout, &stderr)
			var relay *relayResponseError
			if !errors.As(err, &relay) || relay.Status != http.StatusForbidden || relay.Code != "string_rewrite_denied" || !settled.Load() || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("denial not preserved or sibling not settled: %v, stdout=%q stderr=%q settled=%v", err, stdout.String(), stderr.String(), settled.Load())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("denied read started native gh")
			}
		})
	}
}
