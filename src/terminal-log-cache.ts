import { githubCacheKey, readGitHubCache, writeGitHubCache } from "./cache";
import { base64ToBytes } from "./encoding";
import { callGitHubWeb } from "./github-web";
import { sanitizeGitHubResponse } from "./github-sanitize";
import { isRecord } from "./object";
import { classifyRoute } from "./policy";
import { recordPublicGitHubRepo } from "./public-repos";
import { parseSQLiteTimestamp, sqliteTimestamp } from "./sqlite-time";
import type { GitHubRelayResponse, PoolPolicy, RelayRequest, RouteInfo } from "./types";

const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOG_KEY_PREFIX = "github-actions-logs/v1/";
const CREATED_AT_METADATA = "created-at";
const BODY_ENCODING_METADATA = "body-encoding";

export type CachedTerminalLog = GitHubRelayResponse & {
  created_at: string;
  expires_at: string;
};

export type LogPrunePage = {
  deleted: number;
  truncated: boolean;
  cursor?: string;
};

export function terminalLogCacheKey(request: RelayRequest): string {
  return `${LOG_KEY_PREFIX}${encodeURIComponent(request.pool)}${request.path}`;
}

export async function terminalLogRunCompleted(
  env: Env,
  ctx: ExecutionContext,
  request: RelayRequest,
  route: RouteInfo,
  policy: PoolPolicy,
): Promise<boolean> {
  if (route.kind !== "job_logs" || route.owner === undefined || route.repo === undefined) {
    return false;
  }
  const jobID = /\/actions\/jobs\/([0-9]+)\/logs$/.exec(request.path)?.[1];
  if (jobID === undefined) {
    return false;
  }
  const job = await readOrFetchMetadata(
    env,
    ctx,
    metadataRequest(request, `/repos/${route.owner}/${route.repo}/actions/jobs/${jobID}`),
    policy,
  );
  if (
    !isRecord(job?.body) ||
    typeof job.body.run_id !== "number" ||
    !Number.isSafeInteger(job.body.run_id) ||
    job.body.run_id < 1
  ) {
    return false;
  }
  const run = await readOrFetchMetadata(
    env,
    ctx,
    metadataRequest(
      request,
      `/repos/${route.owner}/${route.repo}/actions/runs/${String(job.body.run_id)}`,
    ),
    policy,
  );
  return isRecord(run?.body) && run.body.status === "completed";
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
      try {
        await env.ACTIONS_LOGS.delete(key);
      } catch (error) {
        console.error("expired actions log deletion failed", error);
      }
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
    },
  });
}

export async function pruneExpiredTerminalLogs(
  env: Env,
  limit = 500,
  cursor?: string,
): Promise<LogPrunePage> {
  const listed = await env.ACTIONS_LOGS.list({
    prefix: LOG_KEY_PREFIX,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    include: ["customMetadata"],
  });
  const expired = listed.objects
    .filter((object) => {
      const createdAt = object.customMetadata?.[CREATED_AT_METADATA];
      const createdAtMs = createdAt === undefined ? Number.NaN : parseSQLiteTimestamp(createdAt);
      return !Number.isFinite(createdAtMs) || Date.now() - createdAtMs >= LOG_TTL_SECONDS * 1000;
    })
    .map((object) => object.key);
  if (expired.length > 0) {
    await env.ACTIONS_LOGS.delete(expired);
  }
  return {
    deleted: expired.length,
    truncated: listed.truncated,
    ...(listed.truncated ? { cursor: listed.cursor } : {}),
  };
}

async function readOrFetchMetadata(
  env: Env,
  ctx: ExecutionContext,
  request: RelayRequest,
  policy: PoolPolicy,
): Promise<GitHubRelayResponse | undefined> {
  const route = classifyRoute(request, policy);
  const key = await githubCacheKey(request.pool, request, route);
  try {
    const cached = await readGitHubCache(env, key, ctx);
    if (cached !== undefined) {
      return cached;
    }
  } catch (error) {
    console.error("actions log metadata cache read failed", error);
  }
  const fetched = await callGitHubWeb(env, request, route);
  if (fetched === undefined) {
    return undefined;
  }
  const response = sanitizeGitHubResponse(route, fetched);
  await recordPublicGitHubRepo(env, route);
  try {
    await writeGitHubCache(env, key, request, route, response);
  } catch (error) {
    console.error("actions log metadata cache write failed", error);
  }
  return response;
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
