import { base64ToBytes } from "./encoding";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { callGitHubWeb } from "./github-web";
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

export function terminalLogCacheKey(request: RelayRequest): string {
  return `${LOG_KEY_PREFIX}${encodeURIComponent(request.pool)}${request.path}`;
}

export async function terminalLogCacheProof(
  env: GitHubEgressEnv,
  _ctx: ExecutionContext,
  request: RelayRequest,
  route: RouteInfo,
  policy: PoolPolicy,
): Promise<TerminalLogCacheProof | undefined> {
  try {
    if (!route.logs || route.owner === undefined || route.repo === undefined) {
      return undefined;
    }
    const jobID = /\/actions\/jobs\/([0-9]+)\/logs$/.exec(request.path)?.[1];
    if (jobID === undefined) {
      return undefined;
    }
    const job = await fetchFreshMetadata(
      env,
      metadataRequest(request, `/repos/${route.owner}/${route.repo}/actions/jobs/${jobID}`),
      policy,
    );
    return metadataProvesCompleted(job) ? { key: terminalLogCacheKey(request) } : undefined;
  } catch (error) {
    rethrowStringRewriteDenial(error);
    console.error("actions log completion preflight failed", error);
    return undefined;
  }
}

export function terminalLogNeedsRevalidation(cached: CachedTerminalLog): boolean {
  const createdAt = parseSQLiteTimestamp(cached.created_at);
  return !Number.isFinite(createdAt) || Date.now() - createdAt >= LOG_REVALIDATE_SECONDS * 1000;
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
): Promise<GitHubRelayResponse | undefined> {
  const route = classifyRoute(request, policy);
  const observation = await observeAnonymousPublicRepo(env, route, async () => {
    const fetched = await callGitHubWeb(env, request, route);
    return fetched === undefined ? undefined : sanitizeGitHubResponse(route, fetched);
  });
  return observation.response;
}

function metadataProvesCompleted(response: GitHubRelayResponse | undefined): boolean {
  return (
    response !== undefined &&
    response.status >= 200 &&
    response.status < 300 &&
    isRecord(response.body) &&
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
