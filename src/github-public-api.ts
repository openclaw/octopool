import { responseCapBytes } from "./github-limits";
import { appendRelayQuery } from "./github-path";
import { publicJSONResponse, parseJSONBytes, scalarQuery } from "./github-public-utils";
import { defaultGitHubJSONAccept } from "./github-response";
import type { WebRequest } from "./github-web-types";
import { queries } from "./generated/sql";
import { capabilitiesForRouteKind } from "./route-manifest";
import type { RelayRequest, RouteInfo } from "./types";

export function releaseAPIRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (!releaseRoute(route) || !defaultGitHubJSONAccept(request.headers?.accept)) {
    return undefined;
  }
  const url = new URL(`https://api.github.com${request.path}`);
  appendRelayQuery(url, request.query);
  if (scalarQuery(request.query, "ref") !== undefined) {
    return undefined;
  }
  return {
    url: url.toString(),
    headers: publicAPIHeaders(request),
    capBytes: responseCapBytes(env),
    usesApiQuota: true,
    payload: (body, headers, status) => {
      const parsed = parsePublicReleaseBody(body, route);
      return parsed === undefined ? undefined : publicJSONResponse(headers, status, parsed, "json");
    },
  };
}

export function publicAPIRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    releaseRoute(route) ||
    !capabilitiesForRouteKind(route.kind).publicApi ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const url = new URL(`https://api.github.com${request.path}`);
  appendRelayQuery(url, request.query);
  return {
    url: url.toString(),
    headers: publicAPIHeaders(request),
    capBytes: responseCapBytes(env),
    usesApiQuota: true,
    payload: (body, headers, status) => {
      if (body.byteLength === 0) {
        return publicJSONResponse(headers, status, null, "text");
      }
      const parsed = parseJSONBytes(body);
      if (parsed === undefined || (route.kind === "gist_view" && !publicGist(parsed))) {
        return undefined;
      }
      return publicJSONResponse(headers, status, parsed, "json");
    },
  };
}

export function supportsAnonymousGitHubAPI(request: RelayRequest, route: RouteInfo): boolean {
  return (
    (releaseRoute(route) && defaultGitHubJSONAccept(request.headers?.accept)) ||
    (request.method === "GET" &&
      capabilitiesForRouteKind(route.kind).publicApi &&
      defaultGitHubJSONAccept(request.headers?.accept))
  );
}

export async function storePublicAPIRate(
  env: Env,
  resource: string,
  headers: Headers,
): Promise<void> {
  const limit = headerInt(headers, "x-ratelimit-limit");
  const remaining = headerInt(headers, "x-ratelimit-remaining");
  const resetAt = headerInt(headers, "x-ratelimit-reset");
  if (limit === undefined || remaining === undefined || resetAt === undefined || limit <= 0) {
    return;
  }
  try {
    await env.DB.prepare(queries.upsertPublicApiRate)
      .bind(resource, limit, remaining, resetAt)
      .run();
  } catch {
    // Rate persistence is advisory; public reads still work without it.
  }
}

function publicAPIHeaders(request: RelayRequest): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "octopool",
    "x-github-api-version": request.headers?.["x-github-api-version"] ?? "2022-11-28",
  };
}

function releaseRoute(route: RouteInfo): boolean {
  return (
    route.kind === "release_list" ||
    route.kind === "release_latest" ||
    route.kind === "release_view"
  );
}

function publicGist(value: unknown): boolean {
  return typeof value === "object" && value !== null && "public" in value && value.public === true;
}

function parsePublicReleaseBody(body: Uint8Array, route: RouteInfo): unknown | undefined {
  const parsed = parseJSONBytes(body);
  if (parsed === undefined) {
    return undefined;
  }
  if (route.kind === "release_list") {
    return Array.isArray(parsed) ? parsed.filter((item) => !releaseDraft(item)) : undefined;
  }
  return releaseDraft(parsed) ? undefined : parsed;
}

function releaseDraft(value: unknown): boolean {
  return typeof value === "object" && value !== null && "draft" in value && value.draft === true;
}

function headerInt(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
