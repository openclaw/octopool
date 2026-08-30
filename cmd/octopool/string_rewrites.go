package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"regexp/syntax"
	"strings"
	"unicode/utf8"
)

const (
	rewriteMaxRules       = 128
	rewriteMaxPattern     = 256
	rewriteMaxReplacement = 1024
	rewriteMaxDocument    = 65536
	rewriteMaxContent     = 1048576
)

var (
	errRewritePolicy  = errors.New("string rewrite policy unavailable or invalid")
	errRewriteBlocked = errors.New("string rewrite protection blocked unsupported or unsafe input; use a documented typed gh command or REST shape")
)

type stringRewriteRule struct {
	Pattern     string `json:"pattern"`
	Replacement string `json:"replacement"`
}
type compiledRewriteRule struct {
	stringRewriteRule
	re    *regexp.Regexp
	empty *syntax.Regexp
}
type stringRewritePolicy struct {
	Rules     []compiledRewriteRule
	Revision  int64
	UpdatedAt string
}

// V1 intentionally excludes engine-specific escapes and group extensions.
func portableRewritePattern(pattern string) bool {
	inClass := false
	classFirst := false
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		if c == '\\' {
			i++
			if i == len(pattern) || !strings.ContainsRune(`\.*+?()|[]{}^$-/bBwWdDsSnrtfav`, rune(pattern[i])) {
				return false
			}
			classFirst = false
			continue
		}
		if inClass {
			if c == '[' && i+1 < len(pattern) && pattern[i+1] == ':' {
				return false
			}
			if c == ']' && !classFirst {
				inClass = false
			}
			classFirst = false
			continue
		}
		if c == '[' {
			inClass, classFirst = true, true
			if i+1 < len(pattern) && pattern[i+1] == '^' {
				i++
			}
		} else if c == '(' && i+1 < len(pattern) && pattern[i+1] == '?' && (i+2 >= len(pattern) || pattern[i+2] != ':') {
			return false
		}
	}
	return true
}

func compileStringRewriteRules(rules []stringRewriteRule) (stringRewritePolicy, error) {
	if len(rules) > rewriteMaxRules {
		return stringRewritePolicy{}, errRewritePolicy
	}
	var document bytes.Buffer
	encoder := json.NewEncoder(&document)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"schema_version": 1, "rules": rules}); err != nil || document.Len()-1 > rewriteMaxDocument {
		return stringRewritePolicy{}, errRewritePolicy
	}
	policy := stringRewritePolicy{}
	seen := map[string]bool{}
	for _, rule := range rules {
		if !utf8.ValidString(rule.Pattern) || !utf8.ValidString(rule.Replacement) || len(rule.Pattern) > rewriteMaxPattern || len(rule.Replacement) > rewriteMaxReplacement || seen[rule.Pattern] || !portableRewritePattern(rule.Pattern) {
			return stringRewritePolicy{}, errRewritePolicy
		}
		re, err := regexp.Compile(rule.Pattern)
		if err != nil || re.MatchString("") {
			return stringRewritePolicy{}, errRewritePolicy
		}
		seen[rule.Pattern] = true
		parsed, err := syntax.Parse(rule.Pattern, syntax.Perl)
		if err != nil {
			return stringRewritePolicy{}, errRewritePolicy
		}
		var empty *syntax.Regexp
		if rewriteCanMatchEmpty(parsed, ^syntax.EmptyOp(0)) {
			empty = parsed
		}
		policy.Rules = append(policy.Rules, compiledRewriteRule{rule, re, empty})
	}
	return policy, nil
}

func mergeStringRewritePolicies(server, local stringRewritePolicy) (stringRewritePolicy, error) {
	rules := make([]stringRewriteRule, 0, len(server.Rules)+len(local.Rules))
	seen := map[string]string{}
	for _, set := range [][]compiledRewriteRule{server.Rules, local.Rules} {
		for _, rule := range set {
			if replacement, ok := seen[rule.Pattern]; ok {
				if replacement != rule.Replacement {
					return stringRewritePolicy{}, errRewritePolicy
				}
				continue
			}
			seen[rule.Pattern] = rule.Replacement
			rules = append(rules, rule.stringRewriteRule)
		}
	}
	merged, err := compileStringRewriteRules(rules)
	merged.Revision, merged.UpdatedAt = server.Revision, server.UpdatedAt
	return merged, err
}

func (policy stringRewritePolicy) check(text string) error {
	if len(text) > rewriteMaxContent || !utf8.ValidString(text) {
		return errRewriteBlocked
	}
	for _, rule := range policy.Rules {
		if rule.re.MatchString(text) {
			return errRewriteBlocked
		}
	}
	return nil
}

func (policy stringRewritePolicy) rewrite(text string) (string, error) {
	if len(text) > rewriteMaxContent || !utf8.ValidString(text) {
		return "", errRewriteBlocked
	}
	if policy.containsRuleMaterial(text) {
		return "", errRewriteBlocked
	}
	matches := 0
	for _, rule := range policy.Rules {
		// At most one match per input byte plus the terminal empty match. This keeps
		// match storage finite without re-running anchors against sliced strings.
		spans := rule.re.FindAllStringIndex(text, rewriteMaxContent+1)
		matches += len(spans)
		if matches > rewriteMaxContent {
			return "", errRewriteBlocked
		}
		size := len(text)
		for index, span := range spans {
			if span[0] == span[1] {
				return "", errRewriteBlocked
			}
			// Go's FindAll suppresses an empty match directly after a consuming
			// match. Check that skipped boundary in the original input context.
			if rule.empty != nil && (index+1 == len(spans) || spans[index+1][0] > span[1]) {
				before, after := rune(-1), rune(-1)
				if span[1] > 0 {
					before, _ = utf8.DecodeLastRuneInString(text[:span[1]])
				}
				if span[1] < len(text) {
					after, _ = utf8.DecodeRuneInString(text[span[1]:])
				}
				if rewriteCanMatchEmpty(rule.empty, syntax.EmptyOpContext(before, after)) {
					return "", errRewriteBlocked
				}
			}
			size += len(rule.Replacement) - (span[1] - span[0])
		}
		if size > rewriteMaxContent {
			return "", errRewriteBlocked
		}
		if len(spans) == 0 {
			continue
		}
		var out strings.Builder
		out.Grow(size)
		previous := 0
		for _, span := range spans {
			out.WriteString(text[previous:span[0]])
			out.WriteString(rule.Replacement)
			previous = span[1]
		}
		out.WriteString(text[previous:])
		text = out.String()
	}
	if policy.containsRuleMaterial(text) {
		return "", errRewriteBlocked
	}
	if err := policy.check(text); err != nil {
		return "", err
	}
	return text, nil
}

func rewriteCanMatchEmpty(re *syntax.Regexp, context syntax.EmptyOp) bool {
	switch re.Op {
	case syntax.OpEmptyMatch, syntax.OpStar, syntax.OpQuest:
		return true
	case syntax.OpBeginLine:
		return context&syntax.EmptyBeginLine != 0
	case syntax.OpEndLine:
		return context&syntax.EmptyEndLine != 0
	case syntax.OpBeginText:
		return context&syntax.EmptyBeginText != 0
	case syntax.OpEndText:
		return context&syntax.EmptyEndText != 0
	case syntax.OpWordBoundary:
		return context&syntax.EmptyWordBoundary != 0
	case syntax.OpNoWordBoundary:
		return context&syntax.EmptyNoWordBoundary != 0
	case syntax.OpCapture, syntax.OpPlus:
		return rewriteCanMatchEmpty(re.Sub[0], context)
	case syntax.OpRepeat:
		return re.Min == 0 || rewriteCanMatchEmpty(re.Sub[0], context)
	case syntax.OpAlternate:
		for _, sub := range re.Sub {
			if rewriteCanMatchEmpty(sub, context) {
				return true
			}
		}
		return false
	case syntax.OpConcat:
		for _, sub := range re.Sub {
			if !rewriteCanMatchEmpty(sub, context) {
				return false
			}
		}
		return true
	default:
		return false
	}
}
