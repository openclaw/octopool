import { base64ToBytes, bytesToBase64URL } from "./encoding";
import type { GitHubEgressEnv } from "./github-egress";
import { requestTimeoutMs } from "./github-limits";
import { HttpError } from "./http";
import type { Identity } from "./types";

const installationTokenCache = new Map<string, { token: string; expiresAt: number }>();

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
  if (identity.installation_id === null) {
    throw new HttpError(
      503,
      "github_app_installation_missing",
      "GitHub App installation id is missing",
    );
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
  const value = (env as unknown as Record<string, string | undefined>).OCTOPOOL_GITHUB_APP_ID;
  if (value === undefined || value.trim() === "") {
    throw new HttpError(503, "github_app_id_missing", "GitHub App ID is not configured");
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
    throw new HttpError(
      503,
      "github_app_key_format",
      "GitHub App private key must be stored as PKCS#8 BEGIN PRIVATE KEY",
    );
  }
  const base64 = privateKeyPEM
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (base64 === "") {
    throw new HttpError(503, "github_app_key_format", "GitHub App private key is empty");
  }
  const der = base64ToBytes(base64);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function githubSecret(env: Env, secretRef: string): string {
  const value = (env as unknown as Record<string, string | undefined>)[secretRef];
  if (value === undefined || value.trim() === "") {
    throw new HttpError(
      503,
      "identity_secret_missing",
      `Identity secret ${secretRef} is not configured`,
    );
  }
  return value;
}

function base64URLJSON(value: unknown): string {
  return bytesToBase64URL(new TextEncoder().encode(JSON.stringify(value)));
}
