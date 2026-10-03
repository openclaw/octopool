package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const nativeJournalName = "native-delegations.jsonl"
const nativeJournalLimit = 2 * 1024 * 1024

type nativeDelegation struct {
	TS          time.Time `json:"ts"`
	Version     string    `json:"version"`
	PPID        int       `json:"ppid"`
	Parent      string    `json:"parent"`
	Grandparent string    `json:"grandparent"`
	Shape       string    `json:"shape"`
	Category    string    `json:"category"`
	GraphQL     *bool     `json:"graphql"`
	Fresh       bool      `json:"fresh"`
}

type nativeJournalCategoryKey struct{}

func withNativeFallback(ctx context.Context, reason error) context.Context {
	category := "local-fallback:other"
	var fallback localFallbackError
	if errors.Is(reason, errOctopoolNotLoggedIn) {
		category = "local-fallback:not_logged_in"
	} else if errors.As(reason, &fallback) {
		category = "local-fallback:" + nativeFallbackReason(fallback.Reason)
	}
	return context.WithValue(ctx, nativeJournalCategoryKey{}, category)
}

func nativeFallbackReason(reason string) string {
	// Relay messages and local errors can contain arbitrary request material.
	// Only fixed reason codes cross this boundary; never serialize err.Error().
	switch reason {
	case "jq_unavailable", "pagination_exhausted", "pagination_link_unfollowable", "pagination_shape_unsupported",
		"pagination_changed", "pagination_incomplete", "pagination_identity_invalid", "unsupported_pr_detail_export",
		"unsupported_run_export", "unsupported_graphql_landing_shape", "unsupported_graphql_merge_snapshot",
		"unsupported_graphql_read_response", "graphql_relay_unavailable", "unknown_pr_comment_viewer", "pr_comment_viewer_changed",
		"unsupported_search_filter", "unsupported_pr_search_filter", "unsupported_repo_search_query", "unsupported_search_query",
		"issue_number_is_pull_request", "local_credentials_required", "route_denied", "private_repo", "private_repository",
		"repo_not_public", "identities_cooling_down", "identity_pool_depleted", "github_identity_depleted",
		"github_rate_limited", "relay_overloaded", "web_only_unavailable", "relay_timeout", "relay_storage_unavailable",
		"github_identity_unauthorized", "github_identity_forbidden", "github_response_too_large", "logs_denied",
		"no_identity", "owner_denied", "repo_public_check_failed", "search_denied":
		return reason
	}
	if nativeJournalMetadataReasons[reason] {
		return "metadata_incomplete"
	}
	if strings.HasPrefix(reason, "relay_timeout (") {
		return "relay_timeout"
	}
	return "other"
}

var nativeJournalMetadataReasons = map[string]bool{
	"repository response did not include a node ID":                        true,
	"repository response did not include a complete owner":                 true,
	"repository response did not include a valid visibility":               true,
	"check response did not match pull request head":                       true,
	"check response did not include app and suite identity":                true,
	"workflow run response did not match pull request head":                true,
	"workflow run response did not include suite and workflow identity":    true,
	"ambiguous workflow runs for check suite":                              true,
	"missing workflow association for GitHub Actions check suite":          true,
	"workflow run response did not include run_attempt":                    true,
	"pull request response did not include user identity":                  true,
	"unsupported pull request user lookup":                                 true,
	"user response did not include matching complete identity":             true,
	"pull request response did not include checks head identity":           true,
	"invalid check timestamp":                                              true,
	"workflow jobs response did not include a valid total_count":           true,
	"workflow jobs pagination contradicts total_count or page size":        true,
	"workflow jobs pagination exhausted":                                   true,
	"workflow jobs total_count changed during pagination":                  true,
	"workflow jobs pagination contradicts total_count":                     true,
	"workflow jobs response is incomplete":                                 true,
	"workflow jobs pagination link is inconsistent":                        true,
	"workflow jobs response included invalid identity metadata":            true,
	"pull request response did not include maintainer modification status": true,
	"unsupported pull request auto-merge shape":                            true,
	"pull request response did not include merged status":                  true,
	"pull request response did not include merge commit identity":          true,
	"pull request response did not include merged_by":                      true,
	"pull request response did not include author":                         true,
	"pull request response did not include head.sha":                       true,
	"pull request head changed during metadata hydration":                  true,
	"unsupported pull request file shape":                                  true,
	"unsupported pull request author identity":                             true,
	"unsupported pull request bot login":                                   true,
	"pull request author profile type changed":                             true,
	"unsupported pull request author type":                                 true,
	"pull request response did not include labels array":                   true,
	"unsupported pull request label shape":                                 true,
}

// Called only at native child boundaries, after protection and routing decisions.
// Nothing from this best-effort observer is allowed onto the command's streams.
func journalNativeDelegation(ctx context.Context, args, env []string, category string) {
	if restWriteEnv(env, "OCTOPOOL_NATIVE_JOURNAL") == "0" {
		return
	}
	shape := describeNativeShape(args)
	if category == "" {
		category, _ = ctx.Value(nativeJournalCategoryKey{}).(string)
	}
	if category == "" {
		category = shape.category(args)
	}
	parent, grandparent := nativeJournalParents()
	cliVersion := version
	if cliVersion == "dev" {
		if built, _, _ := buildInfoVersion(); built != "" {
			cliVersion = built
		}
	}
	_, fresh := lookupNativeJournalEnv(env, "OCTOPOOL_FRESH")
	entry := nativeDelegation{
		TS: time.Now().UTC().Truncate(time.Second), Version: cliVersion, PPID: os.Getppid(),
		Parent: parent, Grandparent: grandparent, Shape: shape.text, Category: category,
		GraphQL: shape.graphql, Fresh: fresh,
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')
	if cache, err := os.UserCacheDir(); err == nil {
		directory := filepath.Join(cache, "octopool")
		if os.MkdirAll(directory, 0700) == nil && appendNativeJournal(directory, line) == nil {
			return
		}
	}
	if directory, err := fallbackRelaySlotDirectory(); err == nil {
		_ = appendNativeJournal(directory, line)
	}
}

func lookupNativeJournalEnv(env []string, name string) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		key, value, ok := strings.Cut(env[i], "=")
		if ok && (key == name || runtime.GOOS == "windows" && strings.EqualFold(key, name)) {
			return value, true
		}
	}
	return "", false
}

func appendNativeJournal(directory string, line []byte) error {
	path := filepath.Join(directory, nativeJournalName)
	file, err := openNativeJournalFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err == nil && info.Size() > nativeJournalLimit {
		_ = file.Close()
		if err := rotateNativeJournal(path); err != nil {
			return err
		}
		file, err = openNativeJournalFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND)
		if err != nil {
			return err
		}
	}
	defer file.Close()
	if err != nil {
		return err
	}
	_, err = file.Write(line) // one O_APPEND write; deliberately no fsync
	return err
}

func rotateNativeJournal(path string) error {
	// Only rotation takes a lock. Ordinary concurrent O_APPEND writes must not
	// drop desktop bursts. A writer racing a rename can land in the .1 generation.
	lock, err := openNativeJournalFile(path+".lock", os.O_CREATE|os.O_RDWR)
	if err != nil {
		return err
	}
	defer lock.Close()
	locked, err := tryLockRelaySlot(lock)
	if err != nil || !locked {
		return err // contention defers rotation, not the append
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return os.ErrPermission
	}
	if info.Size() <= nativeJournalLimit {
		return nil
	}
	if err := os.Remove(path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(path, path+".1")
}
