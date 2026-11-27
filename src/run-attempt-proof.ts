import {
  type CachedGitHubResponse,
  githubCacheKey,
  readGitHubCache,
  createGitHubCacheCandidateReader,
} from "./cache";
import { loadIdentities } from "./db";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { hasConditionalRequestHeaders } from "./github-response";
import { callGitHubWeb } from "./github-web";
import { isRecord } from "./object";
import { classifyRoute } from "./policy";
import type { GitHubRelayResponse, Identity, PoolPolicy, RelayRequest, RouteInfo } from "./types";

type RunAttemptProofContext = Readonly<{
  env: GitHubEgressEnv;
  ctx: ExecutionContext;
  request: RelayRequest;
  route: RouteInfo;
  policy: PoolPolicy;
  maxAgeSeconds: number | undefined;
  anonymousRateLimited: boolean;
}>;

type CachedResponseAvailable = (
  env: GitHubEgressEnv,
  pool: string,
  route: RouteInfo,
  cached: CachedGitHubResponse,
  selectedIdentity?: Pick<Identity, "id" | "kind">,
) => Promise<boolean>;

export async function proveRunAttemptCompleted(
  state: RunAttemptProofContext,
  cachedResponseAvailable: CachedResponseAvailable,
): Promise<RouteInfo> {
  if (state.route.kind !== "run_jobs" || state.route.run_attempt === undefined) {
    return state.route;
  }
  const path = state.request.path.replace(/\/jobs$/, "");
  const request: RelayRequest = {
    pool: state.request.pool,
    method: "GET",
    path,
    headers: {
      "x-octopool-public-shape": PUBLIC_SHAPES.actionsSummary,
      ...(state.request.headers?.["x-github-api-version"] === undefined
        ? {}
        : { "x-github-api-version": state.request.headers["x-github-api-version"] }),
    },
  };
  const route: RouteInfo = {
    ...state.route,
    kind: "run_view",
    routeKey: state.route.routeKey.replace(/\/jobs$/, ""),
  };
  if (await cachedRunAttemptCompleted(state, request, cachedResponseAvailable)) {
    return { ...state.route, run_attempt_completed: true };
  }
  try {
    const response = await callGitHubWeb(state.env, request, route, {
      skipAnonymousAPI: state.anonymousRateLimited,
      ctx: state.ctx,
    });
    if (runAttemptCompleted(response, state.route.run_attempt, path)) {
      return { ...state.route, run_attempt_completed: true };
    }
  } catch (error) {
    rethrowStringRewriteDenial(error);
    // The proof only enables a longer TTL; failure keeps the conservative default.
  }
  return state.route;
}

async function cachedRunAttemptCompleted(
  state: RunAttemptProofContext,
  attemptRequest: RelayRequest,
  cachedResponseAvailable: CachedResponseAvailable,
): Promise<boolean> {
  if (state.maxAgeSeconds === 0 || hasConditionalRequestHeaders(state.request.headers))
    return false;
  try {
    const headers = { ...attemptRequest.headers };
    if (state.request.headers?.["x-octopool-public-shape"] !== PUBLIC_SHAPES.actionsJobs) {
      delete headers["x-octopool-public-shape"];
    }
    const views = [attemptRequest.path.replace(/\/attempts\/\d+$/, ""), attemptRequest.path].map(
      (path) => {
        const request = { ...attemptRequest, path, headers };
        return { request, route: classifyRoute(request, state.policy) };
      },
    );
    const probe = async (
      read: (key: string) => Promise<CachedGitHubResponse | undefined>,
      identity?: Identity,
    ) => {
      // Both run-view forms can prove completion, but only for the jobs' exact attempt.
      for (const { request, route } of views) {
        const key = await githubCacheKey(request.pool, request, route, identity);
        const cached = await read(key);
        if (
          cached !== undefined &&
          runAttemptCompleted(cached, state.route.run_attempt, attemptRequest.path) &&
          (await cachedResponseAvailable(state.env, request.pool, route, cached, identity))
        ) {
          return true;
        }
      }
      return false;
    };
    if (await probe((key) => readGitHubCache(state.env, key, state.ctx, state.maxAgeSeconds)))
      return true;
    const identities = await loadIdentities(state.env, state.request.pool, state.route);
    const keys = await Promise.all(
      identities.flatMap((identity) =>
        views.map(({ request, route }) => githubCacheKey(request.pool, request, route, identity)),
      ),
    );
    const read = createGitHubCacheCandidateReader(state.env, keys, state.ctx, state.maxAgeSeconds);
    for (const identity of identities) {
      if (await probe(read, identity)) return true;
    }
  } catch (error) {
    rethrowStringRewriteDenial(error);
    // Cache/proof lookup failure still permits the existing live metadata check.
  }
  return false;
}

function runAttemptCompleted(
  response: GitHubRelayResponse | undefined,
  attempt: number | undefined,
  path: string,
): boolean {
  return (
    response !== undefined &&
    response.status >= 200 &&
    response.status < 300 &&
    isRecord(response.body) &&
    response.body.status === "completed" &&
    response.body.run_attempt === attempt &&
    String(response.body.id) === /\/runs\/([0-9]+)\//.exec(path)?.[1]
  );
}
