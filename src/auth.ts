import { bytesToBase64URL } from "./encoding";
import { cachedConfigLookup } from "./config-cache";
import { normalizeClientName } from "./client-name";
import { requestTimeoutMs } from "./github-limits";
import { HttpError, requestBearer } from "./http";
import { queries } from "./generated/sql";
import type { GitHubEgressEnv } from "./github-egress";
import type { Caller } from "./types";

type CallerRow = {
  id: string;
  name: string;
  github_login: string;
  org_login: string;
  org_verified_at: string | null;
  caller_token_id: string;
  client_name: string;
};

export async function authenticateCaller(
  request: Request,
  env: Env,
  pool: string,
  beforeMembership?: () => Promise<GitHubEgressEnv["githubEgress"]>,
): Promise<Caller> {
  const token = requestBearer(request);
  const tokenHash = await hashToken(token);
  // Cached after org checks so a stale org_verified_at cannot re-trigger the
  // GitHub membership probe on every request of a burst. Failures are never
  // cached; an invalid token re-checks D1 each time.
  return cachedConfigLookup(`caller:${tokenHash}:${pool}`, async () => {
    const row = await env.DB.prepare(queries.authenticateCaller)
      .bind(tokenHash, pool)
      .first<CallerRow>();
    if (row === null) {
      throw new HttpError(401, "invalid_auth", "Invalid caller token");
    }
    const allowedOrg = env.ALLOWED_GITHUB_ORG.toLowerCase();
    if (row.org_login.toLowerCase() !== allowedOrg) {
      throw new HttpError(403, "org_denied", `Caller is not a ${allowedOrg} org user`);
    }
    // Authenticate locally before loading/inspecting protected policy, but obtain
    // the request transport before any membership refresh can leave the Worker.
    await ensureFreshOrgMembership(env, row, await beforeMembership?.());
    return { ...row, client_name: normalizeClientName(row.client_name) };
  });
}

export async function authenticateAdmin(request: Request, env: Env): Promise<void> {
  const configured = envSecret(env, "OCTOPOOL_ADMIN_TOKEN");
  if (configured === undefined || configured.trim() === "") {
    throw new HttpError(503, "admin_unconfigured", "Admin token is not configured");
  }
  const token = requestBearer(request);
  const ok = await constantTimeEqual(token, configured);
  if (!ok) {
    throw new HttpError(401, "invalid_admin_auth", "Invalid admin token");
  }
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64URL(new Uint8Array(digest));
}

export function newToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${bytesToBase64URL(bytes)}`;
}

export async function githubUserFromToken(
  env: Env,
  token: string,
): Promise<{
  id: number;
  login: string;
  name?: string;
}> {
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
    signal: githubRequestSignal(env),
  });
  if (!response.ok) {
    throw new HttpError(
      401,
      "github_auth_failed",
      `GitHub token check failed with ${response.status}`,
      githubRateLimitDetails(response.headers),
    );
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(502, "github_auth_failed", "GitHub user response was invalid");
  }
  const login = (body as { login?: unknown }).login;
  const id = (body as { id?: unknown }).id;
  const name = (body as { name?: unknown }).name;
  if (typeof login !== "string" || typeof id !== "number") {
    throw new HttpError(502, "github_auth_failed", "GitHub user response was incomplete");
  }
  return {
    id,
    login,
    ...(typeof name === "string" && name.trim() !== "" ? { name } : {}),
  };
}

function githubRateLimitDetails(headers: Headers): Record<string, string> | undefined {
  const details: Record<string, string> = {};
  for (const [detailKey, headerKey] of [
    ["github_rate_limit_limit", "x-ratelimit-limit"],
    ["github_rate_limit_remaining", "x-ratelimit-remaining"],
    ["github_rate_limit_reset", "x-ratelimit-reset"],
    ["github_rate_limit_resource", "x-ratelimit-resource"],
    ["github_rate_limit_used", "x-ratelimit-used"],
    ["github_retry_after", "retry-after"],
  ] as const) {
    const value = headers.get(headerKey);
    if (value !== null && value.trim() !== "") {
      details[detailKey] = value;
    }
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

export async function githubUserByLogin(
  env: Env,
  login: string,
): Promise<{
  id: number;
  login: string;
}> {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: githubHeaders(),
    signal: githubRequestSignal(env),
  });
  if (!response.ok) {
    throw new HttpError(
      502,
      "github_user_lookup_failed",
      `GitHub user lookup failed with ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(502, "github_user_lookup_failed", "GitHub user response was invalid");
  }
  const resolvedLogin = (body as { login?: unknown }).login;
  const id = (body as { id?: unknown }).id;
  if (typeof resolvedLogin !== "string" || typeof id !== "number") {
    throw new HttpError(502, "github_user_lookup_failed", "GitHub user response was incomplete");
  }
  return { id, login: resolvedLogin };
}

export async function verifyGitHubOrgMember(
  env: Env,
  login: string,
  egress?: GitHubEgressEnv["githubEgress"],
): Promise<string> {
  const token = envSecret(env, "OCTOPOOL_GITHUB_ORG_TOKEN");
  if (token === undefined || token.trim() === "") {
    throw new HttpError(
      503,
      "org_verification_unavailable",
      "GitHub org verifier token is not configured",
    );
  }
  return verifyGitHubOrgMemberWithToken(env, token, login, egress);
}

export async function verifyGitHubOrgMemberWithToken(
  env: Env,
  token: string,
  login: string,
  egress?: GitHubEgressEnv["githubEgress"],
): Promise<string> {
  const org = env.ALLOWED_GITHUB_ORG;
  let after: string | null = null;

  while (true) {
    const response = await (egress?.fetch ?? fetch)("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: ORG_MEMBERSHIP_QUERY,
        variables: { login, after },
      }),
      signal: githubRequestSignal(env),
    });
    if (!response.ok) {
      throw new HttpError(
        502,
        "org_verification_failed",
        `GitHub membership check failed with ${response.status}`,
        githubRateLimitDetails(response.headers),
      );
    }

    const page = await parseOrgMembershipPage(response);
    if (page.organizations.some((candidate) => candidate.toLowerCase() === org.toLowerCase())) {
      return new Date().toISOString();
    }
    if (!page.hasNextPage) {
      throw new HttpError(403, "org_member_denied", `${login} is not a ${org} org member`);
    }
    if (page.endCursor === null || page.endCursor === after) {
      throw new HttpError(502, "org_verification_failed", "GitHub membership page was invalid");
    }
    after = page.endCursor;
  }
}

const ORG_MEMBERSHIP_QUERY = `
  query OctopoolOrgMembership($login: String!, $after: String) {
    user(login: $login) {
      organizations(first: 100, after: $after) {
        nodes { login }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

async function parseOrgMembershipPage(response: Response): Promise<{
  organizations: string[];
  endCursor: string | null;
  hasNextPage: boolean;
}> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(502, "org_verification_failed", "GitHub membership response was invalid");
  }
  const payload = body as {
    data?: {
      user?: {
        organizations?: {
          nodes?: unknown;
          pageInfo?: { endCursor?: unknown; hasNextPage?: unknown };
        };
      } | null;
    };
    errors?: unknown;
  };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new HttpError(502, "org_verification_failed", "GitHub membership query failed");
  }
  if (payload.data?.user === null) {
    return { organizations: [], endCursor: null, hasNextPage: false };
  }
  const connection = payload.data?.user?.organizations;
  const nodes = connection?.nodes;
  const pageInfo = connection?.pageInfo;
  if (
    !Array.isArray(nodes) ||
    typeof pageInfo?.hasNextPage !== "boolean" ||
    !(typeof pageInfo.endCursor === "string" || pageInfo.endCursor === null)
  ) {
    throw new HttpError(502, "org_verification_failed", "GitHub membership response was invalid");
  }
  const organizations = nodes.flatMap((node) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return [];
    }
    const candidate = (node as { login?: unknown }).login;
    return typeof candidate === "string" ? [candidate] : [];
  });
  return {
    organizations,
    endCursor: pageInfo.endCursor,
    hasNextPage: pageInfo.hasNextPage,
  };
}

export async function ensureFreshOrgMembership(
  env: Env,
  caller: CallerRow,
  egress?: GitHubEgressEnv["githubEgress"],
): Promise<void> {
  const ttlSeconds = Number.parseInt(env.ORG_VERIFY_TTL_SECONDS, 10);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 86_400_000;
  const verifiedAt = caller.org_verified_at === null ? 0 : Date.parse(caller.org_verified_at);
  if (Number.isFinite(verifiedAt) && Date.now() - verifiedAt < ttlMs) {
    return;
  }
  const now = await verifyGitHubOrgMember(env, caller.github_login, egress);
  await env.DB.prepare(queries.updateCallerOrgVerifiedAt).bind(now, caller.id).run();
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left));
  const rightHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right));
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export function envSecret(env: Env, name: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[name];
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    "user-agent": "octopool",
    "x-github-api-version": "2022-11-28",
  };
}

function githubRequestSignal(env: Env): AbortSignal {
  return AbortSignal.timeout(requestTimeoutMs(env));
}
