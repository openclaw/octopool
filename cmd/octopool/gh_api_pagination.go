package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/url"
	"strconv"
	"strings"
)

type ghAPIPaginationState struct {
	objectArrayKey string
	objectItems    int
}

func prepareGHAPIPagination(request ghAPIRequest) ghAPIRequest {
	if raw, ok := request.query["per_page"]; !ok {
		request.query["per_page"] = strconv.Itoa(relayPageSize)
	} else if perPage, valid := positiveQueryInt(raw); valid && perPage > relayPageSize {
		// GitHub caps per_page at 100; clamping keeps the short-page has-next
		// inference sound instead of stopping after one silently capped page.
		request.query["per_page"] = strconv.Itoa(relayPageSize)
	}
	if _, ok := request.query["page"]; !ok {
		request.query["page"] = "1"
	}
	return request
}

func relayPaginatedGHAPI(
	ctx context.Context,
	client ghRelayClient,
	request ghAPIRequest,
	stdout io.Writer,
) error {
	perPage, validPerPage := positiveQueryInt(request.query["per_page"])
	page, validPage := positiveQueryInt(request.query["page"])
	state := ghAPIPaginationState{}
	if validPerPage && validPage {
		// total_count covers the whole collection; count the pages a
		// caller-supplied start page skipped so has-next stays accurate.
		state.objectItems = (page - 1) * perPage
	}
	pages := make([]relayEnvelope, 0, maxRelayPages)

	for pageIndex := 0; pageIndex < maxRelayPages; pageIndex++ {
		envelope, err := client.do(ctx, request)
		if err != nil {
			return err
		}
		if envelope.Status >= 400 {
			return writeGHBody(ctx, stdout, envelope, request.jq)
		}

		if link, ok := relayResponseHeader(envelope.Headers, "link"); ok {
			nextTarget, hasNext := relayNextLink(link)
			// Every Link-followed page is one real gh would fetch and emit —
			// even an empty terminal page. Probe suppression is only for the
			// header-less heuristic, whose extra fetch real gh never makes.
			pages = append(pages, envelope)
			if !hasNext {
				return writeGHAPIPages(ctx, stdout, pages, request.jq, request.slurp)
			}
			if pageIndex == maxRelayPages-1 {
				return localFallbackError{Reason: "pagination_exhausted"}
			}
			if nextRequest, ok := relayNextPageRequest(request, nextTarget); ok {
				request = nextRequest
				continue
			}
			// GitHub may canonicalize next links (e.g. /repositories/{id}/...),
			// which the relay's route allowlist cannot follow. When the link
			// itself paginates numerically, adopt its page number on the
			// original relay path; cursor-style links cannot be replayed and
			// must go to real gh.
			if nextPage, ok := relayLinkNumericPage(nextTarget); ok {
				request.query["page"] = strconv.Itoa(nextPage)
				continue
			}
			return localFallbackError{Reason: "pagination_link_unfollowable"}
		}

		perPage, validPerPage = positiveQueryInt(request.query["per_page"])
		page, validPage = positiveQueryInt(request.query["page"])
		if envelope.BodyEncoding != "json" || !validPerPage || !validPage {
			return localFallbackError{Reason: "pagination_shape_unsupported"}
		}
		body, decodeErr := decodeRelayBody(envelope)
		if decodeErr != nil {
			return decodeErr
		}
		hasNext, empty, inferable := relayPageHasNext(body, perPage, &state)
		if !inferable {
			// Without Link headers the relay can only prove completion for
			// plain arrays and total_count object lists; anything else (e.g.
			// compare's total_commits shape) must keep real gh's semantics.
			return localFallbackError{Reason: "pagination_shape_unsupported"}
		}
		// A full previous page forces one probe fetch; when the probe comes
		// back empty it carries no data and must not appear in the output.
		if !empty || pageIndex == 0 {
			pages = append(pages, envelope)
		}
		if !hasNext {
			return writeGHAPIPages(ctx, stdout, pages, request.jq, request.slurp)
		}
		if pageIndex == maxRelayPages-1 {
			return localFallbackError{Reason: "pagination_exhausted"}
		}
		page++
		request.query["page"] = strconv.Itoa(page)
	}

	return localFallbackError{Reason: "pagination_exhausted"}
}

func relayResponseHeader(headers map[string]string, name string) (string, bool) {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value, true
		}
	}
	return "", false
}

func relayNextLink(header string) (string, bool) {
	for _, entry := range splitRelayLinkHeader(header) {
		open := strings.IndexByte(entry, '<')
		if open < 0 {
			continue
		}
		closeOffset := strings.IndexByte(entry[open+1:], '>')
		if closeOffset < 0 {
			continue
		}
		closeIndex := open + 1 + closeOffset
		for _, parameter := range strings.Split(entry[closeIndex+1:], ";") {
			key, value, ok := strings.Cut(parameter, "=")
			if !ok || !strings.EqualFold(strings.TrimSpace(key), "rel") {
				continue
			}
			value = strings.TrimSpace(value)
			if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
				value = value[1 : len(value)-1]
			}
			for _, relation := range strings.Fields(value) {
				if strings.EqualFold(relation, "next") {
					return strings.TrimSpace(entry[open+1 : closeIndex]), true
				}
			}
		}
	}
	return "", false
}

func splitRelayLinkHeader(header string) []string {
	entries := make([]string, 0, 4)
	start := 0
	inAngle := false
	inQuote := false
	escaped := false
	for index := 0; index < len(header); index++ {
		character := header[index]
		if inQuote {
			if escaped {
				escaped = false
				continue
			}
			if character == '\\' {
				escaped = true
			} else if character == '"' {
				inQuote = false
			}
			continue
		}
		switch character {
		case '<':
			inAngle = true
		case '>':
			inAngle = false
		case '"':
			inQuote = true
		case ',':
			if !inAngle {
				entries = append(entries, strings.TrimSpace(header[start:index]))
				start = index + 1
			}
		}
	}
	entries = append(entries, strings.TrimSpace(header[start:]))
	return entries
}

func relayNextPageRequest(request ghAPIRequest, target string) (ghAPIRequest, bool) {
	nextURL, err := url.Parse(target)
	if err != nil || nextURL.Path == "" || nextURL.Path != request.path {
		return request, false
	}
	values, err := url.ParseQuery(nextURL.RawQuery)
	if err != nil {
		return request, false
	}
	query := make(map[string]any, len(values))
	for key, items := range values {
		switch len(items) {
		case 1:
			query[key] = items[0]
		case 0:
		default:
			query[key] = items
		}
	}
	nextRequest := request
	nextRequest.query = query
	if !safeRelayRequest(nextRequest) {
		return request, false
	}
	return nextRequest, true
}

func positiveQueryInt(value any) (int, bool) {
	raw, ok := value.(string)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.Atoi(raw)
	return parsed, err == nil && parsed > 0
}

func relayLinkNumericPage(target string) (int, bool) {
	nextURL, err := url.Parse(target)
	if err != nil {
		return 0, false
	}
	values, err := url.ParseQuery(nextURL.RawQuery)
	if err != nil {
		return 0, false
	}
	pages, ok := values["page"]
	if !ok || len(pages) != 1 {
		return 0, false
	}
	return positiveQueryInt(pages[0])
}

func relayPageHasNext(body []byte, perPage int, state *ghAPIPaginationState) (hasNext bool, empty bool, inferable bool) {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return false, false, false
	}
	switch typed := value.(type) {
	case []any:
		return len(typed) == perPage, len(typed) == 0, true
	case map[string]any:
		totalCount, ok := jsonNumericInt(typed["total_count"])
		if !ok {
			return false, false, false
		}
		arrayKey := ""
		pageItems := 0
		for key, candidate := range typed {
			if key == "incomplete_results" {
				continue
			}
			items, isArray := candidate.([]any)
			if !isArray {
				continue
			}
			if arrayKey != "" {
				return false, false, false
			}
			arrayKey = key
			pageItems = len(items)
		}
		if arrayKey == "" {
			return false, false, false
		}
		if state.objectArrayKey == "" {
			state.objectArrayKey = arrayKey
		} else if state.objectArrayKey != arrayKey {
			return false, false, false
		}
		state.objectItems += pageItems
		return state.objectItems < totalCount && pageItems > 0, pageItems == 0, true
	default:
		return false, false, false
	}
}

func jsonNumericInt(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number < 0 || math.Trunc(number) != number {
		return 0, false
	}
	parsed := int(number)
	if parsed < 0 || float64(parsed) != number {
		return 0, false
	}
	return parsed, true
}

func writeGHAPIPages(
	ctx context.Context,
	stdout io.Writer,
	pages []relayEnvelope,
	jq string,
	slurp bool,
) error {
	bodies := make([][]byte, 0, len(pages))
	for _, envelope := range pages {
		body, err := decodeRelayBody(envelope)
		if err != nil {
			return err
		}
		if slurp && !json.Valid(body) {
			return errors.New("cannot slurp a non-JSON response")
		}
		bodies = append(bodies, body)
	}
	// real gh evaluates --jq once per response page; only --slurp collapses
	// the pages into a single jq input.
	if jq != "" && !slurp {
		for _, body := range bodies {
			if err := writeBytes(ctx, stdout, body, jq); err != nil {
				return err
			}
		}
		return nil
	}
	var output bytes.Buffer
	switch {
	case slurp:
		output.WriteByte('[')
		for index, body := range bodies {
			if index > 0 {
				output.WriteByte(',')
			}
			output.Write(body)
		}
		output.WriteByte(']')
	case mergedArrayPages(bodies, &output):
		// real gh coalesces paginated REST array pages into one JSON array.
	default:
		for _, body := range bodies {
			output.Write(body)
		}
	}
	return writeBytes(ctx, stdout, output.Bytes(), jq)
}

// mergedArrayPages writes one combined JSON array when every page is a
// top-level array. This matches real gh, verified empirically: `gh api
// 'repos/o/r/labels?per_page=4' --paginate` over 3 pages emits ONE array
// (`jq -s length` == 1) — gh coalesces REST array pages unless --slurp asks
// for an array of pages.
func mergedArrayPages(bodies [][]byte, output *bytes.Buffer) bool {
	interiors := make([][]byte, 0, len(bodies))
	for _, body := range bodies {
		trimmed := bytes.TrimSpace(body)
		if len(trimmed) < 2 || trimmed[0] != '[' || trimmed[len(trimmed)-1] != ']' {
			return false
		}
		interior := bytes.TrimSpace(trimmed[1 : len(trimmed)-1])
		if len(interior) > 0 {
			interiors = append(interiors, interior)
		}
	}
	output.WriteByte('[')
	for index, interior := range interiors {
		if index > 0 {
			output.WriteByte(',')
		}
		output.Write(interior)
	}
	output.WriteByte(']')
	return true
}
