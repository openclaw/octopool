import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseStringRewriteJSON } from "../src/string-rewrite-json";
import {
  compileStringRewriteRules,
  guardStringRewriteRead,
  rewriteString,
  STRING_REWRITE_LIMITS,
} from "../src/string-rewrites";

const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/string-rewrites.json", import.meta.url), "utf8"),
) as {
  cases: ({ name: string; rules: unknown; input: string } & (
    | { output: string }
    | { error: true }
  ))[];
  invalid_policies: { name: string; rules: unknown }[];
};

describe("shared string rewrite vectors", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const rules = compileStringRewriteRules(vector.rules);
      if ("error" in vector) {
        expect(() => rewriteString(vector.input, rules)).toThrow(
          "Request blocked by string protection",
        );
      } else {
        expect(rewriteString(vector.input, rules)).toBe(vector.output);
      }
    });
  }
  for (const vector of vectors.invalid_policies) {
    it(`rejects ${vector.name}`, () => {
      expect(() => compileStringRewriteRules(vector.rules)).toThrow(
        "Invalid string rewrite policy",
      );
    });
  }
});

describe("string rewrite limits and syntax", () => {
  it.each([
    [{ pattern: "a".repeat(257), replacement: "" }],
    [{ pattern: "🦞".repeat(65), replacement: "" }],
    [{ pattern: "a", replacement: "🦞".repeat(257) }],
    Array.from({ length: 129 }, (_, i) => ({ pattern: `value${i}`, replacement: "" })),
    Array.from({ length: 128 }, (_, i) => ({
      pattern: `value${i}`,
      replacement: "x".repeat(1_024),
    })),
  ])("rejects limits without echoing content %#", (rules) => {
    expect(() => compileStringRewriteRules(rules)).toThrow("Invalid string rewrite policy");
  });

  it.each([
    "[^^](?i)word",
    "[^](?i)word",
    "[]](?i)word",
    "[[:alpha:]]",
    "\\Aword",
    "word\\z",
    "a{1001}",
    "a++",
    "a(?<name>b)",
  ])("rejects unsupported syntax %s", (pattern) => {
    expect(() => compileStringRewriteRules([{ pattern, replacement: "" }])).toThrow(
      "Invalid string rewrite policy",
    );
  });

  it("allows escaped punctuation and controls", () => {
    const rules = compileStringRewriteRules([
      { pattern: "\\(\\[\\.\\]\\)\\a\\f\\r\\t\\v", replacement: "X" },
    ]);
    expect(rewriteString("([.])\x07\f\r\t\v", rules)).toBe("X");
  });

  it("bounds input, intermediate output, and invalid Unicode", () => {
    const rules = compileStringRewriteRules([
      { pattern: "a", replacement: "X".repeat(1_024) },
      { pattern: "X+", replacement: "" },
    ]);
    for (const text of ["a".repeat(1_025), "🦞".repeat(262_145), "\ud800", "\udfff"]) {
      expect(() => rewriteString(text, rules)).toThrow("Request blocked by string protection");
    }
    expect(() => rewriteString("x".repeat(STRING_REWRITE_LIMITS.contentBytes + 1), [])).toThrow();
    expect(rewriteString("x".repeat(STRING_REWRITE_LIMITS.contentBytes), [])).toHaveLength(
      STRING_REWRITE_LIMITS.contentBytes,
    );
  });

  it("handles many deletion matches without materializing an unbounded match array", () => {
    const rules = compileStringRewriteRules([{ pattern: "a", replacement: "" }]);
    expect(rewriteString("a".repeat(40_000), rules)).toBe("");
  });
});

describe("strict policy JSON", () => {
  it.each([
    '{"rules":[],"rules":[]}',
    '{"rules":[],"rul\\u0065s":[]}',
    '{"rules":[{"pattern":"a","pattern":"b"}]}',
    '{"a":"\\ud800"}',
    '{"\\udfff":1}',
    '{"a":01}',
    '{"a":1e999}',
    '{"a":true,}',
    "[1,]",
    "[[[[[[[[[[0]]]]]]]]]]",
    '{"a":1} {}',
    "\ufeff{}",
  ])("rejects ambiguous JSON %#", (text) => {
    expect(() => parseStringRewriteJSON(text)).toThrow();
  });

  it("decodes escaped string keys and values once", () => {
    expect(
      parseStringRewriteJSON(
        '{"rul\\u0065s":[{"pattern":"\\ud83e\\udd9e","replacement":"$1/$&"}]}',
      ),
    ).toEqual({ rules: [{ pattern: "🦞", replacement: "$1/$&" }] });
  });
});

describe("read protection", () => {
  const rules = compileStringRewriteRules([{ pattern: "internal-model", replacement: "public" }]);
  const base = { pool: "test", method: "GET", path: "/repos/example/project" };

  it.each([
    { path: "/repos/example/internal-model" },
    { path: "/repos/example/%69nternal-model" },
    { path: "/repos/example/%2569nternal-model" },
    { path: "/repos/example/%252569nternal-model" },
    { query: { q: ["safe", "internal-model"] } },
    { query: { "internal-model": "safe" } },
    { query: { q: "%69nternal-model" } },
    { query: { q: "%2569nternal-model" } },
    { query: { q: "\\u0069nternal-model" } },
    { query: { q: "%5Cu0069nternal-model" } },
    { query: { q: "100%" } },
    { query: { q: "%c0%af" } },
    { query: { q: "\ud800" } },
    { headers: { accept: "internal-model" } },
    { headers: { accept: "%69nternal-model" } },
  ])("blocks a match or ambiguous encoding %#", (fields) => {
    expect(() => guardStringRewriteRead({ ...base, ...fields }, rules)).toThrow(
      "Request blocked by string protection",
    );
  });

  it("inspects decoded segment boundaries and form-encoded query values", () => {
    const anchored = compileStringRewriteRules([{ pattern: "^internal-model$", replacement: "" }]);
    expect(() =>
      guardStringRewriteRead({ ...base, path: "/a%2Finternal-model" }, anchored),
    ).toThrow();
    const spaced = compileStringRewriteRules([{ pattern: "internal model", replacement: "" }]);
    expect(() =>
      guardStringRewriteRead({ ...base, query: { q: "internal+model" } }, spaced),
    ).toThrow();
  });

  it("preserves benign encoded text and does not rewrite structural fields", () => {
    const request = {
      ...base,
      query: { q: "public+text%20🦞" },
      headers: { accept: "application/json" },
    };
    const before = structuredClone(request);
    guardStringRewriteRead(request, rules);
    expect(request).toEqual(before);
  });

  it("bounds total inspected fields and preserves empty policy behavior", () => {
    expect(() =>
      guardStringRewriteRead(
        { ...base, query: { q: Array.from({ length: 1_025 }, () => "x".repeat(1_024)) } },
        rules,
      ),
    ).toThrow();
    expect(() => guardStringRewriteRead({ ...base, query: { q: "100%" } }, [])).not.toThrow();
  });
});
