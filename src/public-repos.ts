import { envSecret } from "./auth";
import {
  acquireOwnedCacheFill,
  type CacheFillCoordinator,
  type CacheFillOutcome,
} from "./cache-fill";
import { deleteEdgeJSON, readEdgeJSON, writeEdgeJSON } from "./edge-cache";
import { queries } from "./generated/sql";
import { parseSQLiteTimestamp, sqliteTimestamp } from "./sqlite-time";
import { HttpError, parsePositiveInt } from "./http";
import { capabilitiesForRouteKind } from "./route-manifest";
import type { RouteInfo } from "./types";

type GitHubRepoResponse = {
  private?: unknown;
};

type PublicRepoProof = {
  checked_at: string;
  expires_at: string;
};

type PublicRepoProofSource = "edge" | "shared";

const EDGE_CACHE_NAMESPACE = "public-repo-v1";

export async function ensurePublicGitHubRepo(
  env: Env,
  route: RouteInfo,
  cacheCreatedAt?: string,
  coordinator?: CacheFillCoordinator,
): Promise<void> {
  if (route.owner === undefined || route.repo === undefined) {
    return;
  }
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  if (
    cacheCreatedAt !== undefined &&
    (await coveringPublicRepoProofSource(env, route, cacheCreatedAt, { requireFresh: true })) !==
      undefined
  ) {
    return;
  }
  const proofKey = `public-repo:${owner}/${repo}`;
  const proofStartedAt = sqliteTimestamp(new Date());
  if (coordinator === undefined) {
    await refreshPublicGitHubRepoProof(env, owner, repo, route, cacheCreatedAt);
    return;
  }

  for (;;) {
    const acquisition = await acquireOwnedCacheFill(coordinator, proofKey);
    if (acquisition.kind !== "owner") {
      if (acquisition.kind === "completed") {
        const source =
          acquisition.outcome === "shared"
            ? await coveringPublicRepoProofSource(env, route, proofStartedAt, {
                requireFresh: true,
              })
            : acquisition.outcome === "edge_only"
              ? await coveringPublicRepoProofSource(env, route, proofStartedAt, {
                  requireFresh: true,
                  source: "edge",
                })
              : undefined;
        if (source !== undefined) {
          return;
        }
      }
      continue;
    }

    const ownerFill = acquisition.owner;
    try {
      if (
        cacheCreatedAt !== undefined &&
        (await coveringPublicRepoProofSource(env, route, cacheCreatedAt, {
          requireFresh: true,
          source: "shared",
        })) === "shared"
      ) {
        await ownerFill.complete("shared");
        return;
      }
      const outcome = await ownerFill.publish(() =>
        refreshPublicGitHubRepoProof(env, owner, repo, route, cacheCreatedAt),
      );
      if (outcome !== undefined) {
        return;
      }
    } finally {
      await ownerFill.fail();
    }
  }
}

export async function recordPublicGitHubRepo(env: Env, route: RouteInfo): Promise<void> {
  if (route.owner === undefined || route.repo === undefined) {
    return;
  }
  try {
    await storePublicRepoProof(env, route.owner.toLowerCase(), route.repo.toLowerCase());
  } catch (error) {
    console.error("public repo proof persistence failed", error);
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
  env: Env,
  owner: string,
  repo: string,
  route: RouteInfo,
  cacheCreatedAt?: string,
): Promise<CacheFillOutcome> {
  if (route.tokenFreeOnly) {
    const pageProof = await fetchPublicRepoPageProof(env, owner, repo);
    if (pageProof === false) {
      throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
    }
    if (pageProof === undefined) {
      throw new HttpError(
        502,
        "repo_public_check_failed",
        "GitHub public repository page check failed",
      );
    }
    return storePublicRepoProof(env, owner, repo);
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
      throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
    }
    if (pageProof === true) {
      return storePublicRepoProof(env, owner, repo);
    }
  }
  if (response.status === 404) {
    throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
  }
  if (!response.ok) {
    if (
      cacheCreatedAt !== undefined &&
      (publicCheckMayUseHistoricalProof(response) || historicalProofEligibleResponse !== undefined)
    ) {
      const source = await coveringPublicRepoProofSource(env, route, cacheCreatedAt);
      if (source !== undefined) {
        return source === "shared" ? "shared" : "edge_only";
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
    throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
  }
  return storePublicRepoProof(env, owner, repo);
}

function fetchPublicRepoProof(
  env: Env,
  owner: string,
  repo: string,
  authenticated: boolean,
): Promise<Response> {
  return fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: publicRepoCheckHeaders(env, authenticated),
      signal: AbortSignal.timeout(parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000)),
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
  env: Env,
  owner: string,
  repo: string,
): Promise<boolean | undefined> {
  let response: Response;
  try {
    response = await fetch(
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: { accept: "text/html", "user-agent": "octopool" },
        redirect: "manual",
        signal: AbortSignal.timeout(parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000)),
      },
    );
  } catch {
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

async function storePublicRepoProof(
  env: Env,
  owner: string,
  repo: string,
): Promise<CacheFillOutcome> {
  const ttlSeconds = parsePositiveInt(
    (env as unknown as Record<string, string | undefined>).PUBLIC_REPO_TTL_SECONDS,
    30,
  );
  const checkedAt = new Date();
  const proof: PublicRepoProof = {
    checked_at: sqliteTimestamp(checkedAt),
    expires_at: sqliteTimestamp(new Date(checkedAt.getTime() + ttlSeconds * 1000)),
  };
  const sharedWrite = (async () => {
    try {
      await env.DB.prepare(queries.upsertPublicRepoProof)
        .bind(owner, repo, `+${ttlSeconds} seconds`)
        .run();
      return true;
    } catch (error) {
      console.error("public repo shared proof write failed", error);
      return false;
    }
  })();
  const edgeWrite = writeEdgeJSON(
    EDGE_CACHE_NAMESPACE,
    publicProofKey(owner, repo),
    proof,
    ttlSeconds,
  ).catch((error: unknown) => {
    console.error("public repo edge proof write failed", error);
    return false;
  });
  const [edgePublished, sharedPublished] = await Promise.all([edgeWrite, sharedWrite]);
  return sharedPublished ? "shared" : edgePublished ? "edge_only" : "failed";
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
  options: { requireFresh?: boolean; source?: PublicRepoProofSource } = {},
): Promise<PublicRepoProofSource | undefined> {
  if (route.owner === undefined || route.repo === undefined) {
    return "shared";
  }
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  const edgeKey = publicProofKey(owner, repo);
  if (options.source !== "shared") {
    const edge = await readEdgeJSON<PublicRepoProof>(EDGE_CACHE_NAMESPACE, edgeKey);
    if (edge !== undefined) {
      if (publicProofCovers(edge, cacheCreatedAt)) {
        return "edge";
      }
      await deleteEdgeJSON(EDGE_CACHE_NAMESPACE, edgeKey);
    }
    if (options.source === "edge") {
      return undefined;
    }
  }
  const query = options.requireFresh
    ? queries.freshCoveringPublicRepoProof
    : queries.coveringPublicRepoProof;
  const row = await readD1PublicRepoProof(env, query, owner, repo, cacheCreatedAt);
  if (row === null || !publicProofCovers(row, cacheCreatedAt)) {
    return undefined;
  }
  const ttlSeconds = Math.floor((parseSQLiteTimestamp(row.expires_at) - Date.now()) / 1000);
  await writeEdgeJSON(EDGE_CACHE_NAMESPACE, edgeKey, row, ttlSeconds);
  return "shared";
}

function readD1PublicRepoProof(
  env: Env,
  query: string,
  owner: string,
  repo: string,
  cacheCreatedAt: string,
): Promise<PublicRepoProof | null> {
  return env.DB.prepare(query).bind(owner, repo, cacheCreatedAt).first<PublicRepoProof>();
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

function publicProofKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
