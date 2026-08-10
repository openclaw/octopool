import { responseCapBytes } from "./github-limits";
import { githubResponseHeaders } from "./github-response";
import type { WebRequest } from "./github-web-types";
import type { GitHubRelayResponse } from "./types";

export function scalarQuery(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function validScalarQuery(
  query: Record<string, string | string[]> | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  return !Object.entries(query ?? {}).some(
    ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
  );
}

export function firstPageQuery(query: Record<string, string | string[]> | undefined): boolean {
  const page = scalarQuery(query, "page");
  return page === undefined || page === "1";
}

export function boundedPageSize(
  value: string | string[] | undefined,
  options: { defaultValue?: number; max?: number; strict?: boolean } = {},
): number | undefined {
  if (value === undefined) {
    return options.defaultValue;
  }
  if (Array.isArray(value) || (options.strict === true && !/^[1-9][0-9]*$/.test(value))) {
    return undefined;
  }
  const parsed = Number(value);
  const max = options.max ?? 100;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : undefined;
}

export function decodePathStrict(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function parseJSONBytes(body: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

export function publicResponseHeaders(
  headers: Headers,
  contentType: string,
): Record<string, string> {
  return githubResponseHeaders(headers, { contentType, includeCacheControl: true });
}

export function publicJSONResponse(
  headers: Headers,
  status: number,
  body: unknown,
  bodyEncoding: "json" | "text" = "json",
): GitHubRelayResponse {
  return {
    status,
    headers: publicResponseHeaders(headers, "application/json"),
    body,
    body_encoding: bodyEncoding,
    backend: "web",
  };
}

export function htmlWebRequest(env: Env, url: string, payload: WebRequest["payload"]): WebRequest {
  return {
    url,
    headers: { accept: "text/html", "user-agent": "octopool" },
    capBytes: responseCapBytes(env),
    usesApiQuota: false,
    payload,
  };
}
