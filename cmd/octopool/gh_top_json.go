package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

func writeBytes(ctx context.Context, stdout io.Writer, data []byte, jq string) error {
	if jq != "" {
		return runJQ(ctx, stdout, data, jq)
	}
	_, err := stdout.Write(data)
	if len(data) > 0 && !bytes.HasSuffix(data, []byte("\n")) {
		_, _ = fmt.Fprintln(stdout)
	}
	return err
}

func supportedJSONFields(opts ghTopOptions, supported map[string]bool) bool {
	for _, field := range opts.json {
		if !supported[field] {
			return false
		}
	}
	return true
}

func publicShapeHeaders(opts ghTopOptions, supported map[string]bool, shape string) map[string]string {
	if supportedJSONFields(opts, supported) {
		return map[string]string{"x-octopool-public-shape": shape}
	}
	return nil
}

func envelopeBodyBytes(envelope relayEnvelope) ([]byte, error) {
	body, err := decodeRelayBody(envelope)
	if err == nil && envelope.Status >= 400 {
		err = fmt.Errorf("github returned status %d", envelope.Status)
	}
	return bytes.TrimSpace(body), err
}

func envelopeCollectionPage(envelope relayEnvelope, key string) ([]any, int, error) {
	body, err := envelopeBodyBytes(envelope)
	if err != nil {
		return nil, 0, err
	}
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, 0, err
	}
	items, ok := response[key].([]any)
	if !ok {
		labels := map[string]string{
			"check_runs": "check-runs",
			"statuses":   "status",
			"jobs":       "workflow jobs",
		}
		return nil, 0, fmt.Errorf("%s response did not include %s", labels[key], key)
	}
	total := len(items)
	if value, ok := response["total_count"].(float64); ok {
		total = int(value)
	}
	return items, total, nil
}

func filterJSONFields(raw []byte, fields []string, fieldMap map[string][]string) ([]byte, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	filtered := filterJSONValue(value, fields, fieldMap)
	return json.Marshal(filtered)
}

func filterJSONValue(value any, fields []string, fieldMap map[string][]string) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, filterJSONValue(item, fields, fieldMap))
		}
		return out
	case map[string]any:
		if runs, ok := typed["workflow_runs"].([]any); ok {
			return filterJSONValue(runs, fields, fieldMap)
		}
		if checks, ok := typed["check_runs"].([]any); ok {
			return filterJSONValue(checks, fields, fieldMap)
		}
		if workflows, ok := typed["workflows"].([]any); ok {
			return filterJSONValue(workflows, fields, fieldMap)
		}
		out := map[string]any{}
		for _, field := range fields {
			if value, ok := mappedValue(typed, field, fieldMap); ok {
				out[field] = value
			}
		}
		return out
	default:
		return value
	}
}

func mappedValue(input map[string]any, field string, fieldMap map[string][]string) (any, bool) {
	paths := [][]string{{field}}
	if mapped := fieldMap[field]; len(mapped) > 0 {
		paths = append([][]string{mapped}, paths...)
	}
	for _, path := range paths {
		if value, ok := valueAtPath(input, path...); ok {
			if field == "defaultBranchRef" {
				if name, ok := value.(string); ok {
					return map[string]any{"name": name}, true
				}
			}
			return value, true
		}
	}
	return nil, false
}

func valueAtPath(input map[string]any, path ...string) (any, bool) {
	var value any = input
	for _, part := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return value, true
}

func firstString(item map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key].(string); ok {
			return value
		}
	}
	return ""
}

func nestedStringValue(item map[string]any, path ...string) string {
	value, ok := valueAtPath(item, path...)
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}

func nestedString(input map[string]any, path ...string) (string, bool) {
	value, ok := valueAtPath(input, path...)
	if !ok {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}
