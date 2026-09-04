package main

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func mergeHeaderFrame(code, remaining int) string {
	return fmt.Sprintf("HTTP/1.1 %d Synthetic\nX-Github-Request-Id: ABCD:1234:5678:90EF\r\nX-Ratelimit-Resource: core\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: %d\r\nX-Ratelimit-Used: 42\r\nX-Ratelimit-Reset: 1788523200\r\nRetry-After: 60\r\n\r\n", code, remaining)
}

func TestGHMergeHeaderCollector(t *testing.T) {
	base := mergeHeaderFrame(403, 0)
	field := func(value string) string { return strings.Replace(base, "Remaining: 0", "Remaining: "+value, 1) }
	add := func(header string) string { return strings.TrimSuffix(base, "\r\n") + header + "\r\n\r\n" }
	color := strings.ReplaceAll(base, "X-Ratelimit-Remaining:", "\x1b[1;34mX-Ratelimit-Remaining\x1b[m:")
	for _, test := range []struct {
		name, frame string
		valid       bool
	}{
		{"success", mergeHeaderFrame(200, 4958), true},
		{"forbidden_zero", base, true},
		{"forbidden_positive", mergeHeaderFrame(403, 4958), true},
		{"throttled", mergeHeaderFrame(429, 0), true},
		{"missing_optional", "HTTP/1.1 200 OK\n\r\n", true},
		{"http2_status", strings.Replace(base, "HTTP/1.1", "HTTP/2.0", 1), true},
		{"unknown_header", add("X-Unknown: secret-sentinel"), true},
		{"ansi_name", color, true},
		{"maximum_integer", field("9223372036854775807"), true},
		{"empty", "", false},
		{"truncated", strings.TrimSuffix(base, "\r\n"), false},
		{"partial_header", "HTTP/1.1 200 OK\nX-Github-Request-Id: ABCD:1234", false},
		{"lf_header", strings.ReplaceAll(base, "\r\n", "\n"), false},
		{"crlf_status", strings.Replace(base, "Synthetic\n", "Synthetic\r\n", 1), false},
		{"bad_status", strings.Replace(base, "403", "999", 1), false},
		{"unknown_protocol", strings.Replace(base, "HTTP/1.1", "HTTP/3.0", 1), false},
		{"negative", field("-1"), false},
		{"positive_sign", field("+1"), false},
		{"decimal", field("1.5"), false},
		{"overflow", field("9223372036854775808"), false},
		{"too_many_digits", field(strings.Repeat("0", 20)), false},
		{"empty_numeric", field(""), false},
		{"space_numeric", field("0 "), false},
		{"duplicate_numeric", add("x-ratelimit-remaining: 0"), false},
		{"joined_numeric", field("0, 0"), false},
		{"duplicate_id", add("X-Github-Request-Id: ABCD:1234"), false},
		{"duplicate_resource", add("X-Ratelimit-Resource: core"), false},
		{"joined_id", strings.Replace(base, "ABCD:1234:5678:90EF", "ABCD:1234,ABCD:1234", 1), false},
		{"bad_id", strings.Replace(base, "ABCD:1234:5678:90EF", "private-sentinel", 1), false},
		{"long_id", strings.Replace(base, "ABCD:1234:5678:90EF", strings.Repeat("A", 128)+":B", 1), false},
		{"bad_resource", strings.Replace(base, "Resource: core", "Resource: private-sentinel", 1), false},
		{"joined_resource", strings.Replace(base, "Resource: core", "Resource: core, core", 1), false},
		{"date_retry_after", strings.Replace(base, "Retry-After: 60", "Retry-After: Wed, 01 Jan 2025 00:00:00 GMT", 1), false},
		{"fold", add(" folded: 0"), false},
		{"no_space", add("X-Foo:value"), false},
		{"bad_name", add("X Foo: value"), false},
		{"nul", add("X-Foo: value\x00"), false},
		{"tab", field("\t0"), false},
		{"delete", add("X-Foo: value\x7f"), false},
		{"unicode", add("X-Foo: 日本"), false},
		{"escape_value", field("\x1b[31m0\x1b[m"), false},
		{"wrong_ansi", strings.Replace(color, "[1;34m", "[1m", 1), false},
		{"wrong_reset", strings.Replace(color, "\x1b[m", "\x1b[0m", 1), false},
		{"ansi_status", "\x1b[1;34m" + base, false},
		{"body", base + `{"private":"sentinel"}`, false},
		{"body_spoof", base + "X-Ratelimit-Remaining: 0\r\n", false},
		{"multiple_frames", base + base, false},
		{"leading_body", "secret-sentinel\n" + base, false},
		{"extra_blank", base + "\r\n", false},
		{"oversize_line", add("X-Pad: " + strings.Repeat("x", ghMergeHeaderLineLimit)), false},
		{"oversize_block", strings.TrimSuffix(base, "\r\n") + strings.Repeat("X-Pad: "+strings.Repeat("x", 4000)+"\r\n", 9) + "\r\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, fragment := range []int{1, 7, 4096, len(test.frame) + 1} {
				collector := &ghMergeHeaderCollector{}
				for pos := 0; pos < len(test.frame); pos += fragment {
					part := test.frame[pos:min(pos+fragment, len(test.frame))]
					if n, err := io.WriteString(collector, part); err != nil || n != len(part) {
						t.Fatal("collector must always drain")
					}
				}
				headers, ok := collector.result()
				if ok != test.valid {
					t.Fatalf("valid=%t want=%t fragment=%d", ok, test.valid, fragment)
				}
				if !ok && (headers != ghMergeHeaders{}) {
					t.Fatal("invalid block salvaged fields")
				}
				var output bytes.Buffer
				(&ghMergeDiagnostic{attempt: time.Now(), headers: collector}).writeTo(&output)
				if strings.Contains(output.String(), "sentinel") || strings.Contains(output.String(), "\x1b") {
					t.Fatal("raw output reached diagnostics")
				}
				if !ok && strings.Contains(output.String(), "http_status=") {
					t.Fatal("invalid block emitted claims")
				}
			}
		})
	}
}

func TestGHMergeHeaderBounds(t *testing.T) {
	// Limits include the newline bytes; exactly-full frames remain accepted.
	status := "HTTP/1.1 200 OK\n"
	for _, target := range []int{ghMergeHeaderLineLimit, ghMergeHeaderBlockLimit} {
		frame := status
		for len(frame)+2 < target {
			n := min(ghMergeHeaderLineLimit, target-len(frame)-2)
			frame += "X: " + strings.Repeat("x", n-5) + "\r\n"
		}
		frame += "\r\n"
		collector := &ghMergeHeaderCollector{}
		_, _ = io.WriteString(collector, frame)
		if _, ok := collector.result(); !ok || len(frame) != target {
			t.Fatalf("exact bound rejected: %d", target)
		}
		if n, err := io.WriteString(collector, strings.Repeat("x", 100000)); n != 100000 || err != nil {
			t.Fatal("overflow stopped drain")
		}
		if _, ok := collector.result(); ok {
			t.Fatal("trailing bytes preserved metadata")
		}
	}
}

func TestGHMergeIncludePolicyAndBudget(t *testing.T) {
	for _, pattern := range []string{"^--include$", "^--include=true$", "^true$"} {
		if ghMergeIncludeAllowed(testRewritePolicy(t, stringRewriteRule{pattern, "safe"}), []string{"pr", "merge"}, []string{"api"}) {
			t.Fatalf("generated spelling bypassed policy %q", pattern)
		}
	}
	policy := testRewritePolicy(t, stringRewriteRule{"private-sentinel", "safe"})
	for _, n := range []int{rewriteMaxContent - len(ghMergeIncludeFlag), rewriteMaxContent - len(ghMergeIncludeFlag) + 1} {
		args := []string{strings.Repeat("x", n)}
		want := n+len(ghMergeIncludeFlag) <= rewriteMaxContent
		if ghMergeIncludeAllowed(policy, args, nil) != want || ghMergeIncludeAllowed(policy, nil, args) != want {
			t.Fatal("generated flag byte budget incorrect")
		}
	}
}

func TestGHMergeIncludeFinalBudget(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{"private-sentinel", "safe"})
	for _, remaining := range []int{0, len(ghMergeIncludeFlag) - 1, len(ghMergeIncludeFlag)} {
		prepared := &rewritePreparation{ctx: t.Context(), outputBytes: rewriteMaxContent - remaining, mergeDiagnostics: &ghMergePreparation{}}
		defer prepared.cleanup()
		if err := prepareRewritePRLifecycle(policy, mergeDiagnosticArgs(), strings.NewReader(""), prepared); err != nil {
			t.Fatal("instrumentation budget rejected otherwise valid preparation")
		}
		want := remaining == len(ghMergeIncludeFlag)
		if prepared.mergeDiagnostics.captureHeaders != want || strings.Contains(strings.Join(prepared.args, " "), ghMergeIncludeFlag) != want {
			t.Fatal("final include budget not honored")
		}
		if prepared.outputBytes > rewriteMaxContent {
			t.Fatal("generated flag exceeded final budget")
		}
	}
	collector := &ghMergeHeaderCollector{}
	_, _ = io.WriteString(collector, "HTTP/1.1 200 OK\nX: "+strings.Repeat("x", ghMergeHeaderLineLimit-5)+"\r\n\r\n")
	if _, ok := collector.result(); !ok {
		t.Fatal("exactly 4 KiB header line rejected")
	}
}
