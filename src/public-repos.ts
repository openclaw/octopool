import { envSecret } from "./auth";
import { queries } from "./generated/sql";
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
  await env.DB.prepare(queries.upsertPublicRepoProof)
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
  const row = await env.DB.prepare(queries.freshPublicRepoProof)
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
  const query = requireFresh
    ? queries.freshCoveringPublicRepoProof
    : queries.coveringPublicRepoProof;
  const row = await env.DB.prepare(query)
    .bind(route.owner.toLowerCase(), route.repo.toLowerCase(), cacheCreatedAt)
    .first<{ "1": number }>();
  return row !== null;
}
