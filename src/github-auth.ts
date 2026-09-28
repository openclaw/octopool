import { base64ToBytes, bytesToBase64URL } from "./encoding";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { requestTimeoutMs, responseCapBytes } from "./github-limits";
import { HttpError } from "./http";
import { isRecord } from "./object";
import { readBodyCapped } from "./response-body";
import type { Identity } from "./types";

const installationTokenCache = new Map<string, { token: string; expiresAt: number }>();
// Never share entries with installation-wide REST/landing credentials.
const repositoryTokenCache = new Map<string, { token: string; expiresAt: number }>();
const repositoryReadPermissions = [
  "metadata",
  "contents",
  "pull_requests",
  "issues",
  "actions",
  "checks",
  "statuses",
] as const;

export async function githubRepositoryToken(
  env: GitHubEgressEnv,
  identity: Identity,
  owner: string,
  repo: string,
): Promise<string> {
  const unavailable = () =>
    new HttpError(424, "fallback_local", "Repository-scoped GitHub App token is unavailable", {
      reason: "github_app_repo_token_unavailable",
    });
  try {
    if (
      identity.kind !== "github_app" ||
      !Number.isSafeInteger(identity.installation_id) ||
      identity.installation_id! <= 0
    )
      throw unavailable();
    const appId = githubAppID(env);
    const key = JSON.stringify([
      appId,
      identity.installation_id,
      identity.secret_ref,
      owner.toLowerCase(),
      repo.toLowerCase(),
    ]);
    const cached = repositoryTokenCache.get(key);
    if (cached !== undefined && cached.expiresAt - Date.now() > 60_000) return cached.token;
    repositoryTokenCache.delete(key);
    const jwt = await githubAppJWT(appId, githubSecret(env, identity.secret_ref));
    const base = `https://api.github.com/app/installations/${identity.installation_id}`;
    const requestJSON = async (url: string, body?: unknown): Promise<Record<string, unknown>> => {
      const response = await env.githubEgress.fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "octopool",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeoutMs(env)),
      });
      const bytes = await readBodyCapped(response, responseCapBytes(env), unavailable);
      if (!response.ok) throw unavailable();
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(value)) throw unavailable();
      return value;
    };
    const installation = await requestJSON(base);
    if (
      !isRecord(installation.account) ||
      typeof installation.account.login !== "string" ||
      installation.account.login.toLowerCase() !== owner.toLowerCase() ||
      !isRecord(installation.permissions)
    )
      throw unavailable();
    const granted = installation.permissions;
    const permissions = Object.fromEntries(
      repositoryReadPermissions
        .filter((name) => granted[name] === "read" || granted[name] === "write")
        .map((name) => [name, "read"]),
    );
    if (permissions.metadata !== "read") throw unavailable();
    const body = await requestJSON(`${base}/access_tokens`, { repositories: [repo], permissions });
    // GitHub's response must confirm the requested boundary. Never recover by
    // dropping repositories/permissions or by borrowing an installation token.
    if (
      typeof body.token !== "string" ||
      body.token === "" ||
      typeof body.expires_at !== "string" ||
      !isRecord(body.permissions) ||
      !Array.isArray(body.repositories) ||
      body.repositories.length !== 1
    )
      throw unavailable();
    const scoped = body.repositories[0];
    if (
      !isRecord(scoped) ||
      scoped.private !== false ||
      typeof scoped.full_name !== "string" ||
      scoped.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
    )
      throw unavailable();
    const issued = body.permissions;
    if (
      Object.entries(issued).some(
        ([name, level]) => permissions[name] !== "read" || level !== "read",
      ) ||
      Object.keys(permissions).some((name) => issued[name] !== "read")
    )
      throw unavailable();
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt - Date.now() <= 60_000) throw unavailable();
    if (repositoryTokenCache.size >= 256)
      repositoryTokenCache.delete(repositoryTokenCache.keys().next().value!);
    repositoryTokenCache.set(key, { token: body.token, expiresAt });
    return body.token;
  } catch (error) {
    rethrowStringRewriteDenial(error);
    throw unavailable();
  }
}

const credentialFailureMessages = {
  identity_secret_missing: "Identity credential is not configured",
  github_app_installation_missing: "GitHub App installation id is missing or invalid",
  github_app_id_missing: "GitHub App ID is not configured",
  github_app_key_format: "GitHub App private key must be valid PKCS#8",
} as const;

export type CredentialFailureReason = keyof typeof credentialFailureMessages;

export function isCredentialFailureReason(value: unknown): value is CredentialFailureReason {
  return typeof value === "string" && Object.hasOwn(credentialFailureMessages, value);
}

export class IdentityCredentialError extends HttpError {
  constructor(readonly reason: CredentialFailureReason) {
    super(503, reason, credentialFailureMessages[reason]);
  }
}

export async function githubToken(env: GitHubEgressEnv, identity: Identity): Promise<string> {
  switch (identity.kind) {
    case "pat":
      return githubSecret(env, identity.secret_ref);
    case "github_app":
      return githubAppInstallationToken(env, identity);
  }
}

async function githubAppInstallationToken(
  env: GitHubEgressEnv,
  identity: Identity,
): Promise<string> {
  if (!Number.isSafeInteger(identity.installation_id) || identity.installation_id! <= 0) {
    throw new IdentityCredentialError("github_app_installation_missing");
  }
  const appId = githubAppID(env);
  const cacheKey = `${appId}:${identity.installation_id}:${identity.secret_ref}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt - Date.now() > 60_000) {
    return cached.token;
  }
  const jwt = await githubAppJWT(appId, githubSecret(env, identity.secret_ref));
  const response = await env.githubEgress.fetch(
    `https://api.github.com/app/installations/${identity.installation_id}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "octopool",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(requestTimeoutMs(env)),
    },
  );
  if (!response.ok) {
    throw new HttpError(
      502,
      "github_app_token_failed",
      `GitHub App token exchange failed with ${response.status}`,
    );
  }
  const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new HttpError(502, "github_app_token_failed", "GitHub App token response was incomplete");
  }
  const expiresAt = Date.parse(body.expires_at);
  if (!Number.isFinite(expiresAt)) {
    throw new HttpError(502, "github_app_token_failed", "GitHub App token expiry was invalid");
  }
  installationTokenCache.set(cacheKey, { token: body.token, expiresAt });
  return body.token;
}

function githubAppID(env: Env): string {
  const value = (env as unknown as Record<string, unknown>).OCTOPOOL_GITHUB_APP_ID;
  if (typeof value !== "string" || value.trim() === "") {
    throw new IdentityCredentialError("github_app_id_missing");
  }
  return value.trim();
}

async function githubAppJWT(appId: string, privateKeyPEM: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64URLJSON({ alg: "RS256", typ: "JWT" });
  const payload = base64URLJSON({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(privateKeyPEM);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64URL(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPEM: string): Promise<CryptoKey> {
  if (privateKeyPEM.includes("BEGIN RSA PRIVATE KEY")) {
    throw new IdentityCredentialError("github_app_key_format");
  }
  const base64 = privateKeyPEM
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (base64 === "") {
    throw new IdentityCredentialError("github_app_key_format");
  }
  try {
    const der = base64ToBytes(base64);
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "InvalidCharacterError" || error.name === "DataError")
    ) {
      throw new IdentityCredentialError("github_app_key_format");
    }
    throw error;
  }
}

function githubSecret(env: Env, secretRef: string): string {
  const value = (env as unknown as Record<string, unknown>)[secretRef];
  if (typeof value !== "string" || value.trim() === "") {
    throw new IdentityCredentialError("identity_secret_missing");
  }
  return value;
}

function base64URLJSON(value: unknown): string {
  return bytesToBase64URL(new TextEncoder().encode(JSON.stringify(value)));
}
