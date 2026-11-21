import { githubResponseHeaders } from "./github-response";
import type { WebPayload, WebRequest } from "./github-web-types";

export function parseJSONBytes(body: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
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
): WebPayload {
  return {
    status,
    headers: publicResponseHeaders(headers, "application/json"),
    body,
    body_encoding: bodyEncoding,
  };
}

export function htmlWebRequest(
  capBytes: number,
  url: string,
  payload: WebRequest["payload"],
): WebRequest {
  return {
    url,
    headers: { accept: "text/html", "user-agent": "octopool" },
    capBytes,
    usesApiQuota: false,
    payload,
  };
}
