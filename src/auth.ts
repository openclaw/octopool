import { bytesToBase64URL } from "./encoding";
import { cachedConfigLookup, invalidateConfigValue } from "./config-cache";
import { normalizeClientName } from "./client-name";
import { requestTimeoutMs, responseCapBytes } from "./github-limits";
import { HttpError, requestBearer } from "./http";
import { queries } from "./generated/sql";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { readBodyCapped } from "./response-body";
import { isRecord } from "./object";
import { hasSecondaryRateLimitMessage } from "./github-response";
import type { Caller } from "./types";

type CallerRow = {
  id: string;
  name: string;
  github_login: string;
  github_user_id: number | null;
  org_login: string;
  org_verified_at: string | null;
  caller_token_id: string;
  client_name: string;
};

type CallerAuthentication = { caller: Caller; membershipKey: string };

export async function authenticateCaller(
  request: Request,
  env: Env,
  pool: string,
  beforeMembership?: () => Promise<GitHubEgressEnv["githubEgress"]>,
): Promise<Caller> {
  const token = requestBearer(request);
  const tokenHash = await hashToken(token);
  const key = `caller:${tokenHash}:${pool}`;
  const authentication = await cachedConfigLookup<CallerAuthentication>(key, async () => {
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
    return {
      caller: { ...row, client_name: normalizeClientName(row.client_name) },
      membershipKey: crypto.randomUUID(),
    };
  });
  // Local authentication precedes policy access, but every request must check
  // its own protection before joining a refresh or accepting a cached success.
  const egress = await beforeMembership?.();
  const scope = egress === undefined ? "unprotected" : await egress.sharingScope();
  try {
    // A new row generation cannot reuse an older authorization. Distinct
    // transport policies must never share a request-specific egress denial.
    await cachedConfigLookup(`membership:${authentication.membershipKey}:${scope}`, () =>
      ensureFreshOrgMembership(env, authentication.caller, egress),
    );
    return authentication.caller;
  } catch (error) {
    // A policy denial leaves the shared local row and other scopes intact.
    // Authentication failures must reread D1 on the next attempt.
    rethrowStringRewriteDenial(error);
    invalidateConfigValue(key, authentication);
    throw error;
  }
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
  if (typeof login !== "string" || login.trim() === "" || !isGitHubUserId(id)) {
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
  if (typeof resolvedLogin !== "string" || resolvedLogin.trim() === "" || !isGitHubUserId(id)) {
    throw new HttpError(502, "github_user_lookup_failed", "GitHub user response was incomplete");
  }
  return { id, login: resolvedLogin };
}

export async function verifyGitHubOrgMember(
  env: Env,
  login: string,
  expectedUserId: number,
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
  return verifyGitHubOrgMemberWithToken(env, token, login, expectedUserId, egress);
}

export async function verifyGitHubOrgMemberWithToken(
  env: Env,
  token: string,
  login: string,
  expectedUserId: number,
  egress?: GitHubEgressEnv["githubEgress"],
): Promise<string> {
  requireGitHubUserId(expectedUserId);
  const org = env.ALLOWED_GITHUB_ORG;
  let after: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    let response: Response;
    try {
      response = await (egress?.fetch ?? fetch)("https://api.github.com/graphql", {
        method: "POST",
        redirect: "manual",
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
    } catch (error) {
      rethrowStringRewriteDenial(error);
      throw new HttpError(502, "org_verification_failed", "GitHub membership request failed");
    }
    const graphQLQuotaExhausted =
      response.headers.get("x-ratelimit-resource") === "graphql" &&
      response.headers.get("x-ratelimit-remaining") === "0";
    if (!response.ok) {
      if (
        response.status === 403 &&
        graphQLQuotaExhausted &&
        !response.headers.has("retry-after")
      ) {
        const body = await readOrgMembershipResponse(response, responseCapBytes(env));
        if (
          !hasSecondaryRateLimitMessage(body) &&
          (hasPrimaryGraphQLRateLimitErrors(body) ||
            (body.errors === undefined &&
              typeof body.message === "string" &&
              /^API rate limit (?:already )?exceeded\b/i.test(body.message)))
        ) {
          return verifyRESTOrgMembership(env, token, login, expectedUserId, egress);
        }
      }
      throw new HttpError(
        502,
        "org_verification_failed",
        `GitHub membership check failed with ${response.status}`,
        githubRateLimitDetails(response.headers),
      );
    }

    const body = await readOrgMembershipResponse(response, responseCapBytes(env));
    if (
      graphQLQuotaExhausted &&
      hasPrimaryGraphQLRateLimitErrors(body) &&
      !hasSecondaryRateLimitMessage(body) &&
      !response.headers.has("retry-after")
    ) {
      return verifyRESTOrgMembership(env, token, login, expectedUserId, egress);
    }
    const page = parseOrgMembershipPage(body, response.headers);
    if (page === null || page.userId !== expectedUserId) {
      throw new HttpError(
        403,
        "github_identity_mismatch",
        "GitHub account no longer matches this login; sign in again or ask an admin to reprovision",
      );
    }
    if (page.hasNextPage && (page.endCursor === null || seenCursors.has(page.endCursor))) {
      throw new HttpError(502, "org_verification_failed", "GitHub membership page was invalid");
    }
    if (page.organizations.some((candidate) => candidate.toLowerCase() === org.toLowerCase())) {
      return new Date().toISOString();
    }
    if (!page.hasNextPage) {
      throw new HttpError(403, "org_member_denied", `${login} is not a ${org} org member`);
    }
    after = page.endCursor;
    seenCursors.add(after!);
  }
}

function hasPrimaryGraphQLRateLimitErrors(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.errors) &&
    body.errors.length > 0 &&
    body.errors.every(
      (error: unknown) =>
        isRecord(error) &&
        (error.type === "RATE_LIMIT" || error.type === "RATE_LIMITED") &&
        !hasSecondaryRateLimitMessage(error),
    )
  );
}

async function verifyRESTOrgMembership(
  env: Env,
  token: string,
  login: string,
  expectedUserId: number,
  egress?: GitHubEgressEnv["githubEgress"],
): Promise<string> {
  const org = env.ALLOWED_GITHUB_ORG;
  let response: Response;
  try {
    response = await (egress?.fetch ?? fetch)(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`,
      {
        redirect: "manual",
        headers: githubHeaders(token),
        signal: githubRequestSignal(env),
      },
    );
  } catch (error) {
    rethrowStringRewriteDenial(error);
    throw new HttpError(502, "org_verification_failed", "GitHub membership request failed");
  }
  // A 404 can also conceal missing token permissions; only an explicit
  // identity-bound membership response can establish a membership decision.
  if (!response.ok) {
    throw new HttpError(
      502,
      "org_verification_failed",
      `GitHub membership check failed with ${response.status}`,
      githubRateLimitDetails(response.headers),
    );
  }
  const body = await readOrgMembershipResponse(response, responseCapBytes(env));
  if (
    !isRecord(body.user) ||
    !isGitHubUserId(body.user.id) ||
    !isRecord(body.organization) ||
    typeof body.organization.login !== "string" ||
    body.organization.login.toLowerCase() !== org.toLowerCase() ||
    (body.state !== "active" && body.state !== "pending")
  ) {
    throw new HttpError(502, "org_verification_failed", "GitHub membership response was invalid");
  }
  if (body.user.id !== expectedUserId) {
    throw new HttpError(
      403,
      "github_identity_mismatch",
      "GitHub account no longer matches this login; sign in again or ask an admin to reprovision",
    );
  }
  if (body.state !== "active") {
    throw new HttpError(403, "org_member_denied", `${login} is not a ${org} org member`);
  }
  return new Date().toISOString();
}

const ORG_MEMBERSHIP_QUERY = `
  query OctopoolOrgMembership($login: String!, $after: String) {
    user(login: $login) {
      databaseId
      organizations(first: 100, after: $after) {
        nodes { login }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

async function readOrgMembershipResponse(
  response: Response,
  capBytes: number,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder().decode(
        await readBodyCapped(
          response,
          capBytes,
          () =>
            new HttpError(
              502,
              "org_verification_failed",
              "GitHub membership response was too large",
            ),
        ),
      ),
    );
  } catch {
    throw new HttpError(502, "org_verification_failed", "GitHub membership response was invalid");
  }
  if (!isRecord(body)) {
    throw new HttpError(502, "org_verification_failed", "GitHub membership response was invalid");
  }
  return body;
}

function parseOrgMembershipPage(
  body: Record<string, unknown>,
  headers: Headers,
): {
  userId: number;
  organizations: string[];
  endCursor: string | null;
  hasNextPage: boolean;
} | null {
  const payload = body as {
    data?: {
      user?: {
        databaseId?: unknown;
        organizations?: {
          nodes?: unknown;
          pageInfo?: { endCursor?: unknown; hasNextPage?: unknown };
        };
      } | null;
    };
    errors?: unknown;
  };
  if (
    payload.errors !== undefined &&
    (!Array.isArray(payload.errors) || payload.errors.length > 0)
  ) {
    throw new HttpError(
      502,
      "org_verification_failed",
      "GitHub membership query failed",
      githubRateLimitDetails(headers),
    );
  }
  if (payload.data?.user === null) {
    return null;
  }
  const userId = payload.data?.user?.databaseId;
  const connection = payload.data?.user?.organizations;
  const nodes = connection?.nodes;
  const pageInfo = connection?.pageInfo;
  if (
    !isGitHubUserId(userId) ||
    !Array.isArray(nodes) ||
    typeof pageInfo?.hasNextPage !== "boolean" ||
    !(typeof pageInfo.endCursor === "string" || pageInfo.endCursor === null) ||
    (typeof pageInfo.endCursor === "string" && pageInfo.endCursor.trim() === "")
  ) {
    throw new HttpError(502, "org_verification_failed", "GitHub membership response was invalid");
  }
  const organizations = nodes.map((node) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new HttpError(502, "org_verification_failed", "GitHub membership node was invalid");
    }
    const candidate = (node as { login?: unknown }).login;
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new HttpError(502, "org_verification_failed", "GitHub membership node was invalid");
    }
    return candidate;
  });
  return {
    userId,
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
  // A timestamp alone must never authorize credentials with no enrolled account.
  requireGitHubUserId(caller.github_user_id);
  const ttlSeconds = Number.parseInt(env.ORG_VERIFY_TTL_SECONDS, 10);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 86_400_000;
  const verifiedAt = caller.org_verified_at === null ? 0 : Date.parse(caller.org_verified_at);
  if (Number.isFinite(verifiedAt) && Date.now() - verifiedAt < ttlMs) {
    return;
  }
  const now = await verifyGitHubOrgMember(env, caller.github_login, caller.github_user_id, egress);
  await env.DB.prepare(queries.updateCallerOrgIdentityVerifiedAt).bind(now, caller.id).run();
}

function isGitHubUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireGitHubUserId(value: unknown): asserts value is number {
  if (!isGitHubUserId(value)) {
    throw new HttpError(
      403,
      "github_identity_required",
      "GitHub account identity is missing; sign in again or ask an admin to reprovision",
    );
  }
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
