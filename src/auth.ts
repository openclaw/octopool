import { HttpError, requestBearer } from "./http";
import { queries } from "./generated/sql";
import type { Caller } from "./types";

type CallerRow = {
  id: string;
  name: string;
  github_login: string;
  org_login: string;
  org_verified_at: string | null;
};

export async function authenticateCaller(
  request: Request,
  env: Env,
  pool: string,
): Promise<Caller> {
  const token = requestBearer(request);
  const tokenHash = await hashToken(token);
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
  await ensureFreshOrgMembership(env, row);
  return row;
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
  return base64Url(new Uint8Array(digest));
}

export function newToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64Url(bytes)}`;
}

export async function githubUserFromToken(token: string): Promise<{
  id: number;
  login: string;
  name?: string;
}> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "octopool",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new HttpError(
      401,
      "github_auth_failed",
      `GitHub token check failed with ${response.status}`,
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

export async function githubUserByLogin(login: string): Promise<{
  id: number;
  login: string;
}> {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "octopool",
      "x-github-api-version": "2022-11-28",
    },
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

export async function verifyGitHubOrgMember(env: Env, login: string): Promise<string> {
  const token = envSecret(env, "OCTOPOOL_GITHUB_ORG_TOKEN");
  if (token === undefined || token.trim() === "") {
    throw new HttpError(
      503,
      "org_verification_unavailable",
      "GitHub org verifier token is not configured",
    );
  }
  const org = env.ALLOWED_GITHUB_ORG;
  const response = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "octopool",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (response.status === 204) {
    return new Date().toISOString();
  }
  if (response.status === 404) {
    throw new HttpError(
      403,
      "org_member_denied",
      `${login} is not a public or token-visible ${org} member`,
    );
  }
  throw new HttpError(
    502,
    "org_verification_failed",
    `GitHub membership check failed with ${response.status}`,
  );
}

export async function verifyGitHubOrgMemberWithToken(
  env: Env,
  token: string,
  login: string,
): Promise<string> {
  const org = env.ALLOWED_GITHUB_ORG;
  const response = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "octopool",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (response.status === 204) {
    return new Date().toISOString();
  }
  if (response.status === 404) {
    throw new HttpError(403, "org_member_denied", `${login} is not a ${org} org member`);
  }
  throw new HttpError(
    502,
    "org_verification_failed",
    `GitHub membership check failed with ${response.status}`,
  );
}

export async function ensureFreshOrgMembership(env: Env, caller: CallerRow): Promise<void> {
  const ttlSeconds = Number.parseInt(env.ORG_VERIFY_TTL_SECONDS, 10);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 86_400_000;
  const verifiedAt = caller.org_verified_at === null ? 0 : Date.parse(caller.org_verified_at);
  if (Number.isFinite(verifiedAt) && Date.now() - verifiedAt < ttlMs) {
    return;
  }
  const now = await verifyGitHubOrgMember(env, caller.github_login);
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function envSecret(env: Env, name: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[name];
}
