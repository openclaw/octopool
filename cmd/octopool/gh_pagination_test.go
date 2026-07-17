package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"testing"
)

func TestRunGHAPIPaginatesArrayResponse(t *testing.T) {
	var queries []map[string]any
	relayTestServer(t, func(body map[string]any) any {
		query := body["query"].(map[string]any)
		queries = append(queries, query)
		switch query["page"] {
		case "1":
			return paginationItems(0, relayPageSize)
		case "2":
			return paginationItems(relayPageSize, relayPageSize)
		default:
			return paginationItems(2*relayPageSize, 1)
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	pages := decodeArrayPageStream(t, out.Bytes())
	if len(pages) != 3 || len(pages[0]) != 100 || len(pages[1]) != 100 || len(pages[2]) != 1 {
		t.Fatalf("page lengths = %v", pageLengths(pages))
	}
	for index, query := range queries {
		if query["page"] != strconv.Itoa(index+1) || query["per_page"] != "100" {
			t.Fatalf("query %d = %#v", index, query)
		}
	}
}

func TestRunGHAPIPaginatesExactMultipleThroughEmptyPage(t *testing.T) {
	requests := 0
	relayTestServer(t, func(body map[string]any) any {
		requests++
		if body["query"].(map[string]any)["page"] == "1" {
			return paginationItems(0, relayPageSize)
		}
		return []int{}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	pages := decodeArrayPageStream(t, out.Bytes())
	if requests != 2 || len(pages) != 2 || len(pages[0]) != 100 || len(pages[1]) != 0 {
		t.Fatalf("requests=%d page lengths=%v", requests, pageLengths(pages))
	}
}

func TestRunGHAPIPaginatesObjectTotalCountResponse(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		if requests == 1 {
			return map[string]any{
				"total_count": 3, "incomplete_results": false,
				"check_runs": []map[string]any{{"id": 1}, {"id": 2}},
			}
		}
		return map[string]any{
			"total_count": 3, "incomplete_results": false,
			"check_runs": []map[string]any{{"id": 3}},
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/commits/abc1234/check-runs", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(out.Bytes()))
	for expected := 2; expected >= 1; expected-- {
		var page struct {
			CheckRuns []map[string]any `json:"check_runs"`
		}
		if err := decoder.Decode(&page); err != nil {
			t.Fatal(err)
		}
		if len(page.CheckRuns) != expected {
			t.Fatalf("check runs = %d, want %d", len(page.CheckRuns), expected)
		}
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestRunGHAPISlurpWrapsArrayPages(t *testing.T) {
	relayTestServer(t, func(body map[string]any) any {
		if body["query"].(map[string]any)["page"] == "1" {
			return []int{1, 2}
		}
		return []int{3}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues?per_page=2", "--paginate", "--slurp",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var pages [][]int
	if err := json.Unmarshal(out.Bytes(), &pages); err != nil {
		t.Fatal(err)
	}
	if len(pages) != 2 || len(pages[0]) != 2 || len(pages[1]) != 1 {
		t.Fatalf("pages = %#v", pages)
	}
}

func TestRunGHAPISlurpWrapsObjectPages(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return map[string]any{
			"total_count": 2,
			"check_runs":  []map[string]any{{"id": requests}},
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/commits/abc1234/check-runs", "--paginate", "--slurp",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var pages []struct {
		CheckRuns []map[string]any `json:"check_runs"`
	}
	if err := json.Unmarshal(out.Bytes(), &pages); err != nil {
		t.Fatal(err)
	}
	if len(pages) != 2 || len(pages[0].CheckRuns) != 1 || len(pages[1].CheckRuns) != 1 {
		t.Fatalf("pages = %#v", pages)
	}
}

func TestRunGHAPIJQFiltersPaginatedStream(t *testing.T) {
	if !jqAvailable() {
		t.Skip("jq is required")
	}
	relayTestServer(t, func(body map[string]any) any {
		if body["query"].(map[string]any)["page"] == "1" {
			return []map[string]any{{"id": 1}, {"id": 2}}
		}
		return []map[string]any{{"id": 3}}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues?per_page=2", "--paginate", "--jq", ".[] | .id",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if out.String() != "1\n2\n3\n" {
		t.Fatalf("output = %q", out.String())
	}
}

func TestRunGHAPIPaginationHonorsPageAndPerPage(t *testing.T) {
	var perPages []any
	var pages []any
	relayTestServer(t, func(body map[string]any) any {
		query := body["query"].(map[string]any)
		perPages = append(perPages, query["per_page"])
		pages = append(pages, query["page"])
		if query["page"] == "4" {
			return paginationItems(0, 7)
		}
		return paginationItems(7, 1)
	})

	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues?per_page=7&page=4", "--paginate",
	}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(perPages) != 2 || perPages[0] != "7" || perPages[1] != "7" {
		t.Fatalf("per_page values = %#v", perPages)
	}
	if len(pages) != 2 || pages[0] != "4" || pages[1] != "5" {
		t.Fatalf("page values = %#v", pages)
	}
}

func TestRunGHAPIPaginationExhaustionFallsBackToRealGH(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return paginationItems(requests*relayPageSize, relayPageSize)
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	var stderr bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if requests != maxRelayPages {
		t.Fatalf("relay requests = %d", requests)
	}
	if out.String() != "real-gh:api repos/openclaw/octopool/issues --paginate\n" {
		t.Fatalf("output = %q", out.String())
	}
	if !strings.Contains(stderr.String(), "pagination_exhausted") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestParseGHAPISlurpRequiresPaginate(t *testing.T) {
	_, _, err := parseGHAPIArgs([]string{"repos/openclaw/octopool/issues", "--slurp"})
	if err == nil || err.Error() != "--slurp requires --paginate" {
		t.Fatalf("error = %v", err)
	}
}

func TestRunGHAPIPostPaginateFallsBack(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return nil
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "--method", "POST", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 0 || !strings.HasPrefix(out.String(), "real-gh:") {
		t.Fatalf("relay requests=%d output=%q", requests, out.String())
	}
}

func TestRunGHAPIPaginateNonQueryPathFallsBack(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return nil
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "unsupported/queryless/path", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 0 || !strings.HasPrefix(out.String(), "real-gh:") {
		t.Fatalf("relay requests=%d output=%q", requests, out.String())
	}
}

func paginationItems(start int, count int) []int {
	items := make([]int, count)
	for index := range items {
		items[index] = start + index
	}
	return items
}

func decodeArrayPageStream(t *testing.T, raw []byte) [][]int {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var pages [][]int
	for {
		var page []int
		err := decoder.Decode(&page)
		if err == io.EOF {
			return pages
		}
		if err != nil {
			t.Fatal(err)
		}
		pages = append(pages, page)
	}
}

func pageLengths(pages [][]int) []int {
	lengths := make([]int, len(pages))
	for index, page := range pages {
		lengths[index] = len(page)
	}
	return lengths
}

func TestRunGHPRChecksFallsBackWhenPaginationIsExhausted(t *testing.T) {
	checkRuns := make([]map[string]any, relayPageSize)
	for index := range checkRuns {
		checkRuns[index] = map[string]any{
			"name":       "check-" + strconv.Itoa(index),
			"status":     "completed",
			"conclusion": "success",
		}
	}
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"head": map[string]any{"sha": "abc1234"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			return map[string]any{"total_count": maxRelayPages*relayPageSize + 1, "check_runs": checkRuns}
		default:
			return nil
		}
	})

	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"checks", "7", "-R", "openclaw/octopool", "--json", "name,state",
	}, &out)
	if result.action != ghFail || !isLocalFallback(result.err) {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHPRViewFallsBackWhenDetailPaginationIsExhausted(t *testing.T) {
	files := make([]map[string]any, relayPageSize)
	for index := range files {
		files[index] = map[string]any{"filename": "file-" + strconv.Itoa(index)}
	}
	relayTestServer(t, func(body map[string]any) any {
		switch body["path"] {
		case "/repos/openclaw/octopool/pulls/7":
			return map[string]any{"number": 7}
		case "/repos/openclaw/octopool/pulls/7/files":
			return files
		default:
			return nil
		}
	})

	var out bytes.Buffer
	result := handleGHPR(t.Context(), []string{
		"view", "7", "-R", "openclaw/octopool", "--json", "number,files",
	}, &out)
	if result.action != ghFail || !isLocalFallback(result.err) {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}

func TestRunGHIssueListFallsBackWhenFilteringExhaustsPagination(t *testing.T) {
	items := make([]map[string]any, relayPageSize)
	for index := range items {
		items[index] = map[string]any{
			"number":       index + 1,
			"pull_request": map[string]any{"url": "https://example.test"},
		}
	}
	relayTestServer(t, func(map[string]any) any { return items })

	var out bytes.Buffer
	result := handleGHIssue(t.Context(), []string{
		"list", "-R", "openclaw/octopool", "--limit", "1", "--json", "number",
	}, &out)
	if result.action != ghFail || !isLocalFallback(result.err) {
		t.Fatalf("action=%v err=%v", result.action, result.err)
	}
}
