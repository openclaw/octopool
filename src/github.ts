import { bytesToBase64 } from "./encoding";
import { githubToken } from "./github-auth";
import { requestTimeoutMs, responseCapBytes } from "./github-limits";
import { appendRelayQuery } from "./github-path";
import { githubResponseHeaders } from "./github-response";
import { HttpError } from "./http";
import { readBodyCapped } from "./response-body";
import type { GitHubRelayResponse, Identity, RelayRequest, RouteInfo } from "./types";

export type GitHubLogProbe =
  | { kind: "exists"; status: number; headers: Record<string, string> }
  | { kind: "deleted"; response: GitHubRelayResponse }
  | { kind: "unknown"; status: number; headers: Record<string, string> };

export async function callGitHub(
  env: Env,
  identity: Identity,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse> {
  const token = await githubToken(env, identity);
  return callGitHubAPI(env, request, route, token);
}

export async function callPublicGitHub(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse> {
  return callGitHubAPI(env, request, route);
}

export async function probeGitHubLog(
  env: Env,
  identity: Identity,
  request: RelayRequest,
): Promise<GitHubLogProbe> {
  const token = await githubToken(env, identity);
  const response = await fetch(githubUrl(request), {
    method: "GET",
    headers: githubHeaders(token, request.headers),
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs(env)),
  });
  const headers = githubResponseHeaders(response.headers);
  if (response.status === 302) {
    githubLogRedirectURL(response);
    return { kind: "exists", status: response.status, headers };
  }
  if (response.status !== 404) {
    return { kind: "unknown", status: response.status, headers };
  }
  const bodyBytes = await readGitHubBody(response, responseCapBytes(env));
  const contentType = response.headers.get("content-type") ?? "";
  const { body, encoding } = decodeBody(bodyBytes, contentType);
  return {
    kind: "deleted",
    response: {
      status: response.status,
      headers,
      body,
      body_encoding: encoding,
    },
  };
}

async function callGitHubAPI(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
  token?: string,
): Promise<GitHubRelayResponse> {
  const url = githubUrl(request);
  const timeoutMs = requestTimeoutMs(env);
  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(token, request.headers),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    if (route.logs) {
      return fetchGitHubLogRedirect(response, responseCapBytes(env), timeoutMs);
    }
    throw new HttpError(502, "github_redirect_denied", "GitHub returned a redirect");
  }
  const bodyBytes = await readGitHubBody(response, responseCapBytes(env));
  const contentType = response.headers.get("content-type") ?? "";
  const { body, encoding } = decodeBody(bodyBytes, contentType);
  return {
    status: response.status,
    headers: githubResponseHeaders(response.headers),
    body,
    body_encoding: encoding,
  };
}

async function fetchGitHubLogRedirect(
  response: Response,
  cap: number,
  timeoutMs: number,
): Promise<GitHubRelayResponse> {
  const url = githubLogRedirectURL(response);
  const redirected = await fetch(url.toString(), {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (redirected.status >= 300 && redirected.status < 400) {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect chained");
  }
  const bodyBytes = await readGitHubBody(redirected, cap);
  const contentType = redirected.headers.get("content-type") ?? "text/plain";
  const { body, encoding } = decodeBody(bodyBytes, contentType);
  return {
    status: redirected.status,
    headers: logRedirectHeaders(response.headers, redirected.headers),
    body,
    body_encoding: encoding,
  };
}

function githubLogRedirectURL(response: Response): URL {
  const location = response.headers.get("location");
  if (location === null) {
    throw new HttpError(502, "github_log_redirect_missing", "GitHub log redirect is missing");
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect is invalid");
  }
  if (url.protocol !== "https:") {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect is not HTTPS");
  }
  if (!isAllowedLogRedirectHost(url.hostname)) {
    throw new HttpError(502, "github_log_redirect_denied", "GitHub log redirect host is denied");
  }
  return url;
}

function isAllowedLogRedirectHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower.endsWith(".actions.githubusercontent.com") || lower.endsWith(".blob.core.windows.net")
  );
}

function logRedirectHeaders(original: Headers, redirected: Headers): Record<string, string> {
  const headers = githubResponseHeaders(redirected);
  const originalHeaders = githubResponseHeaders(original);
  for (const key of [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-ratelimit-used",
    "x-github-request-id",
  ]) {
    const value = originalHeaders[key];
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

function githubUrl(request: RelayRequest): string {
  const url = new URL(`https://api.github.com${request.path}`);
  appendRelayQuery(url, request.query);
  return url.toString();
}

function githubHeaders(
  token: string | undefined,
  input: Record<string, string> | undefined,
): Headers {
  const headers = new Headers();
  headers.set("accept", input?.accept ?? "application/vnd.github+json");
  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("user-agent", "octopool");
  headers.set("x-github-api-version", input?.["x-github-api-version"] ?? "2022-11-28");
  if (input?.["if-none-match"] !== undefined) {
    headers.set("if-none-match", input["if-none-match"]);
  }
  if (input?.["if-modified-since"] !== undefined) {
    headers.set("if-modified-since", input["if-modified-since"]);
  }
  return headers;
}

function readGitHubBody(response: Response, capBytes: number): Promise<Uint8Array> {
  return readBodyCapped(
    response,
    capBytes,
    () => new HttpError(502, "github_response_too_large", "GitHub response exceeded relay cap"),
  );
}

function decodeBody(
  bytes: Uint8Array,
  contentType: string,
): { body: unknown; encoding: "json" | "text" | "base64" } {
  if (bytes.length === 0) {
    return { body: null, encoding: "text" };
  }
  const text = new TextDecoder().decode(bytes);
  if (contentType.includes("application/json")) {
    try {
      return { body: JSON.parse(text) as unknown, encoding: "json" };
    } catch {
      return { body: text, encoding: "text" };
    }
  }
  if (isMostlyText(bytes)) {
    return { body: text, encoding: "text" };
  }
  return { body: bytesToBase64(bytes), encoding: "base64" };
}

function isMostlyText(bytes: Uint8Array): boolean {
  for (const byte of bytes.slice(0, 1024)) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}
