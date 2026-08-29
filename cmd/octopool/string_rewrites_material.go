package main

// Recognize complete JSON rule objects, including those in policy envelopes,
// arrays, and Markdown fences. Parse disjoint leaf objects only: linear scanning
// plus at most one JSON parse per byte, without interpreting arbitrary prose.
func (policy stringRewritePolicy) containsRuleMaterial(text string) bool {
	if len(policy.Rules) == 0 {
		return false
	}
	patterns := make(map[string]bool, len(policy.Rules))
	for _, rule := range policy.Rules {
		patterns[rule.Pattern] = true
	}
	start, objectDepth, arrayDepth := -1, 0, 0
	inString, escaped := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if inString {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			// Array strings can precede a rule object; their delimiters are data.
			if objectDepth > 0 || arrayDepth > 0 {
				inString = true
			}
		case '[':
			arrayDepth++
		case ']':
			if arrayDepth > 0 {
				arrayDepth--
			}
		case '{':
			objectDepth++
			start = i
		case '}':
			if objectDepth == 0 {
				continue
			}
			objectDepth--
			if start >= 0 {
				value, err := strictRewriteJSON([]byte(text[start:i+1]), rewriteMaxContent)
				if err == nil {
					if rule, ok := exactRewriteKeys(value, "pattern", "replacement"); ok {
						pattern, p := rule["pattern"].(string)
						_, r := rule["replacement"].(string)
						if p && r && patterns[pattern] {
							return true
						}
					}
				}
				start = -1
			}
		}
	}
	return false
}
