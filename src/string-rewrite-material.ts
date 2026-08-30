import { parseStringRewriteJSON } from "./string-rewrite-json";

const MATERIAL_CANDIDATE_LIMIT = 128 * 32;

type MaterialCandidate = {
  start: number;
  depth: number;
  inString: boolean;
  escaped: boolean;
};

// Recognize complete JSON rule objects wherever they appear in supported text.
// Each opening brace owns independent lexical state, so unrelated prose or a
// surrounding string cannot hide a later candidate. Ambiguous excess fails closed.
export function containsRuleMaterial(input: string, patterns: ReadonlySet<string>): boolean {
  if (patterns.size === 0) return false;
  let active: MaterialCandidate[] = [];
  let attempts = 0;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next: MaterialCandidate[] = [];
    for (const candidate of active) {
      if (candidate.inString) {
        if (candidate.escaped) candidate.escaped = false;
        else if (char === "\\") candidate.escaped = true;
        else if (char === '"') candidate.inString = false;
        next.push(candidate);
        continue;
      }
      if (char === '"') candidate.inString = true;
      else if (char === "{") candidate.depth++;
      else if (char === "}") {
        candidate.depth--;
        if (candidate.depth === 0) {
          try {
            const rule = parseStringRewriteJSON(input.slice(candidate.start, index + 1));
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
            // This candidate was prose or malformed JSON; later candidates remain independent.
          }
          continue;
        }
      }
      next.push(candidate);
    }
    active = next;
    if (char === "{") {
      attempts++;
      if (attempts > MATERIAL_CANDIDATE_LIMIT || active.length >= MATERIAL_CANDIDATE_LIMIT)
        return true;
      active.push({ start: index, depth: 1, inString: false, escaped: false });
    }
  }
  return false;
}
