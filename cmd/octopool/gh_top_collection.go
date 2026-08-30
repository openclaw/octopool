package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
)

// These REST collections advertise total_count and numeric item IDs. Validate
// raw identities before projection; a stable SHA does not freeze page contents.
func relayCompleteCollection(ctx context.Context, client ghRelayClient, request ghAPIRequest, key string) ([]any, error) {
	items := []any{}
	seen := map[int64]bool{}
	total := int64(-1)
	request.query = cloneQuery(request.query)
	request.query["per_page"] = strconv.Itoa(relayPageSize)
	for page := 1; page <= maxRelayPages; page++ {
		request.query["page"] = strconv.Itoa(page)
		envelope, err := client.do(ctx, request)
		if err != nil {
			return nil, err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return nil, err
		}
		var response map[string]any
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.UseNumber()
		if err := decoder.Decode(&response); err != nil {
			return nil, err
		}
		count, countOK := response["total_count"].(json.Number)
		pageTotal, err := count.Int64()
		pageItems, itemsOK := response[key].([]any)
		if !countOK || err != nil || pageTotal < 0 || !itemsOK {
			return nil, localFallbackError{Reason: "pagination_shape_unsupported"}
		}
		if total == -1 {
			total = pageTotal
		}
		if pageTotal != total {
			return nil, localFallbackError{Reason: "pagination_changed"}
		}
		if total > maxRelayPages*relayPageSize {
			return nil, localFallbackError{Reason: "pagination_exhausted"}
		}
		expected := min(int(total)-len(items), relayPageSize)
		if len(pageItems) != expected {
			return nil, localFallbackError{Reason: "pagination_incomplete"}
		}
		for _, raw := range pageItems {
			item, _ := raw.(map[string]any)
			number, ok := item["id"].(json.Number)
			id, err := number.Int64()
			if !ok || err != nil || id <= 0 || seen[id] {
				return nil, localFallbackError{Reason: "pagination_identity_invalid"}
			}
			seen[id] = true
		}
		items = append(items, pageItems...)
		if int64(len(items)) == total {
			return items, nil
		}
	}
	return nil, localFallbackError{Reason: "pagination_exhausted"}
}
