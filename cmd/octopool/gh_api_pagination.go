package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
)

type ghAPIPaginationState struct {
	objectArrayKey string
	objectItems    int
}

func prepareGHAPIPagination(request ghAPIRequest) ghAPIRequest {
	if _, ok := request.query["per_page"]; !ok {
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

		hasNext := false
		empty := false
		if envelope.BodyEncoding == "json" && validPerPage && validPage {
			body, decodeErr := decodeRelayBody(envelope)
			if decodeErr != nil {
				return decodeErr
			}
			hasNext, empty = relayPageHasNext(body, perPage, &state)
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

func positiveQueryInt(value any) (int, bool) {
	raw, ok := value.(string)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.Atoi(raw)
	return parsed, err == nil && parsed > 0
}

func relayPageHasNext(body []byte, perPage int, state *ghAPIPaginationState) (hasNext bool, empty bool) {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return false, false
	}
	switch typed := value.(type) {
	case []any:
		return len(typed) == perPage, len(typed) == 0
	case map[string]any:
		totalCount, ok := jsonNumericInt(typed["total_count"])
		if !ok {
			return false, false
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
				return false, false
			}
			arrayKey = key
			pageItems = len(items)
		}
		if arrayKey == "" {
			return false, false
		}
		if state.objectArrayKey == "" {
			state.objectArrayKey = arrayKey
		} else if state.objectArrayKey != arrayKey {
			return false, false
		}
		state.objectItems += pageItems
		return state.objectItems < totalCount && pageItems > 0, pageItems == 0
	default:
		return false, false
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
// top-level array, matching real gh's --paginate output for REST lists.
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
