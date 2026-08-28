package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"unicode/utf8"
)

// encoding/json replaces invalid UTF-8 and unpaired surrogates. Validate the
// lexical strings first so that decoding cannot silently repair protected text.
func validRewriteJSONUnicode(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	inString := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		code, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return false
		}
		if code >= 0xd800 && code <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return !inString
}

func strictRewriteJSON(data []byte, limit int) (any, error) {
	if len(data) > limit || !validRewriteJSONUnicode(data) {
		return nil, errRewritePolicy
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	value, err := rewriteJSONValue(dec, 0)
	if err != nil {
		return nil, errRewritePolicy
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errRewritePolicy
	}
	return value, nil
}

func rewriteJSONValue(dec *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, errRewritePolicy
	}
	token, err := dec.Token()
	if err != nil {
		return nil, errRewritePolicy
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		result := map[string]any{}
		for dec.More() {
			token, err := dec.Token()
			key, ok := token.(string)
			if err != nil || !ok {
				return nil, errRewritePolicy
			}
			if _, exists := result[key]; exists {
				return nil, errRewritePolicy
			}
			value, err := rewriteJSONValue(dec, depth+1)
			if err != nil {
				return nil, err
			}
			result[key] = value
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errRewritePolicy
		}
		return result, nil
	case '[':
		result := []any{}
		for dec.More() {
			value, err := rewriteJSONValue(dec, depth+1)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errRewritePolicy
		}
		return result, nil
	}
	return nil, errRewritePolicy
}

func exactRewriteKeys(value any, keys ...string) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(keys) {
		return nil, false
	}
	for _, key := range keys {
		if _, ok := object[key]; !ok {
			return nil, false
		}
	}
	return object, true
}
func rewriteInteger(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	integer, err := number.Int64()
	return integer, err == nil && integer > 0 && integer <= 9007199254740991
}
func parseStringRewritePolicy(data []byte, server bool) (stringRewritePolicy, error) {
	value, err := strictRewriteJSON(data, rewriteMaxDocument)
	if err != nil {
		return stringRewritePolicy{}, errRewritePolicy
	}
	keys := []string{"schema_version", "rules"}
	if server {
		keys = append(keys, "revision", "updated_at")
	}
	object, ok := exactRewriteKeys(value, keys...)
	if !ok {
		return stringRewritePolicy{}, errRewritePolicy
	}
	version, ok := rewriteInteger(object["schema_version"])
	if !ok || version != 1 {
		return stringRewritePolicy{}, errRewritePolicy
	}
	rawRules, ok := object["rules"].([]any)
	if !ok || len(rawRules) > rewriteMaxRules {
		return stringRewritePolicy{}, errRewritePolicy
	}
	rules := make([]stringRewriteRule, 0, len(rawRules))
	for _, raw := range rawRules {
		rule, ok := exactRewriteKeys(raw, "pattern", "replacement")
		if !ok {
			return stringRewritePolicy{}, errRewritePolicy
		}
		pattern, p := rule["pattern"].(string)
		replacement, r := rule["replacement"].(string)
		if !p || !r {
			return stringRewritePolicy{}, errRewritePolicy
		}
		rules = append(rules, stringRewriteRule{pattern, replacement})
	}
	policy, err := compileStringRewriteRules(rules)
	if err != nil {
		return policy, err
	}
	if server {
		var ok bool
		policy.Revision, ok = rewriteInteger(object["revision"])
		if !ok {
			return stringRewritePolicy{}, errRewritePolicy
		}
		policy.UpdatedAt, ok = object["updated_at"].(string)
		if !ok || !validRewriteTimestamp(policy.UpdatedAt) {
			return stringRewritePolicy{}, errRewritePolicy
		}
	}
	return policy, nil
}
