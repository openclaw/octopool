import { isStateAwarePRRoute } from "./cache-policy";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { queries } from "./generated/sql";
import { requestTimeoutMs, responseCapBytes } from "./github-limits";
import { HttpError } from "./http";
import { readBodyCapped } from "./response-body";
import type { RelayRequest, RouteInfo } from "./types";

type PullResponse = {
  state?: unknown;
  merged_at?: unknown;
  head?: {
    sha?: unknown;
  };
};

export async function verifyPRStateHint(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): Promise<RouteInfo> {
  return verifyPRStateHintInternal(env, request, route, true);
}

export async function verifyPRStateHintLive(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): Promise<RouteInfo> {
  return verifyPRStateHintInternal(env, request, withoutStateHint(route), false);
}

function withoutStateHint(route: RouteInfo): RouteInfo {
  const { state_hint: _stateHint, state_hint_source: _stateHintSource, ...rest } = route;
  return rest;
}

async function verifyPRStateHintInternal(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
  allowCachedProof: boolean,
): Promise<RouteInfo> {
  const stateHint = stateHintFromRequest(request);
  if (stateHint === undefined || !isStateAwarePRRoute(route.kind)) {
    return route;
  }
  const number = pullNumber(request.path);
  if (route.owner === undefined || route.repo === undefined || number === undefined) {
    return route;
  }
  try {
    if (allowCachedProof && (await freshPRStateProof(env, route, number, stateHint))) {
      return { ...route, state_hint: stateHint, state_hint_source: "cached" };
    }
    const response = await env.githubEgress.fetch(
      `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/pulls/${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "octopool",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(requestTimeoutMs(env)),
      },
    );
    if (!response.ok) {
      return route;
    }
    const bytes = await readBodyCapped(
      response,
      responseCapBytes(env),
      () => new HttpError(502, "github_response_too_large", "GitHub response exceeded relay cap"),
    );
    const body = JSON.parse(new TextDecoder().decode(bytes)) as PullResponse;
    if (hintMatchesPR(stateHint, body)) {
      await upsertPRStateProof(env, route, number, stateHint);
      return { ...route, state_hint: stateHint, state_hint_source: "live" };
    }
    return route;
  } catch (error) {
    rethrowStringRewriteDenial(error);
    return route;
  }
}

async function freshPRStateProof(
  env: Env,
  route: RouteInfo,
  number: string,
  stateHint: string,
): Promise<boolean> {
  const row = await env.DB.prepare(queries.freshPRStateProof)
    .bind(route.owner?.toLowerCase(), route.repo?.toLowerCase(), number, stateHint)
    .first<{ "1": number }>();
  return row !== null;
}

async function upsertPRStateProof(
  env: Env,
  route: RouteInfo,
  number: string,
  stateHint: string,
): Promise<void> {
  await env.DB.prepare(queries.upsertPRStateProof)
    .bind(route.owner?.toLowerCase(), route.repo?.toLowerCase(), number, stateHint, "+300 seconds")
    .run();
}

function hintMatchesPR(hint: string, body: PullResponse): boolean {
  if (hint.startsWith("pr-head:")) {
    return body.head?.sha === hint.slice("pr-head:".length);
  }
  if (hint === "pr-state:closed") {
    return body.state === "closed";
  }
  if (hint === "pr-state:merged") {
    return typeof body.merged_at === "string";
  }
  return false;
}

function pullNumber(path: string): string | undefined {
  return /^\/repos\/[^/]+\/[^/]+\/pulls\/([0-9]+)\//.exec(path)?.[1];
}

function stateHintFromRequest(request: RelayRequest): string | undefined {
  const hint = request.route_hint;
  if (hint?.pr_head_sha !== undefined) {
    return `pr-head:${hint.pr_head_sha}`;
  }
  if (hint?.pr_state === "closed" || hint?.pr_state === "merged") {
    return `pr-state:${hint.pr_state}`;
  }
  return undefined;
}
