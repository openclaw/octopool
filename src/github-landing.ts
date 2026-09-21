import { GITHUB_LANDING_QUERIES, PUBLIC_SHAPES } from "./github-public-shapes";
import { defaultGitHubJSONAccept } from "./github-response";
import { HttpError } from "./http";
import { isRecord } from "./object";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

export function landingGraphQLRequest(
  request: RelayRequest,
): { query: string; variables: Record<string, string | number> } | undefined {
  const shape = request.headers?.["x-octopool-public-shape"];
  const key = (Object.keys(GITHUB_LANDING_QUERIES) as (keyof typeof GITHUB_LANDING_QUERIES)[]).find(
    (candidate) => PUBLIC_SHAPES[candidate] === shape,
  );
  if (key === undefined) return undefined;
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/([1-9][0-9]*)$/.exec(
    request.path,
  );
  const number = Number(match?.[3]);
  const cursor = request.query?.cursor;
  if (
    request.method !== "GET" ||
    match === null ||
    !Number.isSafeInteger(number) ||
    number > 2_147_483_647 ||
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    request.headers?.["if-none-match"] !== undefined ||
    request.headers?.["if-modified-since"] !== undefined ||
    Object.keys(request.query ?? {}).some((name) => name !== "cursor") ||
    (cursor !== undefined &&
      (key !== "pullRequestCIRollup" ||
        typeof cursor !== "string" ||
        cursor.length === 0 ||
        cursor.length > 512 ||
        [...cursor].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )))
  ) {
    throw new HttpError(403, "route_denied", "Invalid public landing query shape");
  }
  return {
    query: GITHUB_LANDING_QUERIES[key],
    variables: {
      owner: match[1]!,
      name: match[2]!,
      [key === "pullRequestMergeSnapshot" ? "number" : "pr"]: number,
      ...(typeof cursor === "string" ? { cursor } : {}),
    },
  };
}

export function isLandingGraphQLRoute(route: RouteInfo): boolean {
  return route.kind === "pr_view" && route.resource === "graphql";
}

export function landingGraphQLCacheable(response: GitHubRelayResponse): boolean {
  const body = response.body;
  return (
    response.status === 200 &&
    isRecord(body) &&
    !Object.hasOwn(body, "errors") &&
    isRecord(body.data) &&
    isRecord(body.data.repository) &&
    isRecord(body.data.repository.pullRequest)
  );
}
