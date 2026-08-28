import { RE2JS } from "re2js";
import { HttpError } from "./http";
import { isRecord } from "./object";
import type { RelayRequest } from "./types";

export const STRING_REWRITE_LIMITS = {
  rules: 128,
  patternBytes: 256,
  replacementBytes: 1_024,
  policyBytes: 65_536,
  contentBytes: 1_048_576,
} as const;

export type StringRewriteRule = { pattern: string; replacement: string };
export type CompiledStringRewriteRule = StringRewriteRule & { regex: RE2JS };
const encoder = new TextEncoder();

export function invalidStringRewritePolicy(): HttpError {
  return new HttpError(400, "invalid_string_rewrite_policy", "Invalid string rewrite policy");
}

function denied(): HttpError {
  return new HttpError(403, "string_rewrite_denied", "Request blocked by string protection");
}

export function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function utf8Size(value: string, limit: number, error: () => Error): number {
  if (value.length > limit || !value.isWellFormed()) throw error();
  const size = encoder.encode(value).length;
  if (size > limit) throw error();
  return size;
}

// Scan syntax, never run user patterns through the native JS regexp engine.
// RE2JS then validates the grammar; this gate removes dialect-specific constructs.
function validatePatternSubset(pattern: string): void {
  let inClass = false;
  let classFirst = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      const escaped = pattern[++i];
      if (escaped === undefined || !"\\.^$|?*+()[]{}-/bBdDsSwWnrtfav".includes(escaped)) {
        throw invalidStringRewritePolicy();
      }
      classFirst = false;
      continue;
    }
    if (inClass) {
      if (char === "[" && pattern[i + 1] === ":") throw invalidStringRewritePolicy();
      if (char === "]" && !classFirst) inClass = false;
      classFirst = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      classFirst = true;
      if (pattern[i + 1] === "^") i++;
    } else if (char === "(" && pattern[i + 1] === "?" && pattern[i + 2] !== ":") {
      throw invalidStringRewritePolicy();
    }
  }
}

export function compileStringRewriteRules(value: unknown): CompiledStringRewriteRule[] {
  try {
    if (!Array.isArray(value) || value.length > STRING_REWRITE_LIMITS.rules)
      throw invalidStringRewritePolicy();
    utf8Size(
      JSON.stringify({ schema_version: 1, rules: value }),
      STRING_REWRITE_LIMITS.policyBytes,
      invalidStringRewritePolicy,
    );
    const seen = new Set<string>();
    return value.map((rule) => {
      if (
        !hasExactKeys(rule, ["pattern", "replacement"]) ||
        typeof rule.pattern !== "string" ||
        typeof rule.replacement !== "string"
      ) {
        throw invalidStringRewritePolicy();
      }
      utf8Size(rule.pattern, STRING_REWRITE_LIMITS.patternBytes, invalidStringRewritePolicy);
      utf8Size(
        rule.replacement,
        STRING_REWRITE_LIMITS.replacementBytes,
        invalidStringRewritePolicy,
      );
      if (seen.has(rule.pattern)) throw invalidStringRewritePolicy();
      seen.add(rule.pattern);
      validatePatternSubset(rule.pattern);
      const regex = RE2JS.compile(rule.pattern, RE2JS.DISABLE_UNICODE_GROUPS);
      if (regex.matcher("").find()) throw invalidStringRewritePolicy();
      return { pattern: rule.pattern, replacement: rule.replacement, regex };
    });
  } catch {
    // Engine errors may contain the pattern; never let them reach logs/responses.
    throw invalidStringRewritePolicy();
  }
}

export function assertNoStringRewriteMatch(
  input: string,
  rules: readonly CompiledStringRewriteRule[],
): void {
  utf8Size(input, STRING_REWRITE_LIMITS.contentBytes, denied);
  try {
    for (const rule of rules) if (rule.regex.matcher(input).find()) throw denied();
  } catch {
    throw denied();
  }
}

export function rewriteString(input: string, rules: readonly CompiledStringRewriteRule[]): string {
  utf8Size(input, STRING_REWRITE_LIMITS.contentBytes, denied);
  let output = input;
  let matches = 0;
  try {
    for (const rule of rules) {
      const matcher = rule.regex.matcher(output);
      let offset = 0;
      let size = 0;
      let next = "";
      let chunks: string[] = [];
      const append = (text: string) => {
        size += utf8Size(text, STRING_REWRITE_LIMITS.contentBytes, denied);
        if (size > STRING_REWRITE_LIMITS.contentBytes) throw denied();
        chunks.push(text);
        if (chunks.length >= 1_024) {
          next += chunks.join("");
          chunks = [];
        }
      };
      while (matcher.find()) {
        if (++matches > STRING_REWRITE_LIMITS.contentBytes) throw denied();
        const start = matcher.start();
        const end = matcher.end();
        if (start === end || start < offset) throw denied();
        // RE2JS string match spans are UTF-16 offsets, including astral characters.
        append(output.slice(offset, start));
        append(rule.replacement);
        offset = end;
      }
      append(output.slice(offset));
      output = next + chunks.join("");
    }
    assertNoStringRewriteMatch(output, rules);
    return output;
  } catch {
    throw denied();
  }
}

export function guardStringRewriteRead(
  request: RelayRequest,
  rules: readonly CompiledStringRewriteRule[],
): void {
  if (rules.length === 0) return;
  let bytes = 0;
  const inspect = (value: string) => {
    bytes += utf8Size(value, STRING_REWRITE_LIMITS.contentBytes, denied);
    if (bytes > STRING_REWRITE_LIMITS.contentBytes) throw denied();
    // The envelope has already decoded JSON strings. An embedded escape layer is
    // ambiguous, so reject it instead of letting a downstream decoder uncover it.
    if (value.includes("\\")) throw denied();
    assertNoStringRewriteMatch(value, rules);
  };
  const field = (value: string, query = false): string => {
    inspect(value);
    let decoded: string;
    try {
      decoded = decodeURIComponent(query ? value.replaceAll("+", " ") : value);
    } catch {
      throw denied();
    }
    // A second percent layer is not supported, including %2569 and %252569.
    if (/%[0-9a-fA-F]{2}/.test(decoded)) throw denied();
    if (decoded !== value) inspect(decoded);
    return decoded;
  };
  const decodedPath = field(request.path);
  for (const segment of request.path.split("/")) inspect(segment);
  for (const segment of decodedPath.split("/")) inspect(segment);
  for (const [key, raw] of Object.entries(request.query ?? {})) {
    field(key, true);
    for (const value of Array.isArray(raw) ? raw : [raw]) field(value, true);
  }
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    field(key);
    field(value);
  }
}
