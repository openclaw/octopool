import { queries } from "./generated/sql";
import { HttpError, jsonResponse } from "./http";
import { isRecord } from "./object";
import { parseStringRewriteJSON, readStringRewriteJSON } from "./string-rewrite-json";
import {
  compileStringRewriteRules,
  hasExactKeys,
  invalidStringRewritePolicy,
  STRING_REWRITE_LIMITS,
  utf8Size,
  type CompiledStringRewriteRule,
  type StringRewriteRule,
} from "./string-rewrites";

type StringRewritePolicy = {
  schema_version: 1;
  revision: number;
  updated_at: string;
  rules: StringRewriteRule[];
};

function unavailable(): HttpError {
  return new HttpError(
    503,
    "string_rewrite_policy_unavailable",
    "String protection policy unavailable",
  );
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export async function loadStringRewritePolicy(env: Env): Promise<{
  policy: StringRewritePolicy;
  compiled: CompiledStringRewriteRule[];
}> {
  try {
    // Every request starts at the primary, never the isolate config cache or a
    // potentially stale read replica. Missing migration/row is not an empty policy.
    const row: unknown = await env.DB.withSession("first-primary")
      .prepare(queries.getStringRewritePolicy)
      .first();
    if (
      !isRecord(row) ||
      row.schema_version !== 1 ||
      !revision(row.revision) ||
      typeof row.updated_at !== "string" ||
      typeof row.rules_json !== "string" ||
      new Date(row.updated_at).toISOString() !== row.updated_at
    )
      throw unavailable();
    utf8Size(row.rules_json, STRING_REWRITE_LIMITS.policyBytes, unavailable);
    const compiled = compileStringRewriteRules(parseStringRewriteJSON(row.rules_json));
    const policy: StringRewritePolicy = {
      schema_version: 1,
      revision: row.revision,
      updated_at: row.updated_at,
      rules: compiled.map(({ pattern, replacement }) => ({ pattern, replacement })),
    };
    utf8Size(JSON.stringify(policy), STRING_REWRITE_LIMITS.policyBytes, unavailable);
    return { policy, compiled };
  } catch {
    // Do not expose D1/engine errors or let relay overload mapping authorize fallback.
    throw unavailable();
  }
}

export async function getStringRewritePolicy(env: Env): Promise<Response> {
  return jsonResponse((await loadStringRewritePolicy(env)).policy);
}

export async function putStringRewritePolicy(request: Request, env: Env): Promise<Response> {
  let expectedRevision: number;
  let rules: StringRewriteRule[];
  try {
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") throw invalidStringRewritePolicy();
    const value = await readStringRewriteJSON(request, STRING_REWRITE_LIMITS.policyBytes);
    if (
      !hasExactKeys(value, ["schema_version", "expected_revision", "rules"]) ||
      value.schema_version !== 1 ||
      !revision(value.expected_revision) ||
      value.expected_revision >= Number.MAX_SAFE_INTEGER
    )
      throw invalidStringRewritePolicy();
    expectedRevision = value.expected_revision;
    rules = compileStringRewriteRules(value.rules).map(({ pattern, replacement }) => ({
      pattern,
      replacement,
    }));
  } catch {
    throw invalidStringRewritePolicy();
  }
  const current = await loadStringRewritePolicy(env);
  if (current.policy.revision !== expectedRevision) throw conflict();
  const updatedAt = new Date().toISOString();
  // Any accepted policy must also fit the caller's bounded GET decoder.
  utf8Size(
    JSON.stringify({
      schema_version: 1,
      revision: expectedRevision + 1,
      updated_at: updatedAt,
      rules,
    }),
    STRING_REWRITE_LIMITS.policyBytes,
    invalidStringRewritePolicy,
  );
  let result: { revision: number; updated_at: string } | null;
  try {
    result = await env.DB.withSession("first-primary")
      .prepare(queries.replaceStringRewritePolicy)
      .bind(updatedAt, JSON.stringify(rules), expectedRevision)
      .first<{ revision: number; updated_at: string }>();
  } catch {
    throw unavailable();
  }
  if (result === null) throw conflict();
  return jsonResponse({
    schema_version: 1,
    revision: result.revision,
    updated_at: result.updated_at,
    rule_count: rules.length,
  });
}

function conflict(): HttpError {
  return new HttpError(
    409,
    "string_rewrite_revision_conflict",
    "String protection policy revision conflict",
  );
}
