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
	pages := make([]relayEnvelope, 0, maxRelayPages)

	for pageIndex := 0; pageIndex < maxRelayPages; pageIndex++ {
		envelope, err := client.do(ctx, request)
		if err != nil {
			return err
		}
		if envelope.Status >= 400 {
			return writeGHBody(ctx, stdout, envelope, request.jq)
		}
		pages = append(pages, envelope)

		hasNext := false
		if envelope.BodyEncoding == "json" && validPerPage && validPage {
			body, decodeErr := decodeRelayBody(envelope)
			if decodeErr != nil {
				return decodeErr
			}
			hasNext = relayPageHasNext(body, perPage, &state)
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

func relayPageHasNext(body []byte, perPage int, state *ghAPIPaginationState) bool {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return false
	}
	switch typed := value.(type) {
	case []any:
		return len(typed) == perPage
	case map[string]any:
		totalCount, ok := jsonNumericInt(typed["total_count"])
		if !ok {
			return false
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
				return false
			}
			arrayKey = key
			pageItems = len(items)
		}
		if arrayKey == "" {
			return false
		}
		if state.objectArrayKey == "" {
			state.objectArrayKey = arrayKey
		} else if state.objectArrayKey != arrayKey {
			return false
		}
		state.objectItems += pageItems
		return state.objectItems < totalCount && pageItems > 0
	default:
		return false
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
	var output bytes.Buffer
	if slurp {
		output.WriteByte('[')
	}
	for index, envelope := range pages {
		body, err := decodeRelayBody(envelope)
		if err != nil {
			return err
		}
		if slurp {
			if !json.Valid(body) {
				return errors.New("cannot slurp a non-JSON response")
			}
			if index > 0 {
				output.WriteByte(',')
			}
		}
		output.Write(body)
	}
	if slurp {
		output.WriteByte(']')
	}
	return writeBytes(ctx, stdout, output.Bytes(), jq)
}
