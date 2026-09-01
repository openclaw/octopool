package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

type relayTestResponse struct {
	Body    any
	Headers map[string]string
	Status  int
}

func relayTestServer(t *testing.T, responseBody func(map[string]any) any) {
	t.Helper()
	isolateTestConfig(t)
	t.Setenv("OCTOPOOL_STRING_REWRITE_FILE", "")
	t.Setenv("OCTOPOOL_TOKEN", "test-token")
	t.Setenv("OCTOPOOL_POOL", "maintainers")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveEmptyRewritePolicy(t, w, r, "test-token", "maintainers") {
			return
		}
		if r.URL.Path != "/v1/github/request" || r.Method != "POST" {
			http.Error(w, "unexpected relay path", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			http.Error(w, "unexpected relay authorization", http.StatusUnauthorized)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		envelope := relayEnvelope{
			Status:       200,
			BodyEncoding: "json",
		}
		fixture := responseBody(body)
		if response, ok := fixture.(relayTestResponse); ok {
			if response.Status != 0 {
				for key, value := range response.Headers {
					w.Header().Set(key, value)
				}
				w.WriteHeader(response.Status)
				if err := json.NewEncoder(w).Encode(response.Body); err != nil {
					t.Errorf("write relay error fixture: %v", err)
				}
				return
			}
			fixture = response.Body
			envelope.Headers = response.Headers
		}
		raw, err := json.Marshal(fixture)
		if err != nil {
			t.Errorf("marshal relay fixture: %v", err)
			http.Error(w, "invalid fixture body", http.StatusInternalServerError)
			return
		}
		envelope.Body = raw
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(envelope); err != nil {
			t.Errorf("write relay fixture: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OCTOPOOL_URL", server.URL)
}

// Explicitly emulate the authoritative empty deployment policy for legacy
// dispatch fixtures. This is an HTTP route, never a production/test bypass.
func serveEmptyRewritePolicy(t *testing.T, w http.ResponseWriter, r *http.Request, token, pool string) bool {
	t.Helper()
	if r.URL.Path != "/v1/pools/"+pool+"/string-rewrites" {
		return false
	}
	if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cache-Control") != "no-cache, no-store" {
		t.Errorf("unexpected policy request method/auth/cache directive")
		w.WriteHeader(http.StatusBadRequest)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[]}`))
	return true
}

func emptyRewriteTestServer(t *testing.T) {
	t.Helper()
	relayTestServer(t, func(map[string]any) any { t.Error("unexpected relay request"); return nil })
}

func nativeOptionsResponse(t *testing.T, request map[string]any) any {
	t.Helper()
	item := map[string]any{"number": 7, "title": "synthetic", "state": "open", "id": 42, "name": "synthetic", "run_attempt": 3, "status": "completed", "conclusion": "success"}
	switch request["path"] {
	case "/repos/acme/repo/pulls/7", "/repos/acme/repo/issues/7", "/repos/acme/repo/actions/runs/42", "/repos/acme/repo/actions/runs/42/attempts/2", "/repos/acme/repo", "/gists/abc123", "/repos/acme/repo/actions/workflows/ci.yml":
		return item
	case "/repos/acme/repo/pulls/7/reviews", "/repos/acme/repo/issues/7/comments":
		return []any{}
	case "/repos/acme/repo/pulls", "/repos/acme/repo/issues", "/repos/acme/repo/releases", "/repos/acme/repo/labels":
		return []any{item}
	case "/repos/acme/repo/actions/runs":
		return map[string]any{"total_count": 1, "workflow_runs": []any{item}}
	case "/repos/acme/repo/actions/workflows":
		return map[string]any{"total_count": 1, "workflows": []any{map[string]any{"id": 42, "name": "synthetic", "state": "active"}}}
	case "/repos/acme/repo/actions/runs/42/attempts/3/jobs":
		return map[string]any{"total_count": 0, "jobs": []any{}}
	case "/search/issues", "/search/repositories":
		return map[string]any{"total_count": 1, "items": []any{item}}
	default:
		t.Errorf("unexpected synthetic option route: %v", request["path"])
		return nil
	}
}

// REST fixtures for the shared checks/rollup owners; no production hooks.
type prChecksFixture struct {
	checks, statuses, runs, workflows []any
	requests                          []map[string]any
	head                              map[string]any
}

func newPRChecksFixture() *prChecksFixture {
	return &prChecksFixture{
		head:     map[string]any{"sha": metadataHead, "ref": "feature"},
		checks:   []any{prChecksCheck(1, "unit", "completed", "success")},
		statuses: []any{},
		runs: []any{map[string]any{
			"id": 301, "head_sha": metadataHead, "check_suite_id": 201, "workflow_id": 401,
			"name": "misleading run title", "display_title": "Not the workflow", "event": "pull_request",
			"head_repository": map[string]any{"id": 12, "full_name": "contributor/repo"},
			"repository":      map[string]any{"id": 11, "full_name": "acme/repo"},
		}},
		workflows: []any{map[string]any{"id": 401, "name": "CI", "path": ".github/workflows/ci.yml", "state": "disabled_manually"}},
	}
}

func prChecksCheck(id int64, name, status, conclusion string) map[string]any {
	var result any = conclusion
	if conclusion == "" {
		result = nil
	}
	item := map[string]any{
		"id": id, "name": name, "status": status, "conclusion": result, "head_sha": metadataHead,
		"app": map[string]any{"id": 15368, "slug": "github-actions"}, "check_suite": map[string]any{"id": 201},
		"started_at": "2026-09-01T01:00:00Z", "completed_at": "2026-09-01T01:01:00Z",
		"details_url": "https://github.com/acme/repo/actions/runs/301/job/1",
	}
	if status != "completed" {
		item["completed_at"] = nil
	}
	return item
}

func (f *prChecksFixture) response(t *testing.T, request map[string]any) any {
	t.Helper()
	f.requests = append(f.requests, request)
	path, _ := request["path"].(string)
	if path == "/repos/acme/repo/pulls/7" {
		return map[string]any{"number": 7, "head": f.head}
	}
	var key string
	var items []any
	switch path {
	case "/repos/acme/repo/commits/" + metadataHead + "/check-runs":
		key, items = "check_runs", f.checks
	case "/repos/acme/repo/commits/" + metadataHead + "/status":
		key, items = "statuses", f.statuses
	case "/repos/acme/repo/actions/runs":
		key, items = "workflow_runs", f.runs
		query, _ := request["query"].(map[string]any)
		if query["head_sha"] != metadataHead {
			t.Errorf("runs must be head-filtered: %v", query)
		}
	case "/repos/acme/repo/actions/workflows":
		key, items = "workflows", f.workflows
	default:
		t.Errorf("unexpected data route (no per-check/suite/detail fanout): %s", path)
		return nil
	}
	query, _ := request["query"].(map[string]any)
	pageText, _ := query["page"].(string)
	page, err := strconv.Atoi(pageText)
	if err != nil || page < 1 || page > 10 || query["per_page"] != "100" {
		t.Errorf("invalid bounded collection query: %v", query)
		return nil
	}
	if strings.Contains(path, "/actions/") {
		headers, _ := request["headers"].(map[string]any)
		if headers["x-octopool-public-shape"] != nil {
			t.Error("metadata must use raw REST collections")
		}
	}
	start := min((page-1)*100, len(items))
	return map[string]any{"total_count": len(items), key: items[start:min(start+100, len(items))]}
}

func (f *prChecksFixture) calls(suffix string) int {
	n := 0
	for _, request := range f.requests {
		if strings.HasSuffix(request["path"].(string), suffix) {
			n++
		}
	}
	return n
}
