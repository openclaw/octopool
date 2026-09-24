import { DurableObject } from "cloudflare:workers";
import { queries } from "./generated/sql";
import { errorResponse, HttpError, jsonResponse } from "./http";
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

export type StringRewritePolicy = {
  schema_version: 1;
  revision: number;
  updated_at: string;
  rules: StringRewriteRule[];
};

export const POLICY_SNAPSHOT_MAX_AGE_MS = 60_000;

type Snapshot = {
  policy: StringRewritePolicy;
  compiled: CompiledStringRewriteRule[];
  loadedAt: number;
};

export function stringRewritePolicyUnavailable(): HttpError {
  return new HttpError(
    503,
    "string_rewrite_policy_unavailable",
    "String protection policy unavailable",
  );
}

export function policyCoordinatorStub(env: Env): DurableObjectStub<PolicyCoordinator> {
  // This name is an authority boundary: every pool, reader and writer uses it.
  const id = env.POLICY_COORDINATOR.idFromName("string-rewrite-policy");
  return env.POLICY_COORDINATOR.get(id, { locationHint: "wnam" });
}

export class PolicyCoordinator extends DurableObject<Env> {
  private snapshot: Snapshot | undefined;

  override async fetch(request: Request): Promise<Response> {
    try {
      const current = this.freshSnapshot();
      if (request.method === "GET" && current !== undefined) {
        return jsonResponse(current.policy);
      }
      // Parse the bounded body before taking the gate; slow uploads do not block reads.
      const update = request.method === "PUT" ? await parseUpdate(request) : undefined;
      return await this.ctx.blockConcurrencyWhile(async () => {
        // Catch inside the gate so expected failures do not reset the object.
        try {
          let snapshot = this.freshSnapshot();
          if (snapshot === undefined) {
            // An expired snapshot cannot survive a failed refresh.
            this.snapshot = undefined;
            snapshot = await this.readPrimary();
            this.snapshot = snapshot;
          }
          if (update === undefined) return jsonResponse(snapshot.policy);
          return await this.replace(update.expectedRevision, update.rules);
        } catch (error) {
          return errorResponse(
            error instanceof HttpError ? error : stringRewritePolicyUnavailable(),
          );
        }
      });
    } catch (error) {
      return errorResponse(error instanceof HttpError ? error : stringRewritePolicyUnavailable());
    }
  }

  private freshSnapshot(): Snapshot | undefined {
    const snapshot = this.snapshot;
    if (snapshot === undefined) return undefined;
    const age = Date.now() - snapshot.loadedAt;
    return age >= 0 && age < POLICY_SNAPSHOT_MAX_AGE_MS ? snapshot : undefined;
  }

  private async readPrimary(): Promise<Snapshot> {
    // Start the age before I/O so a delayed response cannot extend freshness.
    const loadedAt = Date.now();
    try {
      // Missing migration/row is not an empty policy; replicas cannot bootstrap authority.
      const row: unknown = await this.env.DB.withSession("first-primary")
        .prepare(queries.getStringRewritePolicy)
        .first();
      return compileSnapshot(row, loadedAt);
    } catch {
      throw stringRewritePolicyUnavailable();
    }
  }

  private async replace(expectedRevision: number, rules: StringRewriteRule[]): Promise<Response> {
    if (this.snapshot!.policy.revision !== expectedRevision) throw conflict();
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
    const rulesJSON = JSON.stringify(rules);
    // A write can commit without an acknowledgement, or installation can fail.
    // Discard the old snapshot before either is possible; the next read reconciles at primary.
    this.snapshot = undefined;
    const loadedAt = Date.now();
    try {
      const result = await this.env.DB.withSession("first-primary")
        .prepare(queries.replaceStringRewritePolicy)
        .bind(updatedAt, rulesJSON, expectedRevision)
        .first<{ revision: number; updated_at: string }>();
      if (result === null) throw conflict();
      if (result.revision !== expectedRevision + 1 || result.updated_at !== updatedAt)
        throw stringRewritePolicyUnavailable();
      const snapshot = compileSnapshot(
        { schema_version: 1, ...result, rules_json: rulesJSON },
        loadedAt,
      );
      const response = jsonResponse({
        schema_version: 1,
        revision: snapshot.policy.revision,
        updated_at: snapshot.policy.updated_at,
        rule_count: rules.length,
      });
      this.snapshot = snapshot;
      return response;
    } catch (error) {
      throw error instanceof HttpError && error.code === "string_rewrite_revision_conflict"
        ? error
        : stringRewritePolicyUnavailable();
    }
  }
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function compileSnapshot(row: unknown, loadedAt: number): Snapshot {
  if (
    !isRecord(row) ||
    row.schema_version !== 1 ||
    !revision(row.revision) ||
    typeof row.updated_at !== "string" ||
    typeof row.rules_json !== "string" ||
    new Date(row.updated_at).toISOString() !== row.updated_at
  )
    throw stringRewritePolicyUnavailable();
  utf8Size(row.rules_json, STRING_REWRITE_LIMITS.policyBytes, stringRewritePolicyUnavailable);
  const compiled = compileStringRewriteRules(parseStringRewriteJSON(row.rules_json));
  const policy: StringRewritePolicy = {
    schema_version: 1,
    revision: row.revision,
    updated_at: row.updated_at,
    rules: compiled.map(({ pattern, replacement }) => ({ pattern, replacement })),
  };
  utf8Size(
    JSON.stringify(policy),
    STRING_REWRITE_LIMITS.policyBytes,
    stringRewritePolicyUnavailable,
  );
  return { policy, compiled, loadedAt };
}

async function parseUpdate(
  request: Request,
): Promise<{ expectedRevision: number; rules: StringRewriteRule[] }> {
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
    return {
      expectedRevision: value.expected_revision,
      rules: compileStringRewriteRules(value.rules).map(({ pattern, replacement }) => ({
        pattern,
        replacement,
      })),
    };
  } catch {
    throw invalidStringRewritePolicy();
  }
}

function conflict(): HttpError {
  return new HttpError(
    409,
    "string_rewrite_revision_conflict",
    "String protection policy revision conflict",
  );
}
