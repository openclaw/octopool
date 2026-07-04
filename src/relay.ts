import { authenticateCaller } from "./auth";
import {
  type CachedGitHubResponse,
  githubCacheKey,
  readGitHubCache,
  readStaleGitHubCache,
  requestCacheMaxAgeSeconds,
  shouldUseGitHubCache,
  writeGitHubCache,
} from "./cache";
import { coalesceGitHubCacheMiss, finishGitHubCacheFill } from "./cache-coalesce";
import { insertAudit, loadIdentities, loadPoolPolicy } from "./db";
import { callGitHub, callPublicGitHub } from "./github";
import { rateFromHeaders, type GitHubRate } from "./github-rate";
import { callGitHubWeb } from "./github-web";
import { sanitizeGitHubResponse } from "./github-sanitize";
import { HttpError, jsonResponse, parseJsonObject } from "./http";
import { githubResponseLocalFallbackReason, localFallbackError } from "./local-fallback";
import { classifyRoute, normalizeRouteKey, validateRelayRequest } from "./policy";
import type { PoolCoordinator } from "./pool-coordinator";
import { verifyPRStateHint, verifyPRStateHintLive } from "./pr-state";
import {
  anonymousGitHubResponseProvesPublicRepo,
  ensurePublicGitHubRepo,
  recordPublicGitHubRepo,
} from "./public-repos";
import { capabilitiesForRouteKind } from "./route-manifest";
import type {
  GitHubRelayResponse,
  Identity,
  RecordResult,
  RelayRequest,
  RouteInfo,
  SelectionRequest,
  SelectionResult,
} from "./types";

type RelayBase = {
  env: Env;
  ctx: ExecutionContext;
  requestId: string;
  started: number;
  request: RelayRequest;
  callerId: string;
  coordinator: DurableObjectStub<PoolCoordinator>;
};

type ActiveRelay = RelayBase & {
  route: RouteInfo;
  cacheEnabled: boolean;
  maxAgeSeconds: number | undefined;
  sharedCacheKey: string | undefined;
  cacheKey: string | undefined;
  attemptedIdentityCacheKeys: { cacheKey: string; identity: Pick<Identity, "id" | "kind"> }[];
  cacheFillToken: string | undefined;
  cacheStatus: "miss" | "bypass";
  cacheable: boolean;
  identity: Identity | undefined;
};

type RelaySuccess = {
  github: GitHubRelayResponse;
  identity?: Identity;
  backend?: "web" | "github_public";
  leaseReason?: SelectionResult["reason"];
  rate?: GitHubRate;
};

export async function relayGitHub(
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
    coordinator: env.POOL_COORDINATOR.getByName(`pool:${relayRequest.pool}`),
  };
  let active: ActiveRelay | undefined;
  try {
    active = await prepareRelay(base, policy);
    return await executeRelay(active);
  } catch (error) {
    return await handleRelayError(base, active, error);
  } finally {
    if (active?.cacheKey !== undefined) {
      await finishGitHubCacheFill(active.coordinator, active.cacheKey, active.cacheFillToken);
    }
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
  const cacheKey = cacheEnabled
    ? await githubCacheKey(base.request.pool, base.request, route)
    : undefined;
  return {
    ...base,
    route,
    cacheEnabled,
    maxAgeSeconds: cacheEnabled ? requestCacheMaxAgeSeconds(base.request) : undefined,
    sharedCacheKey: cacheKey,
    cacheKey,
    attemptedIdentityCacheKeys: [],
    cacheFillToken: undefined,
    cacheStatus: cacheKey === undefined ? "bypass" : "miss",
    cacheable: cacheKey !== undefined,
    identity: undefined,
  };
}

async function executeRelay(state: ActiveRelay): Promise<Response> {
  const cached = await readFreshRelayCache(state);
  if (cached !== undefined) {
    return serveCachedGitHubResponse(
      state.env,
      state.ctx,
      cachedResponseParams(state, cached, "hit"),
    );
  }

  const coalesced = await coalesceRelayCacheMiss(state);
  if (coalesced !== undefined) {
    return serveCachedGitHubResponse(
      state.env,
      state.ctx,
      cachedResponseParams(state, coalesced, "hit", { coalesced: true }),
    );
  }

  const web = await callTokenFreeBackend(state);
  if (web !== undefined) {
    return web;
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
    ? await githubCacheKey(state.request.pool, state.request, state.route)
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
  const fill = await coalesceGitHubCacheMiss(
    state.env,
    state.coordinator,
    state.cacheKey,
    state.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: state.maxAgeSeconds },
  );
  state.cacheFillToken = fill.leaseToken;
  if (
    fill.cached === undefined ||
    !(await cachedResponseAvailable(
      state.env,
      state.request.pool,
      state.route,
      fill.cached,
      state.coordinator,
      state.identity,
    ))
  ) {
    return undefined;
  }
  return fill.cached;
}

async function callTokenFreeBackend(state: ActiveRelay): Promise<Response | undefined> {
  if (state.cacheKey === undefined) {
    return undefined;
  }
  const response = await callGitHubWeb(state.env, state.request, state.route);
  if (response === undefined) {
    return undefined;
  }
  const github = sanitizeGitHubResponse(state.route, response);
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
    await callPublicGitHub(state.env, state.request, state.route),
  );
  const fallbackReason = githubResponseLocalFallbackReason(
    github.status,
    rateFromHeaders(github.headers),
  );
  if (fallbackReason !== undefined) {
    throw new HttpError(424, "fallback_local", "Run this request with local GitHub credentials", {
      reason: fallbackReason,
    });
  }
  return finalizeRelaySuccess(state, { github, backend: "github_public" });
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
      pool: state.request.pool,
      routeKey: state.route.routeKey,
      resource: state.route.resource,
      candidates,
    });
    const identity = findIdentity(identities, selection.identityId);
    state.identity = identity;
    const identityCacheKey = state.cacheEnabled
      ? await githubCacheKey(state.request.pool, state.request, state.route, identity)
      : undefined;
    rememberIdentityCacheKey(state, identityCacheKey, identity);
    await switchRelayCacheKey(state, identityCacheKey);
    const cached = await readAvailableCache(state);
    if (cached !== undefined) {
      return serveCachedGitHubResponse(
        state.env,
        state.ctx,
        cachedResponseParams(state, cached, "hit"),
      );
    }
    const coalesced = await coalesceRelayCacheMiss(state);
    if (coalesced !== undefined) {
      return serveCachedGitHubResponse(
        state.env,
        state.ctx,
        cachedResponseParams(state, coalesced, "hit", { coalesced: true }),
      );
    }
    const github = sanitizeGitHubResponse(
      state.route,
      await callGitHub(state.env, identity, state.request, state.route),
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
    await finishGitHubCacheFill(state.coordinator, state.cacheKey, state.cacheFillToken);
  }
  state.cacheKey = cacheKey;
  state.cacheFillToken = undefined;
  state.cacheStatus = cacheKey === undefined ? "bypass" : "miss";
  state.cacheable = cacheKey !== undefined;
}

async function finalizeRelaySuccess(state: ActiveRelay, result: RelaySuccess): Promise<Response> {
  if (state.cacheKey !== undefined) {
    await publishGitHubCache(
      state.env,
      state.cacheKey,
      state.request,
      state.route,
      result.github,
      result.identity,
    );
  }
  const background: Promise<unknown>[] = [
    insertAudit(state.env, {
      requestId: state.requestId,
      callerId: state.callerId,
      pool: state.request.pool,
      routeKey: state.route.routeKey,
      routeKind: state.route.kind,
      ...(result.identity === undefined ? {} : { identityId: result.identity.id }),
      status: result.github.status,
      durationMs: Date.now() - state.started,
      cacheStatus: state.cacheStatus,
      cacheable: state.cacheable,
    }),
  ];
  if (result.identity !== undefined) {
    background.push(
      state.coordinator.recordResult(
        coordinatorResult(state, result.identity, result.github.status, result.rate),
      ),
    );
  }
  state.ctx.waitUntil(Promise.all(background));
  return jsonResponse({
    status: result.github.status,
    headers: result.github.headers,
    body: result.github.body,
    body_encoding: result.github.body_encoding,
    ...(result.identity === undefined
      ? {}
      : { identity: { id: result.identity.id, kind: result.identity.kind } }),
    relay: {
      pool: state.request.pool,
      request_id: state.requestId,
      cacheable: state.route.cacheable,
      cache: state.cacheStatus,
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
  return {
    requestId: state.requestId,
    callerId: state.callerId,
    pool: state.request.pool,
    route: state.route,
    cached,
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

async function serveCachedGitHubResponse(
  env: Env,
  ctx: ExecutionContext,
  params: {
    requestId: string;
    callerId: string;
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
      ...(params.cached.identity === undefined
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
): Promise<void> {
  try {
    await writeGitHubCache(env, cacheKey, request, route, response, identity);
  } catch (error) {
    console.error("github cache write failed", error);
  }
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
    const cacheKey = await githubCacheKey(state.request.pool, state.request, state.route, identity);
    const cached = await readCacheEntry(state, cacheKey, identity);
    if (cached === undefined) {
      continue;
    }
    state.identity = identity;
    await switchRelayCacheKey(state, cacheKey);
    return serveCachedGitHubResponse(
      state.env,
      state.ctx,
      cachedResponseParams(state, cached, "hit"),
    );
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
      await githubCacheKey(state.request.pool, state.request, state.route, identity),
      identity,
    );
  }
}

async function selectIdentity(
  coordinator: DurableObjectStub<PoolCoordinator>,
  request: SelectionRequest,
) {
  try {
    return await coordinator.selectIdentity(request);
  } catch (error) {
    if (error instanceof Error && error.message.includes("all_identity_candidates_cooling_down")) {
      throw new HttpError(
        503,
        "identities_cooling_down",
        "All identity candidates are cooling down",
      );
    }
    throw error;
  }
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
  const activeIdentities = await loadIdentities(env, pool, route);
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
