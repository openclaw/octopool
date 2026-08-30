package main

const rewriteMaterialCandidateLimit = rewriteMaxRules * 32

type rewriteMaterialCandidate struct {
	start    int
	depth    int
	inString bool
	escaped  bool
}

// Recognize complete JSON rule objects wherever they appear in supported text.
// Each opening brace owns independent lexical state, so unrelated prose or a
// surrounding string cannot hide a later candidate. Ambiguous excess fails closed.
func (policy stringRewritePolicy) containsRuleMaterial(text string) bool {
	if len(policy.Rules) == 0 {
		return false
	}
	patterns := make(map[string]bool, len(policy.Rules))
	for _, rule := range policy.Rules {
		patterns[rule.Pattern] = true
	}
	active := make([]rewriteMaterialCandidate, 0, 8)
	attempts := 0
	for index := 0; index < len(text); index++ {
		char := text[index]
		next := active[:0]
		for _, candidate := range active {
			if candidate.inString {
				if candidate.escaped {
					candidate.escaped = false
				} else if char == '\\' {
					candidate.escaped = true
				} else if char == '"' {
					candidate.inString = false
				}
				next = append(next, candidate)
				continue
			}
			switch char {
			case '"':
				candidate.inString = true
			case '{':
				candidate.depth++
			case '}':
				candidate.depth--
				if candidate.depth == 0 {
					value, err := strictRewriteJSON([]byte(text[candidate.start:index+1]), rewriteMaxContent)
					if err == nil {
						if rule, ok := exactRewriteKeys(value, "pattern", "replacement"); ok {
							pattern, p := rule["pattern"].(string)
							_, r := rule["replacement"].(string)
							if p && r && patterns[pattern] {
								return true
							}
						}
					}
					continue
				}
			}
			next = append(next, candidate)
		}
		active = next
		if char == '{' {
			attempts++
			if attempts > rewriteMaterialCandidateLimit || len(active) >= rewriteMaterialCandidateLimit {
				return true
			}
			active = append(active, rewriteMaterialCandidate{start: index, depth: 1})
		}
	}
	return false
}
