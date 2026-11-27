import { isLandingGraphQLRoute } from "./github-public-shapes";
import { appendRelayQuery, scalarQuery } from "./github-path";
import { publicJSONResponse, parseJSONBytes } from "./github-public-utils";
import { DEFAULT_GITHUB_API_VERSION, defaultGitHubJSONAccept } from "./github-response";
import type { WebRequest } from "./github-web-types";
import { capabilitiesForRouteKind } from "./route-manifest";
import type { RelayRequest, RouteInfo } from "./types";

export function publicAPIRequest(
  capBytes: number,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  const release = releaseRoute(route);
  if (
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    !supportsAnonymousGitHubAPI(request, route) ||
    (release && scalarQuery(request.query, "ref") !== undefined)
  ) {
    return undefined;
  }
  const url = new URL(`https://api.github.com${request.path}`);
  appendRelayQuery(url, request.query);
  return {
    url: url.toString(),
    headers: publicAPIHeaders(request),
    capBytes,
    usesApiQuota: true,
    payload: (body, headers, status) => {
      if (release) {
        const parsed = parsePublicReleaseBody(body, route);
        return parsed === undefined ? undefined : publicJSONResponse(headers, status, parsed);
      }
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
  if (isLandingGraphQLRoute(route)) return false;
  return (
    (releaseRoute(route) && defaultGitHubJSONAccept(request.headers?.accept)) ||
    (request.method === "GET" &&
      capabilitiesForRouteKind(route.kind).publicApi &&
      defaultGitHubJSONAccept(request.headers?.accept))
  );
}

function publicAPIHeaders(request: RelayRequest): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "octopool",
    "x-github-api-version": request.headers?.["x-github-api-version"] ?? DEFAULT_GITHUB_API_VERSION,
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
