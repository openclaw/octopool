package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// Null is a no-op for native primitive fields, including after a duplicate
// non-null assignment. A pointer would incorrectly erase association evidence.
type runAssociation[T int64 | string] struct {
	value   T
	present bool
}

func (a *runAssociation[T]) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	if err := json.Unmarshal(raw, &a.value); err != nil {
		return err
	}
	a.present = true
	return nil
}

type runJobIdentity struct {
	ID      int64
	RunID   runAssociation[int64]  `json:"run_id"`
	Attempt runAssociation[int64]  `json:"run_attempt"`
	HeadSha runAssociation[string] `json:"head_sha"`
}

type runJobOwner struct {
	id      string
	headSHA string
	attempt uint64
}

var (
	errInvalidRunJobIdentity = errors.New("workflow jobs response included invalid or duplicate job IDs")
	errUnprovedRunJobHead    = errors.New("workflow job head could not be verified against owned run")
)

// The seen set belongs to the entire collection, not a page.
func (job runJobIdentity) validate(owner runJobOwner, seen map[int64]bool) error {
	if job.ID <= 0 || !safeRunExportInteger(job.ID) || seen[job.ID] || !safeRunExportInteger(job.RunID.value) {
		return errInvalidRunJobIdentity
	}
	if job.RunID.present && strconv.FormatInt(job.RunID.value, 10) != strings.TrimLeft(owner.id, "0") {
		return errors.New("workflow job did not match owned run")
	}
	if job.Attempt.present && (job.Attempt.value <= 0 || !safeRunExportInteger(job.Attempt.value) || uint64(job.Attempt.value) != owner.attempt) {
		return errors.New("workflow job did not match owned run attempt")
	}
	if job.HeadSha.present && job.HeadSha.value != "" {
		if owner.headSHA == "" {
			return errUnprovedRunJobHead
		}
		if job.HeadSha.value != owner.headSHA {
			return errors.New("workflow job did not match historical run head")
		}
	}
	seen[job.ID] = true
	return nil
}

// Keep raw identity checks and projection page-local while proving completeness
// across the entire collection, including APIs that omit pagination links.
func relayRunJobs[T any](ctx context.Context, client ghRelayClient, request ghAPIRequest, decodePage func(relayEnvelope, map[int64]bool) ([]T, int, error)) ([]T, error) {
	jobs := []T{}
	request.query = cloneQuery(request.query)
	request.query["per_page"] = strconv.Itoa(relayPageSize)
	seen := map[int64]bool{}
	total := 0
	for page := 1; page <= maxRelayPages; page++ {
		request.query["page"] = strconv.Itoa(page)
		envelope, err := client.do(ctx, request)
		if err != nil {
			return nil, err
		}
		pageJobs, pageTotal, err := decodePage(envelope, seen)
		if err != nil {
			return nil, err
		}
		if page == 1 {
			total = pageTotal
		} else if pageTotal != total {
			return nil, localFallbackError{Reason: "workflow jobs total_count changed during pagination"}
		}
		if total > maxRelayPages*relayPageSize {
			return nil, localFallbackError{Reason: "workflow jobs pagination exhausted"}
		}
		jobs = append(jobs, pageJobs...)
		link, linked := relayResponseHeader(envelope.Headers, "link")
		next, hasNext := relayNextLink(link)
		if len(jobs) > total || (len(jobs) == total && hasNext) {
			return nil, localFallbackError{Reason: "workflow jobs pagination contradicts total_count"}
		}
		if len(jobs) == total {
			return jobs, nil
		}
		// A short page is not proof of completion when the advertised total
		// still includes missing jobs (for example, partial rerun metadata).
		if len(pageJobs) < relayPageSize || (linked && !hasNext) {
			return nil, localFallbackError{Reason: "workflow jobs response is incomplete"}
		}
		if hasNext {
			if nextPage, ok := relayLinkNumericPage(next); !ok || nextPage != page+1 {
				return nil, localFallbackError{Reason: "workflow jobs pagination link is inconsistent"}
			}
		}
	}
	return nil, localFallbackError{Reason: "workflow jobs pagination exhausted"}
}
