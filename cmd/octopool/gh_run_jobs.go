package main

import (
	"bytes"
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
	HeadSha runAssociation[string] `json:"head_sha"`
}

type runJobOwner struct {
	id      string
	headSHA string
}

var (
	errInvalidRunJobIdentity = errors.New("workflow jobs response included invalid or duplicate job IDs")
	errUnprovedRunJobHead    = errors.New("workflow job head could not be verified against owned run")
)

// The seen set belongs to the entire collection, not a page. Attempts are not
// identity evidence: GitHub may return successful jobs reused from an older one.
func (job runJobIdentity) validate(owner runJobOwner, seen map[int64]bool) error {
	if job.ID <= 0 || !safeRunExportInteger(job.ID) || seen[job.ID] || !safeRunExportInteger(job.RunID.value) {
		return errInvalidRunJobIdentity
	}
	if job.RunID.present && strconv.FormatInt(job.RunID.value, 10) != strings.TrimLeft(owner.id, "0") {
		return errors.New("workflow job did not match owned run")
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
