import { envSecret } from "./auth";
import { HttpError, parsePositiveInt } from "./http";
import type { RouteInfo } from "./types";

type GitHubRepoResponse = {
  private?: unknown;
};

export async function ensurePublicGitHubRepo(
  env: Env,
  route: RouteInfo,
  cacheCreatedAt?: string,
): Promise<void> {
  if (route.owner === undefined || route.repo === undefined) {
    return;
  }
  const owner = route.owner.toLowerCase();
  const repo = route.repo.toLowerCase();
  if (
    cacheCreatedAt === undefined
      ? await cachedPublicGitHubRepoIsFresh(env, owner, repo)
      : await cachedPublicGitHubRepoCovers(env, route, cacheCreatedAt, true)
  ) {
    return;
  }
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: publicRepoCheckHeaders(env),
      signal: AbortSignal.timeout(parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000)),
    },
  );
  if (response.status === 404) {
    throw new HttpError(403, "repo_not_public", "Octopool only relays public repositories");
  }
  if (!response.ok) {
    if (
      cacheCreatedAt !== undefined &&
      publicCheckMayUseHistoricalProof(response) &&
      (await cachedPublicGitHubRepoCovers(env, route, cacheCreatedAt))
    ) {
      return;
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
  const ttlSeconds = parsePositiveInt(
    (env as unknown as Record<string, string | undefined>).PUBLIC_REPO_TTL_SECONDS,
    30,
  );
  await env.DB.prepare(
    `INSERT INTO github_public_repos (owner, repo, checked_at, expires_at)
     VALUES (?1, ?2, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, ?3))
     ON CONFLICT(owner, repo) DO UPDATE SET
       checked_at = excluded.checked_at,
       expires_at = excluded.expires_at`,
  )
    .bind(owner, repo, `+${ttlSeconds} seconds`)
    .run();
}

function publicRepoCheckHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "octopool",
    "x-github-api-version": "2022-11-28",
  };
  const token = envSecret(env, "OCTOPOOL_GITHUB_ORG_TOKEN");
  if (token !== undefined && token.trim() !== "") {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function publicCheckMayUseHistoricalProof(response: Response): boolean {
  const remaining = response.headers.get("x-ratelimit-remaining");
  return response.status >= 500 || (response.status === 403 && remaining === "0");
}

async function cachedPublicGitHubRepoIsFresh(
  env: Env,
  owner: string,
  repo: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1
     FROM github_public_repos
     WHERE lower(owner) = ?1
       AND lower(repo) = ?2
       AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
  )
    .bind(owner, repo)
    .first<{ "1": number }>();
  return row !== null;
}

async function cachedPublicGitHubRepoCovers(
  env: Env,
  route: RouteInfo,
  cacheCreatedAt: string,
  requireFresh = false,
): Promise<boolean> {
  if (route.owner === undefined || route.repo === undefined) {
    return true;
  }
  const freshness = requireFresh ? "AND expires_at > CURRENT_TIMESTAMP" : "";
  const row = await env.DB.prepare(
    `SELECT 1
     FROM github_public_repos
     WHERE lower(owner) = ?1
       AND lower(repo) = ?2
       AND checked_at >= datetime(?3, '-5 seconds')
       ${freshness}
     LIMIT 1`,
  )
    .bind(route.owner.toLowerCase(), route.repo.toLowerCase(), cacheCreatedAt)
    .first<{ "1": number }>();
  return row !== null;
}
