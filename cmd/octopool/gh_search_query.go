package main

import (
	"fmt"
	"regexp"
	"strings"
)

// Keep this grammar in sync with src/policy.ts. Validate the complete query
// before creating a client so unsupported searches never spend relay quota.
var searchRepoTerm = regexp.MustCompile(`^repo:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var searchLoginTerm = regexp.MustCompile(`^(?:app/)?[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
var searchNameTerm = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)
var quotedSearchTerm = regexp.MustCompile(`^"[\x20-\x21\x23-\x39\x3b-\x5b\x5d-\x7e]+"$`)

const searchDateTerm = `\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])`

var searchDateFilter = regexp.MustCompile(`^(?:(?:>=?|<=?)?` + searchDateTerm + `|` + searchDateTerm + `\.\.` + searchDateTerm + `)$`)
var searchSortTerm = regexp.MustCompile(`^(created|updated|comments|reactions)(-asc|-desc)?$`)

func tokenizeScopedSearch(raw string) ([]string, bool) {
	if len(raw) > 4096 {
		return nil, false
	}
	var terms []string
	start, quoted := 0, false
	for i := 0; i <= len(raw); i++ {
		if i < len(raw) && raw[i] == '"' {
			quoted = !quoted
		}
		if i == len(raw) || (!quoted && strings.ContainsRune(" \t\r\n", rune(raw[i]))) {
			if i > start {
				terms = append(terms, raw[start:i])
				if len(terms) > 128 {
					return nil, false
				}
			}
			start = i + 1
		}
	}
	return terms, !quoted
}

func nonblankQuotedSearchTerm(term string) bool {
	return quotedSearchTerm.MatchString(term) && strings.TrimSpace(term[1:len(term)-1]) != ""
}

func allowedScopedSearchTerm(token string) bool {
	term := strings.TrimPrefix(token, "-")
	negated := term != token
	if strings.HasPrefix(term, "-") || strings.EqualFold(term, "OR") || strings.EqualFold(term, "AND") || strings.EqualFold(term, "NOT") {
		return false
	}
	if allowedSearchTerm.MatchString(term) {
		return true
	}
	if nonblankQuotedSearchTerm(term) {
		return !negated
	}
	qualifier, value, ok := strings.Cut(term, ":")
	if !ok {
		return false
	}
	switch qualifier {
	case "type":
		return value == "issue" || value == "pr"
	case "state":
		return value == "open" || value == "closed"
	case "is":
		switch value {
		case "open", "closed", "merged", "unmerged", "issue", "pr", "draft", "locked", "unlocked":
			return true
		case "public":
			return !negated
		}
	case "author", "assignee", "mentions", "commenter", "involves", "reviewed-by", "review-requested":
		return searchLoginTerm.MatchString(value)
	case "label", "milestone":
		return searchNameTerm.MatchString(value) || nonblankQuotedSearchTerm(value)
	case "no":
		return value == "label" || value == "milestone" || value == "assignee"
	case "in":
		for _, part := range strings.Split(value, ",") {
			if part != "title" && part != "body" && part != "comments" {
				return false
			}
		}
		return true
	case "created", "updated", "closed", "merged":
		return searchDateFilter.MatchString(value)
	case "draft":
		return value == "true" || value == "false"
	case "review":
		return value == "none" || value == "required" || value == "approved" || value == "changes_requested"
	case "status":
		return value == "pending" || value == "success" || value == "failure"
	case "base", "head":
		return searchNameTerm.MatchString(value)
	case "sort":
		return searchSortTerm.MatchString(value)
	}
	return false
}

func scopedSearchQuery(repo, kind, raw string, opts ghTopOptions) (string, bool) {
	terms, ok := tokenizeScopedSearch(raw)
	if !ok || !searchRepoTerm.MatchString("repo:"+repo) {
		return "", false
	}
	for _, term := range terms {
		if !allowedScopedSearchTerm(term) {
			return "", false
		}
	}
	state := opts.state
	if opts.read.has("--search") {
		if state == "" {
			state = "open"
		}
		// Native list drops even explicit --state open for these search clauses
		// (cli/cli pkg/cmd/pr/shared.QueryHasStateClause).
		if state == "open" {
			for _, term := range terms {
				if term == "is:closed" || term == "is:merged" || term == "state:closed" || strings.HasPrefix(term, "merged:") || strings.HasPrefix(term, "closed:") {
					state = ""
					break
				}
			}
		}
	}
	parts := []string{fmt.Sprintf("repo:%s", repo), "type:" + kind}
	switch state {
	case "open", "closed":
		parts = append(parts, "state:"+state)
	case "merged":
		if kind != "pr" {
			return "", false
		}
		parts = append(parts, "is:merged")
	case "", "all":
	default:
		return "", false
	}
	parts = append(parts, terms...)
	if opts.read.has("--search") {
		for _, filter := range []struct{ name, value string }{{"author", opts.author}, {"assignee", opts.assignee}} {
			if filter.value != "" {
				if !searchLoginTerm.MatchString(filter.value) {
					return "", false
				}
				parts = append(parts, filter.name+":"+filter.value)
			}
		}
		for _, label := range opts.labels {
			value := label
			if !searchNameTerm.MatchString(value) {
				value = `"` + label + `"`
				if !nonblankQuotedSearchTerm(value) || strings.ContainsAny(label, ",\r\n") {
					return "", false
				}
			}
			parts = append(parts, "label:"+value)
		}
	}
	q := strings.Join(parts, " ")
	return q, len(q) <= 4096 && len(parts) <= 128
}
