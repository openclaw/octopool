import { authenticateCaller } from "./auth";
import {
  type CachedGitHubResponse,
  githubCacheRevalidationHeaders,
  githubCacheKey,
  readGitHubCache,
  readStaleGitHubCache,
  requestCacheMaxAgeSeconds,
  shouldUseGitHubCache,
  writeGitHubCache,
} from "./cache";
import { coalesceGitHubCacheMiss } from "./cache-coalesce";
import type { CacheFillOutcome, OwnedCacheFill } from "./cache-fill";
import { insertAudit, loadIdentities, loadPoolPolicy } from "./db";
import { callGitHub, callPublicGitHub, probeGitHubLog } from "./github";
import { supportsAnonymousGitHubAPI } from "./github-public-api";
import { rateFromHeaders, type GitHubRate } from "./github-rate";
import { callAnonymousGitHubAPI, callGitHubWeb } from "./github-web";
import { sanitizeGitHubResponse } from "./github-sanitize";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { HttpError, jsonResponse, parseJsonObject } from "./http";
import { isRecord } from "./object";
import { githubResponseLocalFallbackReason, localFallbackError } from "./local-fallback";
import { classifyRoute, normalizeRouteKey, validateRelayRequest } from "./policy";
import { poolCoordinatorStub, type PoolCoordinator } from "./pool-coordinator";
import { verifyPRStateHint, verifyPRStateHintLive } from "./pr-state";
import {
  anonymousGitHubResponseProvesPublicRepo,
  ensurePublicGitHubRepo,
  recordPublicGitHubRepo,
} from "./public-repos";
import { capabilitiesForRouteKind } from "./route-manifest";
import {
  exactRunListRequest,
  filterRunListSuperset,
  runListShapeView,
  runListSupersetUnderfilled,
  runListSupersetView,
  type RunListView,
  type RunListSupersetView,
} from "./run-list-superset";
import {
  completeRunJobsSuperset,
  filterRunJobsSuperset,
  runJobsSupersetIncomplete,
  runJobsSupersetView,
  type RunJobsSupersetView,
} from "./run-jobs-superset";
import {
  deleteTerminalLogCache,
  readTerminalLogCache,
  terminalLogCacheProof,
  terminalLogNeedsRevalidation,
  type CachedTerminalLog,
  writeTerminalLogCache,
} from "./terminal-log-cache";
import type {
  AuditBackend,
  GitHubRelayResponse,
  Identity,
  RecordResult,
  RelayRequest,
  RouteInfo,
  PoolPolicy,
  SelectionLeaseReason,
  SelectionRequest,
} from "./types";

type RelayBase = {
  env: Env;
  ctx: ExecutionContext;
  requestId: string;
  started: number;
  request: RelayRequest;
  callerId: string;
  callerTokenId: string;
  clientName: string;
  coordinator: DurableObjectStub<PoolCoordinator>;
};

type ActiveRelay = RelayBase & {
  route: RouteInfo;
  policy: PoolPolicy;
  cacheRequest: RelayRequest;
  runListView: RunListView | undefined;
  runListSuperset: RunListSupersetView | undefined;
  runJobsSuperset: RunJobsSupersetView | undefined;
  runListExactFallback: boolean;
  terminalLogCacheKey: string | undefined;
  terminalLogCached: CachedTerminalLog | undefined;
  cacheEnabled: boolean;
  maxAgeSeconds: number | undefined;
  sharedCacheKey: string | undefined;
  cacheKey: string | undefined;
  attemptedIdentityCacheKeys: { cacheKey: string; identity: Pick<Identity, "id" | "kind"> }[];
  cacheFill: OwnedCacheFill | undefined;
  cacheStatus: "miss" | "bypass";
  cacheable: boolean;
  identity: Identity | undefined;
  paginatedIdentityRateRecorded: boolean;
};

type RelaySuccess = {
  github: GitHubRelayResponse;
  identity?: Identity;
  backend?: "web" | "github_public";
  leaseReason?: SelectionLeaseReason;
  rate?: GitHubRate;
  revalidated?: boolean;
  upstreamStatus?: number;
};

type RevalidationCandidate = {
  cached: CachedGitHubResponse;
  headers: Record<string, string>;
};

export async function relayGitHub(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  try {
    return await relayGitHubRequest(request, env, ctx, requestId);
  } catch (error) {
    // Backend overload can strike before handleRelayError owns the request
    // (auth/policy D1 reads) or inside its stale-cache reads; the shim must
    // still see typed fallback_local instead of a dead-end internal_error.
    throw localFallbackError(error) ?? error;
  }
}

async function relayGitHubRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const started = Date.now();
  const body = await parseJsonObject(request);
  const relayRequest = validateRelayRequest(body);
  const [caller, policy] = await Promise.all([
    authenticateCaller(request, env, relayRequest.pool),
    loadPoolPolicy(env, relayRequest.pool),
  ]);
  if (policy === null) {
    throw new HttpError(404, "pool_not_found", "Pool not found");
  }
  // `GET /user` is served as the caller's public profile so identity probes
  // (`gh api user -q .login`) stop bouncing as route_denied onto local tokens.
  if (relayRequest.path === "/user") {
    relayRequest.path = `/users/${encodeURIComponent(caller.github_login)}`;
  }
  const base: RelayBase = {
    env,
    ctx,
    requestId,
    started,
    request: relayRequest,
    callerId: caller.id,
    callerTokenId: caller.caller_token_id,
    clientName: caller.client_name,
    coordinator: poolCoordinatorStub(env, relayRequest.pool),
  };
  let active: ActiveRelay | undefined;
  try {
    active = await prepareRelay(base, policy);
    return await executeRelay(active);
  } catch (error) {
    return await handleRelayError(base, active, error);
  } finally {
    await active?.cacheFill?.fail();
  }
}

async function prepareRelay(
  base: RelayBase,
  policy: NonNullable<Awaited<ReturnType<typeof loadPoolPolicy>>>,
): Promise<ActiveRelay> {
  const route = await verifyPRStateHint(
    base.env,
    base.request,
    classifyRoute(base.request, policy),
  );
  const cacheEnabled = shouldUseGitHubCache(base.request, route);
  const runListSuperset = runListSupersetView(base.request, route);
  const runListView = runListSuperset ?? runListShapeView(base.request, route);
  const runJobsSuperset = cacheEnabled ? runJobsSupersetView(base.request, route) : undefined;
  const useRunListSuperset = cacheEnabled && runListSuperset !== undefined;
  const cacheRequest =
    runJobsSuperset?.cacheRequest ??
    (useRunListSuperset ? runListSuperset.cacheRequest : exactRunListRequest(base.request, route));
  const cacheKey = cacheEnabled
    ? await githubCacheKey(base.request.pool, cacheRequest, route)
    : undefined;
  return {
    ...base,
    route,
    policy,
    cacheRequest,
    runListView,
    runListSuperset,
    runJobsSuperset,
    runListExactFallback: runListView !== undefined && !useRunListSuperset,
    terminalLogCacheKey: undefined,
    terminalLogCached: undefined,
    cacheEnabled,
    maxAgeSeconds: cacheEnabled ? requestCacheMaxAgeSeconds(base.request) : undefined,
    sharedCacheKey: cacheKey,
    cacheKey,
    attemptedIdentityCacheKeys: [],
    cacheFill: undefined,
    cacheStatus: cacheKey === undefined ? "bypass" : "miss",
    cacheable: cacheKey !== undefined,
    identity: undefined,
    paginatedIdentityRateRecorded: false,
  };
}

async function executeRelay(state: ActiveRelay): Promise<Response> {
  if (state.route.logs && !hasConditionalRequestHeaders(state.request)) {
    const terminalProof = await terminalLogCacheProof(
      state.env,
      state.ctx,
      state.request,
      state.route,
      state.policy,
    );
    if (terminalProof !== undefined) {
      const key = terminalProof.key;
      state.terminalLogCacheKey = key;
      state.cacheStatus = "miss";
      state.cacheable = true;
      const cached = await readTerminalLogCache(state.env, key);
      if (cached !== undefined) {
        await ensurePublicGitHubRepo(state.env, state.route, cached.created_at, state.coordinator);
        if (terminalLogNeedsRevalidation(cached)) {
          state.terminalLogCached = cached;
        } else {
          return serveCachedGitHubResponse(
            state.env,
            state.ctx,
            cachedResponseParams(state, cached, "hit"),
          );
        }
      }
    }
  }
  const cached = await readFreshRelayCache(state);
  if (cached !== undefined) {
    return serveFreshCachedRelayResponse(state, cached);
  }

  const coalesced = await coalesceRelayCacheMiss(state);
  if (coalesced !== undefined) {
    return serveFreshCachedRelayResponse(state, coalesced, { coalesced: true });
  }

  const revalidated = await revalidateStaleRelayCache(state);
  if (revalidated !== undefined) {
    return revalidated;
  }

  const web = await callTokenFreeBackend(state);
  if (web !== undefined) {
    return web;
  }

  if (state.route.tokenFreeOnly) {
    const stale = await serveStaleRelayCache(state, "web_only_unavailable");
    if (stale !== undefined) {
      return stale;
    }
    throw new HttpError(503, "token_free_unavailable", "Token-free GitHub search is unavailable");
  }

  await ensurePublicGitHubRepo(state.env, state.route, undefined, state.coordinator);
  const fallback = capabilitiesForRouteKind(state.route.kind).fallback;
  if (fallback === "local") {
    throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
      reason: "web_only_unavailable",
    });
  }
  if (fallback === "github_public") {
    return callPublicBackend(state);
  }
  return callIdentityPool(state);
}

async function readFreshRelayCache(state: ActiveRelay): Promise<CachedGitHubResponse | undefined> {
  let cached = await readAvailableCache(state);
  if (
    cached !== undefined ||
    state.cacheKey === undefined ||
    state.route.state_hint_source !== "cached"
  ) {
    return cached;
  }
  state.route = await verifyPRStateHintLive(state.env, state.request, state.route);
  const cacheKey = state.cacheEnabled
    ? await githubCacheKey(state.request.pool, state.cacheRequest, state.route)
    : undefined;
  state.sharedCacheKey = cacheKey;
  await switchRelayCacheKey(state, cacheKey);
  cached = await readAvailableCache(state);
  return cached;
}

async function readAvailableCache(state: ActiveRelay): Promise<CachedGitHubResponse | undefined> {
  if (state.cacheKey === undefined) {
    return undefined;
  }
  return readCacheEntry(state, state.cacheKey, state.identity);
}

async function readCacheEntry(
  state: ActiveRelay,
  cacheKey: string,
  identity: Identity | undefined,
): Promise<CachedGitHubResponse | undefined> {
  const cached = await readGitHubCache(state.env, cacheKey, state.ctx, state.maxAgeSeconds);
  if (
    cached === undefined ||
    !(await cachedResponseAvailable(
      state.env,
      state.request.pool,
      state.route,
      cached,
      state.coordinator,
      identity,
    ))
  ) {
    return undefined;
  }
  return cached;
}

async function coalesceRelayCacheMiss(
  state: ActiveRelay,
): Promise<CachedGitHubResponse | undefined> {
  if (state.cacheKey === undefined) {
    return undefined;
  }
  const fill = await coalesceGitHubCacheMiss(state.env, state.coordinator, state.cacheKey, {
    ctx: state.ctx,
    ...(state.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: state.maxAgeSeconds }),
    acceptCached: (cached) =>
      cachedResponseAvailable(
        state.env,
        state.request.pool,
        state.route,
        cached,
        state.coordinator,
        state.identity,
      ),
  });
  state.cacheFill = fill.owner;
  return fill.cached;
}

async function revalidateStaleRelayCache(state: ActiveRelay): Promise<Response | undefined> {
  try {
    return await attemptStaleRelayCacheRevalidation(state);
  } catch {
    return restoreSharedCacheFill(state);
  }
}

async function attemptStaleRelayCacheRevalidation(
  state: ActiveRelay,
): Promise<Response | undefined> {
  if (state.cacheKey === undefined) {
    return undefined;
  }
  const capabilities = capabilitiesForRouteKind(state.route.kind);
  const identities =
    capabilities.fallback === "pool"
      ? await loadIdentities(state.env, state.request.pool, state.route)
      : [];
  await rememberIdentityCacheKeys(state, identities);
  const candidates = await staleRevalidationCandidates(state);
  if (candidates.length === 0) {
    return undefined;
  }

  const usesTokenFreeAPI = supportsAnonymousGitHubAPI(state.request, state.route);
  if (usesTokenFreeAPI || capabilities.fallback === "github_public") {
    if (state.cacheFill === undefined) {
      const coalesced = await coalesceRelayCacheMiss(state);
      if (coalesced !== undefined) {
        return serveCachedGitHubResponse(
          state.env,
          state.ctx,
          cachedResponseParams(state, coalesced, "hit", { coalesced: true }),
        );
      }
      if (state.cacheFill === undefined) {
        return restoreSharedCacheFill(state);
      }
    }
    if (!usesTokenFreeAPI && !(await guardRevalidationPublicRepo(state))) {
      return undefined;
    }
    const github = await callRevalidationAPI(state, candidates[0]!, usesTokenFreeAPI);
    if (github === undefined) {
      return restoreSharedCacheFill(state);
    }
    const response = await finishRevalidation(state, candidates[0]!, github, undefined, {
      backend: usesTokenFreeAPI ? "web" : "github_public",
    });
    return response ?? restoreSharedCacheFill(state);
  }
  if (identities.length === 0) {
    return undefined;
  }
  if (!(await guardRevalidationPublicRepo(state))) {
    return undefined;
  }

  let selection;
  try {
    selection = await selectIdentity(state.coordinator, {
      routeKey: state.route.routeKey,
      resource: state.route.resource,
      candidates: identities.map((identity) => ({ id: identity.id, weight: identity.weight })),
    });
  } catch {
    return undefined;
  }
  const identity = findIdentity(identities, selection.identityId);
  const identityCacheKey = await githubCacheKey(
    state.request.pool,
    state.request,
    state.route,
    identity,
  );
  state.identity = identity;
  await switchRelayCacheKey(state, identityCacheKey);
  const coalesced = await coalesceRelayCacheMiss(state);
  if (coalesced !== undefined) {
    return serveCachedGitHubResponse(
      state.env,
      state.ctx,
      cachedResponseParams(state, coalesced, "hit", { coalesced: true }),
    );
  }
  if (state.cacheFill === undefined) {
    return restoreSharedCacheFill(state);
  }
  const github = await callRevalidationAPI(state, candidates[0]!, false, identity);
  if (github === undefined) {
    return restoreSharedCacheFill(state);
  }
  const response = await finishRevalidation(state, candidates[0]!, github, identity, {
    leaseReason: selection.reason,
  });
  return response ?? restoreSharedCacheFill(state);
}

async function staleRevalidationCandidates(state: ActiveRelay): Promise<RevalidationCandidate[]> {
  const candidates: RevalidationCandidate[] = [];
  for (const candidate of staleCacheCandidates(state)) {
    const cached = await readStaleGitHubCache(state.env, candidate.cacheKey, state.route);
    if (cached === undefined) {
      continue;
    }
    const headers = githubCacheRevalidationHeaders(cached);
    if (headers !== undefined) {
      candidates.push({ cached, headers });
    }
  }
  return candidates.sort(
    (left, right) =>
      Number(left.cached.identity !== undefined) - Number(right.cached.identity !== undefined),
  );
}

async function callRevalidationAPI(
  state: ActiveRelay,
  candidate: RevalidationCandidate,
  tokenFree: boolean,
  identity?: Identity,
): Promise<GitHubRelayResponse | undefined> {
  const request: RelayRequest = {
    ...state.cacheRequest,
    headers: { ...state.cacheRequest.headers, ...candidate.headers },
  };
  try {
    if (tokenFree) {
      const response = await callAnonymousGitHubAPI(state.env, request, state.route);
      return response === undefined
        ? undefined
        : completeRunJobsSuperset(response, state.runJobsSuperset, anonymousRunJobsPage(state));
    }
    if (identity !== undefined) {
      state.paginatedIdentityRateRecorded = false;
      const response = sanitizeGitHubResponse(
        state.route,
        await callGitHub(state.env, identity, request, state.route),
      );
      return completeRunJobsSuperset(
        response,
        state.runJobsSuperset,
        identityRunJobsPage(state, identity, response),
      );
    }
    return sanitizeGitHubResponse(
      state.route,
      await callPublicGitHub(state.env, request, state.route),
    );
  } catch {
    return undefined;
  }
}

async function finishRevalidation(
  state: ActiveRelay,
  candidate: RevalidationCandidate,
  github: GitHubRelayResponse,
  identity: Identity | undefined,
  result: Pick<RelaySuccess, "backend" | "leaseReason">,
): Promise<Response | undefined> {
  if (github.status >= 200 && github.status < 300) {
    if (identity === undefined && anonymousGitHubResponseProvesPublicRepo(state.route)) {
      await recordPublicGitHubRepo(state.env, state.route);
    } else {
      await ensurePublicGitHubRepo(state.env, state.route, undefined, state.coordinator);
    }
    return finalizeRelaySuccess(state, {
      github: sanitizeGitHubResponse(state.route, github),
      ...(identity === undefined ? {} : { identity }),
      ...result,
      rate: rateFromHeaders(github.headers),
    });
  }
  if (github.status !== 304) {
    if (identity !== undefined) {
      await state.coordinator.recordResult(
        coordinatorResult(state, identity, github.status, rateFromHeaders(github.headers)),
      );
    }
    return undefined;
  }

  let available = false;
  try {
    available = await cachedResponseAvailable(
      state.env,
      state.request.pool,
      state.route,
      candidate.cached,
      state.coordinator,
      candidate.cached.identity,
      true,
    );
  } catch {
    available = false;
  }
  if (!available) {
    return undefined;
  }
  const refreshed: GitHubRelayResponse = {
    status: candidate.cached.status,
    headers: { ...candidate.cached.headers, ...github.headers },
    body: candidate.cached.body,
    ...(candidate.cached.body_encoding === undefined
      ? {}
      : { body_encoding: candidate.cached.body_encoding }),
  };
  return finalizeRelaySuccess(state, {
    github: refreshed,
    ...(identity === undefined ? {} : { identity }),
    ...result,
    rate: rateFromHeaders(github.headers),
    revalidated: true,
    upstreamStatus: 304,
  });
}

async function restoreSharedCacheFill(state: ActiveRelay): Promise<Response | undefined> {
  const coalesced = await restoreSharedCacheFillState(state);
  if (coalesced === undefined) {
    return undefined;
  }
  return serveCachedGitHubResponse(
    state.env,
    state.ctx,
    cachedResponseParams(state, coalesced, "hit", { coalesced: true }),
  );
}

async function guardRevalidationPublicRepo(state: ActiveRelay): Promise<boolean> {
  try {
    await ensurePublicGitHubRepo(state.env, state.route, undefined, state.coordinator);
    return true;
  } catch {
    await restoreSharedCacheFillState(state);
    return false;
  }
}

async function restoreSharedCacheFillState(
  state: ActiveRelay,
): Promise<CachedGitHubResponse | undefined> {
  state.identity = undefined;
  if (state.cacheKey !== state.sharedCacheKey) {
    await switchRelayCacheKey(state, state.sharedCacheKey);
  }
  if (state.cacheKey === undefined || state.cacheFill !== undefined) {
    return undefined;
  }
  return coalesceRelayCacheMiss(state);
}

async function callTokenFreeBackend(state: ActiveRelay): Promise<Response | undefined> {
  if (state.cacheKey === undefined) {
    return undefined;
  }
  const response = await callGitHubWeb(state.env, state.cacheRequest, state.route);
  if (response === undefined) {
    return undefined;
  }
  const completed =
    response.backend === "github"
      ? await completeRunJobsSuperset(response, state.runJobsSuperset, anonymousRunJobsPage(state))
      : response;
  const github = sanitizeGitHubResponse(state.route, completed);
  if (anonymousGitHubResponseProvesPublicRepo(state.route)) {
    await recordPublicGitHubRepo(state.env, state.route);
  } else {
    await ensurePublicGitHubRepo(state.env, state.route, undefined, state.coordinator);
  }
  return finalizeRelaySuccess(state, { github, backend: "web" });
}

async function callPublicBackend(state: ActiveRelay): Promise<Response> {
  const github = sanitizeGitHubResponse(
    state.route,
    await callPublicGitHub(state.env, state.cacheRequest, state.route),
  );
  const fallbackReason = githubResponseLocalFallbackReason(
    github.status,
    rateFromHeaders(github.headers),
  );
  if (fallbackReason === undefined) {
    return finalizeRelaySuccess(state, { github, backend: "github_public" });
  }
  if (fallbackReason === "github_rate_limited" || fallbackReason === "github_identity_depleted") {
    try {
      return await callIdentityPool(state);
    } catch {
      // The anonymous request already had a clean local fallback. Preserve it
      // if the opportunistic pooled attempt cannot serve the request.
    }
  }
  throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
    reason: fallbackReason,
  });
}

async function callIdentityPool(state: ActiveRelay): Promise<Response> {
  const identities = await loadIdentities(state.env, state.request.pool, state.route);
  if (identities.length === 0) {
    throw new HttpError(503, "no_identity", "No active identity can serve this route");
  }
  await rememberIdentityCacheKeys(state, identities);
  const attemptedIdentityIds = new Set<string>();
  let fallbackReason = "identity_pool_depleted";
  for (let attempt = 0; attempt < identities.length; attempt++) {
    const candidates = identities
      .filter((candidate) => !attemptedIdentityIds.has(candidate.id))
      .map((candidate) => ({ id: candidate.id, weight: candidate.weight }));
    if (candidates.length === 0) {
      break;
    }
    const identityCached = await serveFreshIdentityCache(state, identities, attemptedIdentityIds);
    if (identityCached !== undefined) {
      return identityCached;
    }
    const selection = await selectIdentity(state.coordinator, {
      routeKey: state.route.routeKey,
      resource: state.route.resource,
      candidates,
    });
    const identity = findIdentity(identities, selection.identityId);
    state.identity = identity;
    const terminalLog = await revalidateCachedTerminalLog(state, identity, selection.reason);
    if (terminalLog !== undefined) {
      return terminalLog;
    }
    const identityCacheKey = state.cacheEnabled
      ? await githubCacheKey(state.request.pool, state.cacheRequest, state.route, identity)
      : undefined;
    rememberIdentityCacheKey(state, identityCacheKey, identity);
    await switchRelayCacheKey(state, identityCacheKey);
    const cached = await readAvailableCache(state);
    if (cached !== undefined) {
      return serveFreshCachedRelayResponse(state, cached);
    }
    const coalesced = await coalesceRelayCacheMiss(state);
    if (coalesced !== undefined) {
      return serveFreshCachedRelayResponse(state, coalesced, { coalesced: true });
    }
    const firstPage = sanitizeGitHubResponse(
      state.route,
      await callGitHub(state.env, identity, state.cacheRequest, state.route),
    );
    state.paginatedIdentityRateRecorded = false;
    const github = await completeRunJobsSuperset(
      firstPage,
      state.runJobsSuperset,
      identityRunJobsPage(state, identity, firstPage),
    );
    const rate = rateFromHeaders(github.headers);
    const identityFallback = githubResponseLocalFallbackReason(github.status, rate);
    if (identityFallback !== undefined) {
      attemptedIdentityIds.add(identity.id);
      fallbackReason = identityFallback;
      await state.coordinator.recordResult(coordinatorResult(state, identity, github.status, rate));
      continue;
    }
    return finalizeRelaySuccess(state, {
      github,
      identity,
      leaseReason: selection.reason,
      rate,
    });
  }
  const stale = await serveStaleRelayCache(state, fallbackReason);
  if (stale !== undefined) {
    return stale;
  }
  throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
    reason: fallbackReason,
  });
}

async function switchRelayCacheKey(
  state: ActiveRelay,
  cacheKey: string | undefined,
): Promise<void> {
  if (state.cacheKey === cacheKey) {
    return;
  }
  if (state.cacheKey !== undefined) {
    await state.cacheFill?.fail();
  }
  state.cacheKey = cacheKey;
  state.cacheFill = undefined;
  state.cacheStatus = cacheKey === undefined ? "bypass" : "miss";
  state.cacheable = cacheKey !== undefined;
}

async function finalizeRelaySuccess(state: ActiveRelay, result: RelaySuccess): Promise<Response> {
  const cacheStatus = result.revalidated === true ? "hit" : state.cacheStatus;
  if (runJobsSupersetIncomplete(result.github, state.runJobsSuperset)) {
    if (result.identity !== undefined && !state.paginatedIdentityRateRecorded) {
      state.ctx.waitUntil(
        state.coordinator.recordResult(
          coordinatorResult(state, result.identity, result.github.status, result.rate),
        ),
      );
    }
    throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
      reason: "pagination_exhausted",
    });
  }
  if (completedRunJobsResponse(result.github)) {
    state.route = await proveRunAttemptCompleted(state);
  }
  const cacheKey = state.cacheKey;
  if (cacheKey !== undefined) {
    const owner = state.cacheFill;
    if (owner === undefined) {
      throw new Error("cache fill upstream work completed without ownership");
    }
    await owner.publish(() =>
      publishGitHubCache(
        state.env,
        cacheKey,
        state.cacheRequest,
        state.route,
        result.github,
        result.identity,
      ),
    );
    state.cacheFill = undefined;
  }
  if (
    !state.runListExactFallback &&
    runListSupersetUnderfilled(result.github, state.runListSuperset)
  ) {
    if (result.identity !== undefined) {
      state.ctx.waitUntil(
        state.coordinator.recordResult(
          coordinatorResult(state, result.identity, result.github.status, result.rate),
        ),
      );
    }
    await switchToExactRunList(state);
    return executeRelay(state);
  }
  if (state.terminalLogCacheKey !== undefined) {
    await publishTerminalLogCache(state.env, state.terminalLogCacheKey, result.github);
  }
  const clientResponse = filterRunJobsSuperset(
    filterRunListSuperset(result.github, state.runListView, {
      preserveTotalCount: state.runListExactFallback,
    }),
    state.runJobsSuperset,
  );
  const backend = auditBackend(result);
  const background: Promise<unknown>[] = [
    insertAudit(state.env, {
      requestId: state.requestId,
      callerId: state.callerId,
      callerTokenId: state.callerTokenId,
      clientName: state.clientName,
      pool: state.request.pool,
      routeKey: state.route.routeKey,
      routeKind: state.route.kind,
      ...(result.identity === undefined ? {} : { identityId: result.identity.id }),
      status: clientResponse.status,
      durationMs: Date.now() - state.started,
      ...(result.revalidated === true ? { fallbackReason: "cache_revalidated" } : {}),
      ...(backend === undefined ? {} : { backend }),
      cacheStatus,
      cacheable: state.cacheable,
    }),
  ];
  if (result.identity !== undefined && !state.paginatedIdentityRateRecorded) {
    background.push(
      state.coordinator.recordResult(
        coordinatorResult(
          state,
          result.identity,
          result.upstreamStatus ?? result.github.status,
          result.rate,
        ),
      ),
    );
  }
  state.ctx.waitUntil(Promise.all(background));
  return jsonResponse({
    status: clientResponse.status,
    headers: clientResponse.headers,
    body: clientResponse.body,
    body_encoding: clientResponse.body_encoding,
    ...(result.identity === undefined
      ? {}
      : { identity: { id: result.identity.id, kind: result.identity.kind } }),
    relay: {
      pool: state.request.pool,
      request_id: state.requestId,
      cacheable: state.route.cacheable,
      cache: cacheStatus,
      stale_ok: false,
      route_kind: state.route.kind,
      ...(result.backend === undefined ? {} : { backend: result.backend }),
      ...(result.leaseReason === undefined ? {} : { lease_reason: result.leaseReason }),
    },
  });
}

function coordinatorResult(
  state: ActiveRelay,
  identity: Identity,
  status: number,
  rate: GitHubRate | undefined,
): RecordResult {
  return {
    identityId: identity.id,
    routeKey: state.route.routeKey,
    resource: state.route.resource,
    status,
    ...(rate === undefined ? {} : { rate }),
  };
}

async function recordFirstPaginatedIdentityRate(
  state: ActiveRelay,
  identity: Identity,
  response: GitHubRelayResponse,
): Promise<void> {
  if (state.paginatedIdentityRateRecorded) {
    return;
  }
  await state.coordinator.recordResult(
    coordinatorResult(state, identity, response.status, rateFromHeaders(response.headers)),
  );
  state.paginatedIdentityRateRecorded = true;
}

function anonymousRunJobsPage(
  state: ActiveRelay,
): (request: RelayRequest) => Promise<GitHubRelayResponse | undefined> {
  return (request) => callAnonymousGitHubAPI(state.env, request, state.route);
}

function identityRunJobsPage(
  state: ActiveRelay,
  identity: Identity,
  firstPage: GitHubRelayResponse,
): (request: RelayRequest) => Promise<GitHubRelayResponse> {
  return async (request) => {
    await recordFirstPaginatedIdentityRate(state, identity, firstPage);
    const page = sanitizeGitHubResponse(
      state.route,
      await callGitHub(state.env, identity, request, state.route),
    );
    await state.coordinator.recordResult(
      coordinatorResult(state, identity, page.status, rateFromHeaders(page.headers)),
    );
    return page;
  };
}

async function handleRelayError(
  base: RelayBase,
  active: ActiveRelay | undefined,
  error: unknown,
): Promise<Response> {
  const reported = localFallbackError(error) ?? error;
  const staleReason = staleFallbackReasonFromError(reported);
  if (active !== undefined && staleReason !== undefined) {
    const stale = await serveStaleRelayCache(active, staleReason);
    if (stale !== undefined) {
      return stale;
    }
  }
  const audit = auditError(reported);
  const fallbackReason = auditFallbackReason(reported);
  base.ctx.waitUntil(
    insertAudit(base.env, {
      requestId: base.requestId,
      callerId: base.callerId,
      callerTokenId: base.callerTokenId,
      clientName: base.clientName,
      pool: base.request.pool,
      routeKey: active?.route.routeKey ?? normalizeRouteKey(base.request.method, base.request.path),
      routeKind: active?.route.kind ?? "denied",
      status: audit.status,
      errorCode: audit.code,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      durationMs: Date.now() - base.started,
      cacheStatus: active?.cacheStatus ?? "unknown",
      cacheable: active?.cacheable ?? false,
      ...(active?.identity === undefined ? {} : { identityId: active.identity.id }),
      ...(active?.identity === undefined ? {} : { backend: "github_identity" }),
    }),
  );
  throw reported;
}

async function serveStaleRelayCache(
  state: ActiveRelay,
  staleReason: string,
): Promise<Response | undefined> {
  if (!staleFallbackReason(staleReason)) {
    return undefined;
  }
  for (const candidate of staleCacheCandidates(state)) {
    const cached = await readStaleGitHubCache(state.env, candidate.cacheKey, state.route);
    if (
      cached === undefined ||
      !(await cachedResponseAvailable(
        state.env,
        state.request.pool,
        state.route,
        cached,
        state.coordinator,
        candidate.identity,
        true,
      ))
    ) {
      continue;
    }
    return serveCachedGitHubResponse(
      state.env,
      state.ctx,
      cachedResponseParams(state, cached, "stale", { staleReason }),
    );
  }
  return undefined;
}

function staleCacheCandidates(
  state: ActiveRelay,
): { cacheKey: string; identity?: Pick<Identity, "id" | "kind"> }[] {
  const candidates: { cacheKey: string; identity?: Pick<Identity, "id" | "kind"> }[] = [];
  for (const attempted of state.attemptedIdentityCacheKeys) {
    pushStaleCacheCandidate(candidates, attempted);
  }
  if (state.cacheKey !== undefined) {
    pushStaleCacheCandidate(candidates, {
      cacheKey: state.cacheKey,
      ...(state.identity === undefined ? {} : { identity: state.identity }),
    });
  }
  if (state.sharedCacheKey !== undefined && state.sharedCacheKey !== state.cacheKey) {
    pushStaleCacheCandidate(candidates, { cacheKey: state.sharedCacheKey });
  }
  return candidates;
}

function rememberIdentityCacheKey(
  state: ActiveRelay,
  cacheKey: string | undefined,
  identity: Pick<Identity, "id" | "kind">,
): void {
  if (
    cacheKey !== undefined &&
    !state.attemptedIdentityCacheKeys.some((candidate) => candidate.cacheKey === cacheKey)
  ) {
    state.attemptedIdentityCacheKeys.push({ cacheKey, identity });
  }
}

function pushStaleCacheCandidate(
  candidates: { cacheKey: string; identity?: Pick<Identity, "id" | "kind"> }[],
  candidate: { cacheKey: string; identity?: Pick<Identity, "id" | "kind"> },
): void {
  if (!candidates.some((existing) => existing.cacheKey === candidate.cacheKey)) {
    candidates.push(candidate);
  }
}

function cachedResponseParams(
  state: ActiveRelay,
  cached: CachedGitHubResponse,
  cacheStatus: "hit" | "stale",
  extras: { staleReason?: string; coalesced?: boolean } = {},
): Parameters<typeof serveCachedGitHubResponse>[2] {
  rejectIncompleteRunJobs(state, cached);
  const clientResponse = filterRunJobsSuperset(
    filterRunListSuperset(cached, state.runListView, {
      preserveTotalCount: state.runListExactFallback,
    }),
    state.runJobsSuperset,
  );
  return {
    requestId: state.requestId,
    callerId: state.callerId,
    callerTokenId: state.callerTokenId,
    clientName: state.clientName,
    pool: state.request.pool,
    route: state.route,
    cached: { ...cached, ...clientResponse },
    started: state.started,
    cacheStatus,
    ...(extras.staleReason === undefined ? {} : { staleReason: extras.staleReason }),
    ...(extras.coalesced === undefined ? {} : { coalesced: extras.coalesced }),
  };
}

function auditError(error: unknown): { status: number; code: string } {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code };
  }
  return { status: 500, code: "internal_error" };
}

function auditFallbackReason(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || error.code !== "fallback_local") {
    return undefined;
  }
  return typeof error.details?.reason === "string" ? error.details.reason : undefined;
}

function auditBackend(result: RelaySuccess): AuditBackend | undefined {
  if (result.identity !== undefined) {
    return "github_identity";
  }
  if (result.backend === "github_public" || result.github.backend === "github") {
    return "github_api";
  }
  return result.backend === "web" ? "github_web" : undefined;
}

async function serveCachedGitHubResponse(
  env: Env,
  ctx: ExecutionContext,
  params: {
    requestId: string;
    callerId: string;
    callerTokenId: string;
    clientName: string;
    pool: string;
    route: RouteInfo;
    cached: GitHubRelayResponse & {
      identity?: Pick<Identity, "id" | "kind">;
      created_at: string;
      expires_at?: string;
    };
    started: number;
    cacheStatus: "hit" | "stale";
    staleReason?: string;
    coalesced?: boolean;
  },
): Promise<Response> {
  const sanitizedCached = sanitizeGitHubResponse(params.route, params.cached);
  ctx.waitUntil(
    insertAudit(env, {
      requestId: params.requestId,
      callerId: params.callerId,
      callerTokenId: params.callerTokenId,
      clientName: params.clientName,
      pool: params.pool,
      routeKey: params.route.routeKey,
      routeKind: params.route.kind,
      status: params.cached.status,
      durationMs: Date.now() - params.started,
      ...(params.cached.identity === undefined ? {} : { identityId: params.cached.identity.id }),
      cacheStatus: params.cacheStatus,
      cacheable: true,
      ...(params.coalesced === undefined ? {} : { coalesced: params.coalesced }),
    }),
  );
  return jsonResponse({
    status: sanitizedCached.status,
    headers: sanitizedCached.headers,
    body: sanitizedCached.body,
    body_encoding: sanitizedCached.body_encoding,
    identity: params.cached.identity,
    relay: {
      pool: params.pool,
      request_id: params.requestId,
      cacheable: params.route.cacheable,
      cache: params.cacheStatus,
      stale_ok: params.cacheStatus === "stale",
      ...(params.staleReason === undefined ? {} : { stale_reason: params.staleReason }),
      ...(params.coalesced === true ? { coalesced: true } : {}),
      ...(params.cached.expires_at === undefined
        ? {}
        : { cache_expires_at: params.cached.expires_at }),
      route_kind: params.route.kind,
      ...(params.cached.identity === undefined && !params.route.logs
        ? {
            backend:
              capabilitiesForRouteKind(params.route.kind).fallback === "github_public"
                ? "github_public"
                : "web",
          }
        : {}),
    },
  });
}

function staleFallbackReason(reason: string): boolean {
  switch (reason) {
    case "github_identity_depleted":
    case "github_rate_limited":
    case "identities_cooling_down":
    case "identity_pool_depleted":
    case "no_identity":
    case "web_only_unavailable":
      return true;
    default:
      return false;
  }
}

async function publishGitHubCache(
  env: Env,
  cacheKey: string,
  request: Parameters<typeof writeGitHubCache>[2],
  route: Parameters<typeof writeGitHubCache>[3],
  response: Parameters<typeof writeGitHubCache>[4],
  identity?: Identity,
): Promise<CacheFillOutcome> {
  try {
    return await writeGitHubCache(env, cacheKey, request, route, response, identity);
  } catch (error) {
    console.error("github cache write failed", error);
    return "failed";
  }
}

async function publishTerminalLogCache(
  env: Env,
  key: string,
  response: GitHubRelayResponse,
): Promise<void> {
  try {
    await writeTerminalLogCache(env, key, response);
  } catch (error) {
    console.error("actions log cache write failed", error);
  }
}

async function revalidateCachedTerminalLog(
  state: ActiveRelay,
  identity: Identity,
  leaseReason: SelectionLeaseReason,
): Promise<Response | undefined> {
  const cached = state.terminalLogCached;
  const key = state.terminalLogCacheKey;
  if (cached === undefined || key === undefined) {
    return undefined;
  }
  state.terminalLogCached = undefined;
  try {
    const probe = await probeGitHubLog(state.env, identity, state.request);
    if (probe.kind === "exists") {
      await publishTerminalLogCache(state.env, key, cached);
      state.ctx.waitUntil(
        state.coordinator.recordResult(
          coordinatorResult(state, identity, probe.status, rateFromHeaders(probe.headers)),
        ),
      );
      return serveCachedGitHubResponse(
        state.env,
        state.ctx,
        cachedResponseParams(state, cached, "hit"),
      );
    }
    if (probe.kind === "deleted") {
      await deleteTerminalLogCache(state.env, key);
      const github = sanitizeGitHubResponse(state.route, probe.response);
      return finalizeRelaySuccess(state, {
        github,
        identity,
        leaseReason,
        rate: rateFromHeaders(github.headers),
      });
    }
  } catch (error) {
    console.error("actions log existence probe failed", error);
  }
  return undefined;
}

async function serveFreshCachedRelayResponse(
  state: ActiveRelay,
  cached: CachedGitHubResponse,
  extras: { coalesced?: boolean } = {},
): Promise<Response> {
  if (!state.runListExactFallback && runListSupersetUnderfilled(cached, state.runListSuperset)) {
    await switchToExactRunList(state);
    return executeRelay(state);
  }
  return serveCachedGitHubResponse(
    state.env,
    state.ctx,
    cachedResponseParams(state, cached, "hit", extras),
  );
}

function rejectIncompleteRunJobs(state: ActiveRelay, response: GitHubRelayResponse): void {
  if (runJobsSupersetIncomplete(response, state.runJobsSuperset)) {
    throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
      reason: "pagination_exhausted",
    });
  }
}

function completedRunJobsResponse(response: GitHubRelayResponse): boolean {
  return (
    isRecord(response.body) &&
    Array.isArray(response.body.jobs) &&
    response.body.jobs.length > 0 &&
    response.body.jobs.every((job) => isRecord(job) && job.status === "completed")
  );
}

async function proveRunAttemptCompleted(state: ActiveRelay): Promise<RouteInfo> {
  if (state.route.kind !== "run_jobs" || state.route.run_attempt === undefined) {
    return state.route;
  }
  const path = state.request.path.replace(/\/jobs$/, "");
  const request: RelayRequest = {
    pool: state.request.pool,
    method: "GET",
    path,
    headers: { "x-octopool-public-shape": PUBLIC_SHAPES.actionsSummary },
  };
  const route: RouteInfo = {
    ...state.route,
    kind: "run_view",
    routeKey: state.route.routeKey.replace(/\/jobs$/, ""),
  };
  try {
    const response = await callGitHubWeb(state.env, request, route);
    if (
      response !== undefined &&
      response.status >= 200 &&
      response.status < 300 &&
      isRecord(response.body) &&
      response.body.status === "completed" &&
      response.body.run_attempt === state.route.run_attempt
    ) {
      return { ...state.route, run_attempt_completed: true };
    }
  } catch {
    // The proof only enables a longer TTL; failure keeps the conservative default.
  }
  return state.route;
}

async function switchToExactRunList(state: ActiveRelay): Promise<void> {
  state.runListExactFallback = true;
  state.cacheRequest = exactRunListRequest(state.request, state.route);
  state.identity = undefined;
  state.attemptedIdentityCacheKeys = [];
  const cacheKey = await githubCacheKey(state.request.pool, state.cacheRequest, state.route);
  state.sharedCacheKey = cacheKey;
  await switchRelayCacheKey(state, cacheKey);
}

function hasConditionalRequestHeaders(request: RelayRequest): boolean {
  return (
    request.headers?.["if-none-match"] !== undefined ||
    request.headers?.["if-modified-since"] !== undefined
  );
}

function staleFallbackReasonFromError(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) {
    return undefined;
  }
  if (error.code !== "fallback_local") {
    return staleFallbackReason(error.code) ? error.code : undefined;
  }
  const reason = error.details?.reason;
  return typeof reason === "string" && staleFallbackReason(reason) ? reason : undefined;
}

async function serveFreshIdentityCache(
  state: ActiveRelay,
  identities: Identity[],
  attemptedIdentityIds: Set<string>,
): Promise<Response | undefined> {
  if (!state.cacheEnabled) {
    return undefined;
  }
  for (const identity of identities) {
    if (attemptedIdentityIds.has(identity.id)) {
      continue;
    }
    const cacheKey = await githubCacheKey(
      state.request.pool,
      state.cacheRequest,
      state.route,
      identity,
    );
    const cached = await readCacheEntry(state, cacheKey, identity);
    if (cached === undefined) {
      continue;
    }
    state.identity = identity;
    await switchRelayCacheKey(state, cacheKey);
    return serveFreshCachedRelayResponse(state, cached);
  }
  return undefined;
}

async function rememberIdentityCacheKeys(
  state: ActiveRelay,
  identities: Identity[],
): Promise<void> {
  if (!state.cacheEnabled) {
    return;
  }
  for (const identity of identities) {
    rememberIdentityCacheKey(
      state,
      await githubCacheKey(state.request.pool, state.cacheRequest, state.route, identity),
      identity,
    );
  }
}

async function selectIdentity(
  coordinator: DurableObjectStub<PoolCoordinator>,
  request: SelectionRequest,
) {
  const selection = await coordinator.selectIdentity(request);
  if (selection.kind === "unavailable") {
    throw new HttpError(503, "identities_cooling_down", "All identity candidates are cooling down");
  }
  return selection;
}

async function cachedIdentityAvailable(
  env: Env,
  pool: string,
  route: ReturnType<typeof classifyRoute>,
  cachedIdentity: Pick<Identity, "id" | "kind"> | undefined,
  selectedIdentity: Pick<Identity, "id" | "kind"> | undefined,
): Promise<boolean> {
  if (selectedIdentity === undefined) {
    return cachedIdentity === undefined;
  }
  if (
    cachedIdentity === undefined ||
    cachedIdentity.id !== selectedIdentity.id ||
    cachedIdentity.kind !== selectedIdentity.kind
  ) {
    return false;
  }
  if (capabilitiesForRouteKind(route.kind).fallback === "github_public") {
    return false;
  }
  const activeIdentities = await loadIdentities(env, pool, route, { fresh: true });
  if (activeIdentities.length === 0) {
    throw new HttpError(503, "no_identity", "No active identity can serve this route");
  }
  return activeIdentities.some((candidate) => candidate.id === cachedIdentity.id);
}

async function staleCachedIdentityAvailable(
  env: Env,
  pool: string,
  route: ReturnType<typeof classifyRoute>,
  cachedIdentity: Pick<Identity, "id" | "kind"> | undefined,
  selectedIdentity: Pick<Identity, "id" | "kind"> | undefined,
): Promise<boolean> {
  try {
    return await cachedIdentityAvailable(env, pool, route, cachedIdentity, selectedIdentity);
  } catch (error) {
    if (error instanceof HttpError && error.code === "no_identity") {
      return false;
    }
    throw error;
  }
}

async function cachedResponseAvailable(
  env: Env,
  pool: string,
  route: ReturnType<typeof classifyRoute>,
  cached: GitHubRelayResponse & {
    identity?: Pick<Identity, "id" | "kind">;
    created_at: string;
  },
  coordinator: DurableObjectStub<PoolCoordinator>,
  selectedIdentity?: Pick<Identity, "id" | "kind">,
  stale = false,
): Promise<boolean> {
  const identityAvailable = stale
    ? staleCachedIdentityAvailable(env, pool, route, cached.identity, selectedIdentity)
    : cachedIdentityAvailable(env, pool, route, cached.identity, selectedIdentity);
  const [available] = await Promise.all([
    identityAvailable,
    ensurePublicGitHubRepo(env, route, cached.created_at, coordinator),
  ]);
  return available;
}

function findIdentity(identities: Identity[], id: string): Identity {
  const identity = identities.find((candidate) => candidate.id === id);
  if (identity === undefined) {
    throw new HttpError(503, "identity_selection_invalid", "Selected identity is not available");
  }
  return identity;
}
