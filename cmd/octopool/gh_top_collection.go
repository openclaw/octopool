package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
)

func relayCompleteCollection(ctx context.Context, client ghRelayClient, request ghAPIRequest, key string) ([]map[string]any, error) {
	items := []map[string]any{}
	err := relayCollectionPages(ctx, client, request, key, func(page []map[string]any) (bool, error) {
		items = append(items, page...)
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

// These REST collections advertise total_count and numeric item IDs. Validate
// each whole page before visiting it; a stable SHA does not freeze page contents.
// The visitor may stop once it has enough data without claiming completeness.
func relayCollectionPages(ctx context.Context, client ghRelayClient, request ghAPIRequest, key string, visit func([]map[string]any) (bool, error)) error {
	seen := map[int64]bool{}
	total := int64(-1)
	collected := 0
	request.query = cloneQuery(request.query)
	request.query["per_page"] = strconv.Itoa(relayPageSize)
	for page := 1; page <= maxRelayPages; page++ {
		request.query["page"] = strconv.Itoa(page)
		envelope, err := client.do(ctx, request)
		if err != nil {
			return err
		}
		body, err := envelopeBodyBytes(envelope)
		if err != nil {
			return err
		}
		var response map[string]any
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.UseNumber()
		if err := decoder.Decode(&response); err != nil {
			return err
		}
		count, countOK := response["total_count"].(json.Number)
		pageTotal, err := count.Int64()
		pageItems, itemsOK := response[key].([]any)
		if !countOK || err != nil || pageTotal < 0 || !itemsOK {
			return localFallbackError{Reason: "pagination_shape_unsupported"}
		}
		if total == -1 {
			total = pageTotal
		}
		if pageTotal != total {
			return localFallbackError{Reason: "pagination_changed"}
		}
		if total > maxRelayPages*relayPageSize {
			return localFallbackError{Reason: "pagination_exhausted"}
		}
		expected := min(int(total)-collected, relayPageSize)
		if len(pageItems) != expected {
			return localFallbackError{Reason: "pagination_incomplete"}
		}
		objects := make([]map[string]any, len(pageItems))
		for i, raw := range pageItems {
			item, _ := raw.(map[string]any)
			number, ok := item["id"].(json.Number)
			id, err := number.Int64()
			if !ok || err != nil || id <= 0 || seen[id] {
				return localFallbackError{Reason: "pagination_identity_invalid"}
			}
			seen[id] = true
			objects[i] = item
		}
		collected += len(pageItems)
		stop, err := visit(objects)
		if err != nil {
			return err
		}
		if stop || int64(collected) == total {
			return nil
		}
	}
	return localFallbackError{Reason: "pagination_exhausted"}
}
