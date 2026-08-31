package main

import (
	"context"
	"io"
	"path/filepath"
)

const rewriteSnapshotBuffer = 64 << 10

func (prepared *rewritePreparation) context() context.Context {
	if prepared.ctx != nil {
		return prepared.ctx
	}
	return context.Background()
}

func (prepared *rewritePreparation) ensureSnapshotDirectory() error {
	if prepared.directory != "" {
		return nil
	}
	directory, closeDirectory, err := newRewritePrivateDirectory()
	if err != nil {
		return errRewriteBlocked
	}
	prepared.directory, prepared.closeDirectory = directory, closeDirectory
	return nil
}

func (prepared *rewritePreparation) registerSnapshot(path string) string {
	path = filepath.Clean(path)
	if prepared.snapshots == nil {
		prepared.snapshots = map[string]bool{}
	}
	prepared.snapshots[path] = true
	return path
}

// Always close the output, including on cancellation and failed/short writes.
// Read one byte beyond the expected length to detect growth without truncation.
func copyRewriteSnapshot(ctx context.Context, output io.WriteCloser, input io.Reader, expected, limit int64) (copied int64, err error) {
	defer func() {
		if closeErr := output.Close(); closeErr != nil {
			err = errRewriteBlocked
		}
	}()
	if expected < 0 || expected > limit {
		return 0, errRewriteBlocked
	}
	buffer := make([]byte, rewriteSnapshotBuffer)
	for {
		if err := ctx.Err(); err != nil {
			return copied, err
		}
		n, readErr := input.Read(buffer[:min(int64(len(buffer)), expected-copied+1)])
		if n > 0 {
			if int64(n) > expected-copied {
				return copied, errRewriteBlocked
			}
			written, writeErr := output.Write(buffer[:n])
			copied += int64(written)
			if writeErr != nil || written != n {
				return copied, errRewriteBlocked
			}
		}
		if readErr == io.EOF {
			if copied != expected {
				return copied, errRewriteBlocked
			}
			return copied, ctx.Err()
		}
		if readErr != nil || n == 0 {
			return copied, errRewriteBlocked
		}
	}
}
