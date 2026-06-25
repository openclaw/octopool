import { githubResponseHeaders } from "./github-response";
import type { GitHubRelayResponse } from "./types";

export function scalarQuery(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
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
