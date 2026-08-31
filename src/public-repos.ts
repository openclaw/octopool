import {
  CACHE_PUBLICATION_EPOCH,
  proofPublicationResource,
  type PublicationOwner,
} from "./cache-publication";
import { publicProofCoordinatorStub } from "./pool-coordinator";
import { envSecret } from "./auth";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { acquireOwnedCacheFill, startOwnedCacheFill, type CacheFillOutcome } from "./cache-fill";
import { readEdgeJSON, writeEdgeJSON } from "./edge-cache";
import { queries } from "./generated/sql";
import { requestTimeoutMs } from "./github-limits";
import { parseSQLiteTimestamp, sqliteTimestamp } from "./sqlite-time";
import { HttpError, parsePositiveInt } from "./http";
import { capabilitiesForRouteKind } from "./route-manifest";
import type { GitHubRelayResponse, RouteInfo } from "./types";

type GitHubRepoResponse = {
  private?: unknown;
};

type PublicRepoProof = {
  protocol_epoch: string;
  checked_at: string;
  expires_at: string;
  is_public: boolean | number;
  publication_id: number;
  publication_token: string;
};

type PublicRepoProofSource = "edge" | "shared";

export const PUBLIC_PROOF_EDGE_NAMESPACE = `public-repo-${CACHE_PUBLICATION_EPOCH}`;
const EDGE_CACHE_NAMESPACE = PUBLIC_PROOF_EDGE_NAMESPACE;

export async function ensurePublicGitHubRepo(
  env: GitHubEgressEnv,
  route: RouteInfo,
  cacheCreatedAt?: string,
): Promise<void> {
  if (route.owner === undefined || route.repo === undefined) return;
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  const edgeProof = await rejectFreshNegativePublicRepoProof(env, owner, repo);
  if (
    cacheCreatedAt !== undefined &&
    (await coveringPublicRepoProofSource(env, route, cacheCreatedAt, { edgeProof })) !== undefined
  )
    return;
  const coordinator = publicProofCoordinatorStub(env);
  const resource = proofPublicationResource(owner, repo);
  const startedAt = sqliteTimestamp(new Date());
  let minimumPublicationId = 0;
  for (;;) {
    const acquired = await acquireOwnedCacheFill(coordinator, resource);
    if (acquired.kind !== "owner") {
      if (
        acquired.kind === "completed" &&
        acquired.outcome === "shared" &&
        acquired.publicationId !== undefined &&
        (await readAuthoritativeProof(
          env,
          owner,
          repo,
          startedAt,
          Math.max(minimumPublicationId, acquired.publicationId),
        ))
      )
        return;
      continue;
    }
    const fill = acquired.owner;
    try {
      const reused =
        cacheCreatedAt === undefined
          ? undefined
          : await readAuthoritativeProof(env, owner, repo, cacheCreatedAt, minimumPublicationId);
      if (reused !== undefined) {
        await fill.complete("shared", reused.publication_id);
        return;
      }
      const observation = await refreshPublicGitHubRepoProof(
        env,
        owner,
        repo,
        route,
        cacheCreatedAt,
        minimumPublicationId,
      );
      if (observation === undefined) {
        await fill.complete("failed");
        return;
      }
      minimumPublicationId = Math.max(minimumPublicationId, fill.capability.id);
      const checkedAt = sqliteTimestamp(new Date());
      const result = await fill.publish(() =>
        storePublicRepoProof(env, owner, repo, observation, checkedAt, fill.capability),
      );
      if (
        result.storage === "rejected" ||
        result.completion !== "accepted" ||
        parseSQLiteTimestamp(publicProofExpiresAt(env, observation, checkedAt)) <= Date.now()
      ) {
        // Keep this evidence floor even if the next acquisition joins another owner's reuse.
        if (await readAuthoritativeProof(env, owner, repo, startedAt, minimumPublicationId)) return;
        continue;
      }
      if (!observation) throwRepoNotPublic();
      // A live direct probe can satisfy this request even if persistence failed.
      return;
    } finally {
      await fill.fail();
    }
  }
}

async function readAuthoritativeProof(
  env: Env,
  owner: string,
  repo: string,
  at: string,
  minimumId = 0,
): Promise<PublicRepoProof | undefined> {
  const proof = await env.DB.withSession("first-primary")
    .prepare(queries.readPublicRepoProof)
    .bind(CACHE_PUBLICATION_EPOCH, owner, repo)
    .first<PublicRepoProof>();
  if (proof === null || !publicProofIsFresh(proof) || proof.publication_id < minimumId)
    return undefined;
  if (!publicProofIsPublic(proof)) throwRepoNotPublic();
  return publicProofCovers(proof, at) ? proof : undefined;
}

export type GitHubObservation<T = GitHubRelayResponse> = Readonly<{
  response: T;
  observedAt: number;
}>;

export async function observeAnonymousPublicRepo<T extends GitHubRelayResponse | undefined>(
  env: Env,
  route: RouteInfo,
  observe: () => Promise<T>,
): Promise<GitHubObservation<T>> {
  if (!anonymousGitHubResponseProvesPublicRepo(route))
    return { response: await observe(), observedAt: Date.now() };
  const coordinator = publicProofCoordinatorStub(env);
  const resource = proofPublicationResource(route.owner!, route.repo!);
  let capability: PublicationOwner | undefined;
  try {
    capability = await coordinator.tryAcquirePublication(resource);
  } catch {
    // Exactly one optional attempt, before observation; no late evidence adoption.
  }
  const fill = capability === undefined ? undefined : startOwnedCacheFill(coordinator, capability);
  try {
    const response = await observe();
    const observedAt = Date.now();
    if (
      fill !== undefined &&
      response !== undefined &&
      response.status >= 200 &&
      response.status < 300
    ) {
      await fill.publish(() =>
        storePublicRepoProof(
          env,
          route.owner!.toLowerCase(),
          route.repo!.toLowerCase(),
          true,
          sqliteTimestamp(observedAt),
          fill.capability,
        ),
      );
    }
    return { response, observedAt };
  } finally {
    await fill?.fail();
  }
}

export function anonymousGitHubResponseProvesPublicRepo(route: RouteInfo): boolean {
  return (
    route.owner !== undefined &&
    route.repo !== undefined &&
    capabilitiesForRouteKind(route.kind).anonymousRepoProof
  );
}

async function refreshPublicGitHubRepoProof(
  env: GitHubEgressEnv,
  owner: string,
  repo: string,
  route: RouteInfo,
  cacheCreatedAt: string | undefined,
  minimumPublicationId: number,
): Promise<boolean | undefined> {
  if (route.tokenFreeOnly) {
    const pageProof = await fetchPublicRepoPageProof(env, owner, repo);
    if (pageProof === false) {
      return false;
    }
    if (pageProof === undefined) {
      throw new HttpError(
        502,
        "repo_public_check_failed",
        "GitHub public repository page check failed",
      );
    }
    return true;
  }
  let response = await fetchPublicRepoProof(env, owner, repo, true);
  let historicalProofEligibleResponse: Response | undefined;
  if (!response.ok && publicCheckMayRetryUnauthenticated(response)) {
    if (publicCheckMayUseHistoricalProof(response)) {
      historicalProofEligibleResponse = response;
    }
    response = await fetchPublicRepoProof(env, owner, repo, false);
  }
  if (!response.ok && publicCheckMayUseHistoricalProof(response)) {
    const pageProof = await fetchPublicRepoPageProof(env, owner, repo);
    if (pageProof === false) {
      return false;
    }
    if (pageProof === true) {
      return true;
    }
  }
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    if (
      cacheCreatedAt !== undefined &&
      (publicCheckMayUseHistoricalProof(response) || historicalProofEligibleResponse !== undefined)
    ) {
      const source = await coveringPublicRepoProofSource(env, route, cacheCreatedAt, {
        minimumPublicationId,
      });
      if (source !== undefined) {
        return undefined;
      }
    }
    throw new HttpError(
      502,
      "repo_public_check_failed",
      `GitHub public repository check failed with ${response.status}`,
    );
  }
  const body = (await response.json()) as GitHubRepoResponse;
  if (body.private !== false) {
    return false;
  }
  return true;
}

function fetchPublicRepoProof(
  env: GitHubEgressEnv,
  owner: string,
  repo: string,
  authenticated: boolean,
): Promise<Response> {
  return env.githubEgress.fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: publicRepoCheckHeaders(env, authenticated),
      signal: AbortSignal.timeout(requestTimeoutMs(env)),
    },
  );
}

function publicRepoCheckHeaders(env: Env, authenticated: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "octopool",
    "x-github-api-version": "2022-11-28",
  };
  const token = envSecret(env, "OCTOPOOL_GITHUB_ORG_TOKEN");
  if (authenticated && token !== undefined && token.trim() !== "") {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchPublicRepoPageProof(
  env: GitHubEgressEnv,
  owner: string,
  repo: string,
): Promise<boolean | undefined> {
  let response: Response;
  try {
    response = await env.githubEgress.fetch(
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: { accept: "text/html", "user-agent": "octopool" },
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs(env)),
      },
    );
  } catch (error) {
    rethrowStringRewriteDenial(error);
    return undefined;
  }
  if (response.status === 404) {
    return false;
  }
  if (!response.ok || response.body === null) {
    return undefined;
  }
  const marker = 'name="octolytics-dimension-repository_public" content="';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > 524_288) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
      const index = text.indexOf(marker);
      if (index !== -1) {
        const valueStart = index + marker.length;
        const match = /^(true|false)"/.exec(text.slice(valueStart));
        if (match !== null) {
          await reader.cancel();
          return match[1] === "true";
        }
        text = text.slice(index);
        continue;
      }
      text = text.slice(-2048);
    }
  } finally {
    reader.releaseLock();
  }
  return undefined;
}

export async function storePublicRepoProof(
  env: Env,
  owner: string,
  repo: string,
  isPublic: boolean,
  checkedAt: string,
  capability: PublicationOwner,
): Promise<CacheFillOutcome> {
  if (
    capability.protocol_epoch !== CACHE_PUBLICATION_EPOCH ||
    capability.resource_key !== proofPublicationResource(owner, repo)
  )
    return "rejected";
  const proof: PublicRepoProof = {
    protocol_epoch: CACHE_PUBLICATION_EPOCH,
    checked_at: checkedAt,
    expires_at: publicProofExpiresAt(env, isPublic, checkedAt),
    is_public: isPublic,
    publication_id: capability.id,
    publication_token: capability.owner_token,
  };
  let receipt: PublicRepoProof | null;
  let ambiguous = false;
  try {
    receipt = await env.DB.prepare(queries.upsertPublicRepoProof)
      .bind(
        CACHE_PUBLICATION_EPOCH,
        owner,
        repo,
        isPublic ? 1 : 0,
        proof.checked_at,
        proof.expires_at,
        capability.id,
        capability.owner_token,
      )
      .first<PublicRepoProof>();
  } catch {
    receipt = null;
    ambiguous = true;
  }
  if (receipt === null) {
    try {
      receipt = await env.DB.withSession("first-primary")
        .prepare(queries.readPublicRepoProof)
        .bind(CACHE_PUBLICATION_EPOCH, owner, repo)
        .first<PublicRepoProof>();
    } catch {
      return "unknown";
    }
    if (
      receipt?.publication_id !== capability.id ||
      receipt.publication_token !== capability.owner_token ||
      receipt.checked_at !== proof.checked_at ||
      receipt.expires_at !== proof.expires_at ||
      publicProofIsPublic(receipt) !== isPublic
    )
      return ambiguous ? "unknown" : "rejected";
  }
  await writeEdgeJSON(
    EDGE_CACHE_NAMESPACE,
    publicProofKey(owner, repo),
    proof,
    Math.floor((parseSQLiteTimestamp(proof.expires_at) - Date.now()) / 1000),
  );
  return "shared";
}

function publicProofExpiresAt(env: Env, isPublic: boolean, checkedAt: string): string {
  const vars = env as unknown as Record<string, string | undefined>;
  const ttlSeconds = isPublic
    ? parsePositiveInt(vars.PUBLIC_REPO_TTL_SECONDS, 30)
    : parsePositiveInt(vars.PUBLIC_REPO_NEGATIVE_TTL_SECONDS, 3_600);
  return sqliteTimestamp(parseSQLiteTimestamp(checkedAt) + ttlSeconds * 1000);
}

function publicCheckMayRetryUnauthenticated(response: Response): boolean {
  return response.status === 401 || publicCheckMayUseHistoricalProof(response);
}

function publicCheckMayUseHistoricalProof(response: Response): boolean {
  const remaining = response.headers.get("x-ratelimit-remaining");
  return (
    response.status >= 500 ||
    response.status === 429 ||
    (response.status === 403 && remaining === "0")
  );
}

async function coveringPublicRepoProofSource(
  env: Env,
  route: RouteInfo,
  cacheCreatedAt: string,
  options: {
    edgeProof?: PublicRepoProof | undefined;
    minimumPublicationId?: number;
  } = {},
): Promise<PublicRepoProofSource | undefined> {
  const minimumPublicationId = options.minimumPublicationId ?? 0;
  if (route.owner === undefined || route.repo === undefined) {
    return "shared";
  }
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  const edgeKey = publicProofKey(owner, repo);
  const edge =
    options.edgeProof ?? (await readEdgeJSON<PublicRepoProof>(EDGE_CACHE_NAMESPACE, edgeKey));
  if (
    edge !== undefined &&
    publicProofIsFresh(edge) &&
    publicProofIsPublic(edge) &&
    edge.publication_id >= minimumPublicationId &&
    publicProofCovers(edge, cacheCreatedAt)
  ) {
    return "edge";
  }
  const row = await readD1PublicRepoProof(
    env,
    queries.coveringPublicRepoProof,
    owner,
    repo,
    cacheCreatedAt,
  );
  if (
    row === null ||
    !(row.publication_id >= minimumPublicationId) ||
    !publicProofCovers(row, cacheCreatedAt)
  ) {
    return undefined;
  }
  const ttlSeconds = Math.floor((parseSQLiteTimestamp(row.expires_at) - Date.now()) / 1000);
  await writeEdgeJSON(EDGE_CACHE_NAMESPACE, edgeKey, { ...row, is_public: true }, ttlSeconds);
  return "shared";
}

async function rejectFreshNegativePublicRepoProof(
  env: Env,
  owner: string,
  repo: string,
): Promise<PublicRepoProof | undefined> {
  const edgeKey = publicProofKey(owner, repo);
  const edge = await readEdgeJSON<PublicRepoProof>(EDGE_CACHE_NAMESPACE, edgeKey);
  if (edge !== undefined && publicProofIsFresh(edge)) {
    if (!publicProofIsPublic(edge)) {
      throwRepoNotPublic();
    }
    return edge;
  }

  const row = await env.DB.prepare(queries.freshNegativePublicRepoProof)
    .bind(owner, repo, CACHE_PUBLICATION_EPOCH)
    .first<PublicRepoProof>();
  if (row === null || row === undefined || publicProofIsPublic(row) || !publicProofIsFresh(row)) {
    return undefined;
  }
  const ttlSeconds = Math.floor((parseSQLiteTimestamp(row.expires_at) - Date.now()) / 1000);
  await writeEdgeJSON(EDGE_CACHE_NAMESPACE, edgeKey, { ...row, is_public: false }, ttlSeconds);
  throwRepoNotPublic();
}

function readD1PublicRepoProof(
  env: Env,
  query: string,
  owner: string,
  repo: string,
  cacheCreatedAt: string,
): Promise<PublicRepoProof | null> {
  return env.DB.prepare(query)
    .bind(owner, repo, cacheCreatedAt, CACHE_PUBLICATION_EPOCH)
    .first<PublicRepoProof>();
}

function publicProofCovers(proof: PublicRepoProof, cacheCreatedAt: string): boolean {
  const checkedAt = parseSQLiteTimestamp(proof.checked_at);
  const expiresAt = parseSQLiteTimestamp(proof.expires_at);
  const cacheAt = parseSQLiteTimestamp(cacheCreatedAt);
  return (
    Number.isFinite(checkedAt) &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(cacheAt) &&
    checkedAt >= cacheAt - 5_000 &&
    expiresAt > Date.now()
  );
}

function publicProofIsFresh(proof: PublicRepoProof): boolean {
  if (
    proof.protocol_epoch !== CACHE_PUBLICATION_EPOCH ||
    ![true, false, 0, 1].includes(proof.is_public) ||
    typeof proof.checked_at !== "string" ||
    typeof proof.expires_at !== "string"
  ) {
    return false;
  }
  return (
    Number.isFinite(parseSQLiteTimestamp(proof.checked_at)) &&
    parseSQLiteTimestamp(proof.expires_at) > Date.now()
  );
}

function publicProofIsPublic(proof: PublicRepoProof): boolean {
  return proof.is_public === true || proof.is_public === 1;
}

function throwRepoNotPublic(): never {
  throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
}

function publicProofKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
