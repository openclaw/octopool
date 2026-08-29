import { parseStringRewriteJSON } from "./string-rewrite-json";

// Disjoint complete leaf JSON objects cover rule arrays, policy envelopes and
// Markdown fences without treating pattern text in ordinary prose as a policy.
export function containsRuleMaterial(input: string, patterns: ReadonlySet<string>): boolean {
  if (patterns.size === 0) return false;
  let start = -1;
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    // Array strings can precede a rule object; their delimiters are data.
    if (char === '"' && (objectDepth > 0 || arrayDepth > 0)) inString = true;
    else if (char === "[") arrayDepth++;
    else if (char === "]" && arrayDepth > 0) arrayDepth--;
    else if (char === "{") {
      objectDepth++;
      start = i;
    } else if (char === "}" && objectDepth > 0) {
      objectDepth--;
      if (start >= 0) {
        try {
          const rule = parseStringRewriteJSON(input.slice(start, i + 1));
          if (
            typeof rule === "object" &&
            rule !== null &&
            !Array.isArray(rule) &&
            Object.keys(rule).length === 2 &&
            "pattern" in rule &&
            "replacement" in rule &&
            typeof rule.pattern === "string" &&
            typeof rule.replacement === "string" &&
            patterns.has(rule.pattern)
          )
            return true;
        } catch {
          // Unrelated prose or malformed JSON is not recognized policy material.
        }
        start = -1;
      }
    }
  }
  return false;
}
