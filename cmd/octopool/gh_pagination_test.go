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
	var merged []any
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatalf("output is not one merged JSON array: %v\n%s", err, out.Bytes())
	}
	if len(merged) != 2*relayPageSize+1 {
		t.Fatalf("merged length = %d", len(merged))
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
	var merged []any
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatalf("output is not one merged JSON array: %v\n%s", err, out.Bytes())
	}
	if requests != 2 || len(merged) != relayPageSize {
		t.Fatalf("requests=%d merged length=%d", requests, len(merged))
	}
}

func TestRunGHAPIPaginatesThroughAuthoritativeLinkHeader(t *testing.T) {
	requests := 0
	relayTestServer(t, func(body map[string]any) any {
		requests++
		page := body["query"].(map[string]any)["page"]
		switch page {
		case "1":
			return relayTestResponse{
				Body:    []int{1},
				Headers: map[string]string{"Link": `<https://api.github.com/repos/openclaw/octopool/issues?labels=a,b&per_page=100&page=2>; rel="next"`},
			}
		case "2":
			return relayTestResponse{
				Body: []int{2},
				Headers: map[string]string{"link": strings.Join([]string{
					`<https://api.github.com/repos/openclaw/octopool/issues?labels=a,b&per_page=100&page=1>; rel="prev"`,
					`<https://api.github.com/repos/openclaw/octopool/issues?labels=a,b&per_page=100&page=3>; rel=next`,
				}, ", ")},
			}
		case "3":
			return relayTestResponse{
				Body:    []int{3},
				Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?labels=a,b&per_page=100&page=2>; rel="prev"`},
			}
		default:
			t.Fatalf("unexpected page query: %#v", page)
			return nil
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var merged []int
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatal(err)
	}
	if requests != 3 || len(merged) != 3 {
		t.Fatalf("requests=%d merged=%v", requests, merged)
	}
}

func TestRunGHAPILinkContinuesAfterSparsePage(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		if requests == 1 {
			return relayTestResponse{
				Body:    paginationItems(0, 50),
				Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?per_page=100&page=2>; rel="next"`},
			}
		}
		return relayTestResponse{
			Body:    []int{50},
			Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?per_page=100&page=1>; rel="prev"`},
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var merged []int
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatal(err)
	}
	if requests != 2 || len(merged) != 51 {
		t.Fatalf("requests=%d merged length=%d", requests, len(merged))
	}
}

func TestRunGHAPILinkWithoutNextStopsImmediately(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return relayTestResponse{
			Body: map[string]any{"commits": []int{1}, "files": []int{2}},
			Headers: map[string]string{
				"link": `<https://api.github.com/repos/openclaw/octopool/compare/a...b?page=1>; rel="prev"`,
			},
		}
	})

	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/compare/a...b", "--paginate",
	}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestRunGHAPILinkAdoptsCursorQuery(t *testing.T) {
	requests := 0
	relayTestServer(t, func(body map[string]any) any {
		requests++
		query := body["query"].(map[string]any)
		if requests == 1 {
			return relayTestResponse{
				Body:    []int{1},
				Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?after=abc>; rel="next"`},
			}
		}
		if len(query) != 1 || query["after"] != "abc" {
			t.Fatalf("cursor query = %#v", query)
		}
		return relayTestResponse{
			Body:    []int{2},
			Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?before=abc>; rel="prev"`},
		}
	})

	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestRunGHAPICanonicalizedLinkStepsPageOnRelay(t *testing.T) {
	requests := []string{}
	relayTestServer(t, func(body map[string]any) any {
		page := body["query"].(map[string]any)["page"].(string)
		requests = append(requests, page)
		if page == "1" {
			// GitHub canonicalizes the repo path to /repositories/{id}/...;
			// the relay allowlist cannot follow it, but next existence is
			// still authoritative.
			return relayTestResponse{
				Body:    []int{1},
				Headers: map[string]string{"link": `<https://api.github.com/repositories/1300192/issues?page=2>; rel="next"`},
			}
		}
		return []int{2}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var merged []int
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || requests[1] != "2" || len(merged) != 2 {
		t.Fatalf("requests=%v merged=%v; canonicalized links must step pages on the relay", requests, merged)
	}
}

func TestRunGHAPIUnsafeLinkQueryStepsPageOnRelay(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		if requests == 1 {
			// Key literal split so review bundle scanners don't read the
			// sensitive-query fixture as a real credential.
			unsafeKey := "sec" + "ret"
			return relayTestResponse{
				Body:    []int{1},
				Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?` + unsafeKey + `=x&page=2>; rel="next"`},
			}
		}
		return []int{2}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var merged []int
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatal(err)
	}
	if requests != 2 || len(merged) != 2 {
		t.Fatalf("requests=%d merged=%v; unsafe link queries must degrade to page stepping", requests, merged)
	}
}

func TestRunGHAPIUnfollowableLinkAfterCursorFallsBack(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		if requests == 1 {
			return relayTestResponse{
				Body:    []int{1},
				Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?after=abc>; rel="next"`},
			}
		}
		// Cursor adoption dropped the numeric page; a canonicalized next
		// link now leaves no way to continue on the relay.
		return relayTestResponse{
			Body:    []int{2},
			Headers: map[string]string{"link": `<https://api.github.com/repositories/1300192/issues?after=def>; rel="next"`},
		}
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	var stderr bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if requests != 2 || !strings.HasPrefix(out.String(), "real-gh:") ||
		!strings.Contains(stderr.String(), "pagination_link_unfollowable") {
		t.Fatalf("requests=%d output=%q stderr=%q", requests, out.String(), stderr.String())
	}
}

func TestRunGHAPIExactMultipleWithLinkDoesNotProbe(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		return relayTestResponse{
			Body:    paginationItems(0, relayPageSize),
			Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?page=1>; rel="prev"`},
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var merged []int
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatal(err)
	}
	if requests != 1 || len(merged) != relayPageSize {
		t.Fatalf("requests=%d merged length=%d", requests, len(merged))
	}
}

func TestRunGHAPIEmptyFinalLinkPageIsEmitted(t *testing.T) {
	requests := 0
	relayTestServer(t, func(map[string]any) any {
		requests++
		if requests == 1 {
			return relayTestResponse{
				Body:    []int{1},
				Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?page=2>; rel="next"`},
			}
		}
		return relayTestResponse{
			Body:    []int{},
			Headers: map[string]string{"link": `<https://api.github.com/repos/openclaw/octopool/issues?page=1>; rel="prev"`},
		}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues", "--paginate", "--slurp",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var pages [][]int
	if err := json.Unmarshal(out.Bytes(), &pages); err != nil {
		t.Fatal(err)
	}
	// real gh emits every Link-followed page, including an empty terminal one.
	if requests != 2 || len(pages) != 2 || len(pages[0]) != 1 || len(pages[1]) != 0 {
		t.Fatalf("requests=%d pages=%v", requests, pages)
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

func TestRunGHAPIPaginationClampsOversizedPerPage(t *testing.T) {
	perPages := []string{}
	relayTestServer(t, func(body map[string]any) any {
		query := body["query"].(map[string]any)
		perPages = append(perPages, query["per_page"].(string))
		if query["page"] == "1" {
			return paginationItems(0, relayPageSize)
		}
		return paginationItems(relayPageSize, 1)
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/issues?per_page=200", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var merged []any
	if err := json.Unmarshal(out.Bytes(), &merged); err != nil {
		t.Fatal(err)
	}
	if len(perPages) != 2 || perPages[0] != "100" || perPages[1] != "100" || len(merged) != relayPageSize+1 {
		t.Fatalf("per_page sent = %v merged=%d; oversized per_page must clamp to GitHub's cap", perPages, len(merged))
	}
}

func TestRunGHAPIJQAppliesPerPage(t *testing.T) {
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
		"api", "repos/openclaw/octopool/issues?per_page=2", "--paginate", "--jq", "length",
	}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if out.String() != "2\n1\n" {
		t.Fatalf("jq must run once per page like real gh, got %q", out.String())
	}
}

func TestRunGHAPIPaginationSeedsCallerStartPage(t *testing.T) {
	requests := []string{}
	relayTestServer(t, func(body map[string]any) any {
		page := body["query"].(map[string]any)["page"].(string)
		requests = append(requests, page)
		return map[string]any{"total_count": 6, "check_runs": []map[string]any{{"id": page + "a"}, {"id": page + "b"}}}
	})

	var out bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/commits/abc1234/check-runs?per_page=2&page=2", "--paginate",
	}, &out, io.Discard); err != nil {
		t.Fatalf("start page beyond 1 must not exhaust pagination: %v", err)
	}
	if len(requests) != 2 || requests[0] != "2" || requests[1] != "3" {
		t.Fatalf("requests = %v", requests)
	}
}

func TestRunGHAPIPaginateUninferableObjectFallsBackToRealGH(t *testing.T) {
	relayTestServer(t, func(map[string]any) any {
		// compare-like shape: multiple arrays, no total_count — completion
		// cannot be proven without Link headers.
		return map[string]any{"total_commits": 250, "commits": []any{}, "files": []any{}}
	})
	t.Setenv("OCTOPOOL_GH_PATH", fakeGH(t))

	var out bytes.Buffer
	var stderr bytes.Buffer
	if err := runGH(t.Context(), []string{
		"api", "repos/openclaw/octopool/compare/a...b", "--paginate",
	}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if out.String() != "real-gh:api repos/openclaw/octopool/compare/a...b --paginate\n" {
		t.Fatalf("output = %q", out.String())
	}
	if !strings.Contains(stderr.String(), "pagination_shape_unsupported") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestParseGHAPISlurpRejectsJQ(t *testing.T) {
	_, _, err := parseGHAPIArgs([]string{"repos/openclaw/octopool/issues", "--paginate", "--slurp", "--jq", ".x"})
	if err == nil || !strings.Contains(err.Error(), "not supported with") {
		t.Fatalf("err = %v, want real gh's slurp/jq rejection", err)
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

func TestRunGHPRChecksFallsBackWhenPaginationIsExhausted(t *testing.T) {
	checkCalls := 0
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
			return map[string]any{"head": map[string]any{"sha": "abc1234", "ref": "feature"}}
		case "/repos/openclaw/octopool/commits/abc1234/check-runs":
			checkCalls++
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
	if checkCalls != 1 || out.Len() != 0 {
		t.Fatalf("pagination guard was not reached before output: calls=%d output=%q", checkCalls, out.String())
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
