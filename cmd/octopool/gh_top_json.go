package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"time"
)

func writeBytes(ctx context.Context, stdout io.Writer, data []byte, jq string) error {
	if jq != "" {
		return runJQ(ctx, stdout, data, jq)
	}
	if _, err := io.Copy(stdout, bytes.NewReader(data)); err != nil {
		return err
	}
	if len(data) > 0 && !bytes.HasSuffix(data, []byte("\n")) {
		_, err := io.Copy(stdout, bytes.NewReader([]byte("\n")))
		return err
	}
	return nil
}

// Keep native nested struct field order and literal HTML characters in gh exports.
func marshalGHFields(value map[string]any, fields []string, fieldMap map[string][]string) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(filterJSONValue(value, fields, fieldMap)); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func writeGHViewJSON(ctx context.Context, stdout io.Writer, data []byte, jq string) error {
	if jq == "" {
		return writeBytes(ctx, stdout, data, "")
	}
	child, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, "jq", "-c", "--", jq)
	cmd.Stdin = bytes.NewReader(data)
	cmd.Stderr = io.Discard
	output, err := cmd.Output()
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.UseNumber()
	for {
		var value any
		if err := decoder.Decode(&value); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		// Native gh's jq printer uses raw strings, but compact, HTML-escaped JSON
		// for arrays and objects, including sorted nested object keys.
		switch value := value.(type) {
		case nil:
			_, err = fmt.Fprintln(stdout)
		case string:
			_, err = fmt.Fprintln(stdout, value)
		case json.Number:
			if _, integerErr := strconv.ParseInt(string(value), 10, 64); integerErr == nil {
				_, err = fmt.Fprintln(stdout, value)
			} else if number, floatErr := value.Float64(); floatErr == nil {
				if math.Trunc(number) == number {
					_, err = fmt.Fprintf(stdout, "%.0f\n", number)
				} else {
					_, err = fmt.Fprintf(stdout, "%.2f\n", number)
				}
			} else {
				return floatErr
			}
		default:
			err = json.NewEncoder(stdout).Encode(value)
		}
		if err != nil {
			return err
		}
	}
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
	headers := map[string]string{}
	if supportedJSONFields(opts, supported) {
		headers["x-octopool-public-shape"] = shape
	}
	if needsLivePRRead(opts.json) || freshReadRequested() {
		headers["cache-control"] = "max-age=0"
	}
	if len(headers) == 0 {
		return nil
	}
	return headers
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
