import { base64ToBytes } from "./encoding";
import { CACHE_PUBLICATION_EPOCH } from "./cache-publication";
import { queries } from "./generated/sql";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { callGitHubWeb } from "./github-web";
import { completedJobPageProof } from "./github-public-actions";
import { sanitizeGitHubResponse } from "./github-sanitize";
import { isRecord } from "./object";
import { classifyRoute } from "./policy";
import { observeAnonymousPublicRepo } from "./public-repos";
import { parseSQLiteTimestamp, sqliteTimestamp } from "./sqlite-time";
import type { GitHubRelayResponse, PoolPolicy, RelayRequest, RouteInfo } from "./types";

const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOG_REVALIDATE_SECONDS = 60 * 60;
const LOG_KEY_PREFIX = "github-actions-logs/v1/";
const CREATED_AT_METADATA = "created-at";
const BODY_ENCODING_METADATA = "body-encoding";
const BODY_CODEC_METADATA = "body-codec";
const BODY_CODEC = "lossless-v1";

export type CachedTerminalLog = GitHubRelayResponse & {
  created_at: string;
  expires_at: string;
};

export type TerminalLogCacheProof = { key: string };
type TerminalLogProofOutcome =
  | "r2_cached"
  | "cached_job_view"
  | "web_page"
  | "anonymous_api"
  | "unproven"
  | "error";

export function terminalLogCacheKey(request: RelayRequest): string {
  return `${LOG_KEY_PREFIX}${encodeURIComponent(request.pool)}${request.path}`;
}

export function terminalLogJobID(request: RelayRequest, route: RouteInfo): string | undefined {
  if (!route.logs || route.owner === undefined || route.repo === undefined) return undefined;
  const match = /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/([0-9]+)\/logs$/.exec(request.path);
  return match?.[1] === route.owner && match[2] === route.repo ? match[3] : undefined;
}

export function recordTerminalLogProof(
  request: RelayRequest,
  outcome: TerminalLogProofOutcome,
): void {
  console.log({
    event: "octopool.actions_log.completion_proof",
    pool: request.pool,
    path: request.path,
    outcome,
  });
}

export async function terminalLogCacheProof(
  env: GitHubEgressEnv,
  ctx: ExecutionContext,
  request: RelayRequest,
  route: RouteInfo,
  policy: PoolPolicy,
): Promise<TerminalLogCacheProof | undefined> {
  const jobID = terminalLogJobID(request, route);
  if (jobID === undefined) {
    return undefined;
  }
  let outcome: TerminalLogProofOutcome = "unproven";
  try {
    const metadata = metadataRequest(
      request,
      `/repos/${route.owner}/${route.repo}/actions/jobs/${jobID}`,
    );
    if (await cachedJobProvesCompleted(env, metadata, jobID)) {
      outcome = "cached_job_view";
      return { key: terminalLogCacheKey(request) };
    }
    if (await completedJobPageProof(env, route.owner!, route.repo!, jobID)) {
      outcome = "web_page";
      return { key: terminalLogCacheKey(request) };
    }
    const job = await fetchFreshMetadata(env, metadata, policy, ctx);
    if (!metadataProvesCompleted(job, jobID)) return undefined;
    outcome = "anonymous_api";
    return { key: terminalLogCacheKey(request) };
  } catch (error) {
    outcome = "error";
    rethrowStringRewriteDenial(error);
    console.error("actions log completion preflight failed", error);
    return undefined;
  } finally {
    recordTerminalLogProof(request, outcome);
  }
}

async function cachedJobProvesCompleted(
  env: Env,
  request: RelayRequest,
  jobID: string,
): Promise<boolean> {
  try {
    // Completion is permanent for a job ID. Expiry bounds response reuse, not this fact.
    // Search exact-path variants (including pooled identities) through the job-proof index.
    const proof = await env.DB.prepare(queries.readCompletedJobCacheProof)
      .bind(request.pool, request.path, CACHE_PUBLICATION_EPOCH, jobID)
      .first<{ completed: number }>();
    return proof?.completed === 1;
  } catch (error) {
    console.error("actions log cached completion proof failed", error);
    return false;
  }
}

export function terminalLogNeedsRevalidation(
  cached: CachedTerminalLog,
  maxAgeSeconds?: number,
): boolean {
  const createdAt = parseSQLiteTimestamp(cached.created_at);
  const ageMs = Date.now() - createdAt;
  return (
    !Number.isFinite(createdAt) ||
    ageMs >= LOG_REVALIDATE_SECONDS * 1000 ||
    maxAgeSeconds === 0 ||
    (maxAgeSeconds !== undefined && ageMs > maxAgeSeconds * 1000)
  );
}

export async function deleteTerminalLogCache(env: Env, key: string): Promise<void> {
  try {
    await env.ACTIONS_LOGS.delete(key);
  } catch (error) {
    console.error("actions log cache deletion failed", error);
  }
}

export async function readTerminalLogCache(
  env: Env,
  key: string,
): Promise<CachedTerminalLog | undefined> {
  try {
    const object = await env.ACTIONS_LOGS.get(key);
    if (object === null) {
      return undefined;
    }
    const createdAt = object.customMetadata?.[CREATED_AT_METADATA];
    const createdAtMs = createdAt === undefined ? Number.NaN : parseSQLiteTimestamp(createdAt);
    if (
      createdAt === undefined ||
      !Number.isFinite(createdAtMs) ||
      Date.now() - createdAtMs >= LOG_TTL_SECONDS * 1000
    ) {
      await object.body.cancel();
      try {
        await env.ACTIONS_LOGS.delete(key);
      } catch (error) {
        console.error("expired actions log deletion failed", error);
      }
      return undefined;
    }
    if (object.customMetadata?.[BODY_CODEC_METADATA] !== BODY_CODEC) {
      // Reject legacy bytes before serving or existence-only renewal; replace only after download.
      await object.body.cancel();
      return undefined;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
    const encoding = terminalLogEncoding(object.customMetadata?.[BODY_ENCODING_METADATA]);
    return {
      status: 200,
      headers: { "content-type": contentType },
      body: decodeLogBytes(bytes, encoding),
      body_encoding: encoding,
      created_at: createdAt,
      expires_at: sqliteTimestamp(new Date(createdAtMs + LOG_TTL_SECONDS * 1000)),
    };
  } catch (error) {
    console.error("actions log cache read failed", error);
    return undefined;
  }
}

export async function writeTerminalLogCache(
  env: Env,
  key: string,
  response: GitHubRelayResponse,
): Promise<void> {
  if (response.status !== 200) {
    return;
  }
  const encoding = response.body_encoding ?? "json";
  const createdAt = sqliteTimestamp(new Date());
  await env.ACTIONS_LOGS.put(key, encodeLogBody(response.body, encoding), {
    httpMetadata: {
      contentType: response.headers["content-type"] ?? "application/octet-stream",
    },
    customMetadata: {
      [CREATED_AT_METADATA]: createdAt,
      [BODY_ENCODING_METADATA]: encoding,
      [BODY_CODEC_METADATA]: BODY_CODEC,
    },
  });
}

async function fetchFreshMetadata(
  env: GitHubEgressEnv,
  request: RelayRequest,
  policy: PoolPolicy,
  ctx: ExecutionContext,
): Promise<GitHubRelayResponse | undefined> {
  const route = classifyRoute(request, policy);
  const observation = await observeAnonymousPublicRepo(env, route, async () => {
    const fetched = await callGitHubWeb(env, request, route, { ctx });
    return fetched === undefined ? undefined : sanitizeGitHubResponse(route, fetched);
  });
  return observation.response;
}

function metadataProvesCompleted(
  response: GitHubRelayResponse | undefined,
  jobID: string,
): boolean {
  return (
    response !== undefined &&
    response.status >= 200 &&
    response.status < 300 &&
    isRecord(response.body) &&
    Number.isSafeInteger(response.body.id) &&
    String(response.body.id) === jobID &&
    response.body.status === "completed"
  );
}

function metadataRequest(request: RelayRequest, path: string): RelayRequest {
  return {
    pool: request.pool,
    method: "GET",
    path,
    headers: {
      accept: "application/vnd.github+json",
      ...(request.headers?.["x-github-api-version"] === undefined
        ? {}
        : { "x-github-api-version": request.headers["x-github-api-version"] }),
    },
  };
}

function terminalLogEncoding(value: string | undefined): "json" | "text" | "base64" {
  return value === "json" || value === "text" || value === "base64" ? value : "base64";
}

function encodeLogBody(body: unknown, encoding: "json" | "text" | "base64"): Uint8Array {
  if (encoding === "base64" && typeof body === "string") {
    return base64ToBytes(body);
  }
  const text = encoding === "json" ? JSON.stringify(body) : String(body ?? "");
  return new TextEncoder().encode(text);
}

function decodeLogBytes(bytes: Uint8Array, encoding: "json" | "text" | "base64"): unknown {
  if (encoding === "base64") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  const text = new TextDecoder().decode(bytes);
  if (encoding !== "json") {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
