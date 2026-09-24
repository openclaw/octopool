package main

import (
	"context"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const relaySlotWait = 30 * time.Second

type relaySlotContextKey struct{}

func relayConcurrency() int {
	count, err := strconv.Atoi(strings.TrimSpace(os.Getenv("OCTOPOOL_RELAY_CONCURRENCY")))
	if err != nil || count < 0 {
		return 8
	}
	return count
}

// A relay attempt owns its policy fetch (including policy retries) and POST.
// Standalone policy fetches share the same slots without nested acquisition.
func withRelaySlot(ctx context.Context) (context.Context, func()) {
	if ctx.Value(relaySlotContextKey{}) != nil {
		return ctx, func() {}
	}
	file := acquireRelaySlot(ctx, relayConcurrency(), relaySlotWait)
	// Mark even fail-open attempts so a nested policy fetch cannot wait again.
	ctx = context.WithValue(ctx, relaySlotContextKey{}, true)
	return ctx, func() {
		if file != nil {
			_ = file.Close()
		}
	}
}

func acquireRelaySlot(ctx context.Context, count int, wait time.Duration) *os.File {
	if count <= 0 || ctx.Err() != nil {
		return nil
	}
	deadline := time.Now().Add(wait)
	cache, err := os.UserCacheDir()
	if err != nil {
		return nil
	}
	directory := filepath.Join(cache, "octopool", "relay-slots")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil
	}
	backoff := 20 * time.Millisecond
	for {
		start := rand.IntN(count)
		for offset := 0; offset < count; offset++ {
			if ctx.Err() != nil || !time.Now().Before(deadline) {
				return nil
			}
			// Keep files in place: unlinking a locked inode would split the pool.
			file, err := os.OpenFile(filepath.Join(directory, "slot-"+strconv.Itoa(start)), os.O_CREATE|os.O_RDWR, 0600)
			if err != nil {
				return nil
			}
			locked, err := tryLockRelaySlot(file)
			if locked {
				return file
			}
			_ = file.Close()
			if err != nil {
				return nil
			}
			start++
			if start == count {
				start = 0
			}
		}
		delay := backoff + time.Duration(rand.Int64N(int64(backoff)))
		if sleepContext(ctx, min(delay, max(time.Until(deadline), 0))) != nil {
			return nil
		}
		backoff = min(2*backoff, 100*time.Millisecond)
	}
}
