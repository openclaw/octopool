import {
  ensureFreshOrgMembership,
  envSecret,
  githubUserFromToken,
  hashToken,
  newToken,
  verifyGitHubOrgMember,
} from "./auth";
import { ensureWebCaller } from "./callers";
import { defaultLoginPool } from "./config";
import { base64ToBytesSafe, bytesToBase64URL } from "./encoding";
import { queries } from "./generated/sql";
import { effectiveOrigin } from "./hosts";
import { HttpError, jsonResponse } from "./http";
import { sqliteTimestamp } from "./sqlite-time";
import type { WebSession } from "./types";

const SESSION_COOKIE = "octopool_session";
const STATE_COOKIE = "octopool_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const STATE_TTL_SECONDS = 60 * 10;
const MAX_NEXT_PATH_LENGTH = 256;

export async function startGitHubWebLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const clientId = envSecret(env, "GITHUB_OAUTH_CLIENT_ID")?.trim();
  if (clientId === undefined || clientId === "") {
    return Response.redirect("https://github.com/login", 302);
  }
  const next = safeNextPath(url.searchParams.get("next"));
  const state = await signedOAuthState(env, next);

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set(
    "redirect_uri",
    `${githubOAuthCallbackOrigin(request, env)}/login/github/callback`,
  );
  authorize.searchParams.set("scope", "read:org");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  return redirectWithCookies(authorize.toString(), [
    cookie(STATE_COOKIE, state, {
      maxAge: STATE_TTL_SECONDS,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/login/github",
    }),
  ]);
}

export async function finishGitHubWebLogin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error !== null) {
    throw new HttpError(401, "github_login_denied", "GitHub login was denied");
  }
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const stateCookie = readCookie(request, STATE_COOKIE);
  if (code === undefined || code === "" || state === undefined || state === "") {
    throw new HttpError(400, "github_callback_invalid", "GitHub callback is incomplete");
  }
  if (stateCookie === undefined || stateCookie !== state) {
    throw new HttpError(401, "github_state_invalid", "GitHub login state is invalid");
  }

  const nextPath = await verifyOAuthState(env, state);

  const githubToken = await exchangeGitHubCode(request, env, code);
  const user = await githubUserFromToken(env, githubToken);
  const verifiedAt = await verifyGitHubOrgMember(env, user.login);
  const pool = defaultLoginPool(env);
  const caller = await ensureWebCaller(env, pool, user, verifiedAt);

  const session = newToken("sess");
  const expires = sqliteTimestamp(Date.now() + SESSION_TTL_SECONDS * 1000);
  await env.DB.prepare(queries.insertWebSession)
    .bind(await hashToken(session), caller.id, expires)
    .run();

  return redirectWithCookies(nextPath, [
    expiredCookie(STATE_COOKIE, "/login/github"),
    cookie(SESSION_COOKIE, session, {
      maxAge: SESSION_TTL_SECONDS,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    }),
  ]);
}

export async function logoutWebSession(request: Request, env: Env): Promise<Response> {
  const session = readCookie(request, SESSION_COOKIE);
  if (session !== undefined) {
    await env.DB.prepare(queries.deleteWebSession)
      .bind(await hashToken(session))
      .run();
  }
  return redirectWithCookies("/", [expiredCookie(SESSION_COOKIE, "/")]);
}

async function authenticateWebSession(
  request: Request,
  env: Env,
  pool: string,
): Promise<WebSession> {
  const session = readCookie(request, SESSION_COOKIE);
  if (session === undefined || session === "") {
    throw new HttpError(401, "missing_web_session", "Missing web session");
  }
  const row = await env.DB.prepare(queries.getWebSession)
    .bind(await hashToken(session), env.ALLOWED_GITHUB_ORG)
    .first<WebSession>();
  if (row === null) {
    throw new HttpError(401, "invalid_web_session", "Invalid web session");
  }
  await ensureFreshOrgMembership(env, row);
  const grant = await env.DB.prepare(queries.getCallerPoolGrant).bind(row.id, pool).first();
  if (grant === null) {
    throw new HttpError(403, "pool_denied", "Web session is not granted for this pool");
  }
  await env.DB.prepare(queries.touchWebSession)
    .bind(await hashToken(session))
    .run();
  return row;
}

export async function requireDashboardAdmin(
  request: Request,
  env: Env,
  pool: string,
): Promise<WebSession> {
  const session = await authenticateWebSession(request, env, pool);
  if (session.dashboard_role !== "admin") {
    throw new HttpError(403, "dashboard_denied", "Dashboard access requires admin role");
  }
  return session;
}

export function webLoginRedirect(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return Response.redirect(
    `${effectiveOrigin(request, env)}/login/github?next=${encodeURIComponent(next)}`,
    302,
  );
}

export function webMeResponse(session: WebSession): Response {
  return jsonResponse({
    caller: {
      id: session.id,
      name: session.name,
      github_login: session.github_login,
      org_login: session.org_login,
      dashboard_role: session.dashboard_role,
    },
    expires_at: session.expires_at,
  });
}

async function exchangeGitHubCode(request: Request, env: Env, code: string): Promise<string> {
  const clientId = envSecret(env, "GITHUB_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = envSecret(env, "GITHUB_OAUTH_CLIENT_SECRET")?.trim();
  if (
    clientId === undefined ||
    clientId === "" ||
    clientSecret === undefined ||
    clientSecret === ""
  ) {
    throw new HttpError(503, "github_oauth_unconfigured", "GitHub OAuth is not configured");
  }
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "octopool",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${githubOAuthCallbackOrigin(request, env)}/login/github/callback`,
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(502, "github_oauth_failed", "GitHub OAuth token exchange failed");
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new HttpError(502, "github_oauth_failed", "GitHub OAuth token response was incomplete");
  }
  return accessToken;
}

function safeNextPath(value: string | null): string {
  if (value === null || value.trim() === "") {
    return "/dashboard";
  }
  if (value.length > MAX_NEXT_PATH_LENGTH) {
    return "/dashboard";
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return "/dashboard";
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function githubOAuthCallbackOrigin(request: Request, env: Env): string {
  const configured = envSecret(env, "GITHUB_OAUTH_CALLBACK_ORIGIN")?.trim();
  if (configured === undefined || configured === "") {
    return effectiveOrigin(request, env);
  }
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new HttpError(
      503,
      "github_oauth_unconfigured",
      "GitHub OAuth callback origin is invalid",
    );
  }
  return url.origin;
}

async function signedOAuthState(env: Env, nextPath: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = newToken("nonce");
  const payload = base64UrlJSON({ iat: issuedAt, next: nextPath, nonce });
  const signature = await oauthStateSignature(env, payload);
  return `state.${payload}.${signature}`;
}

async function verifyOAuthState(env: Env, state: string): Promise<string> {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== "state") {
    throw new HttpError(401, "github_state_invalid", "GitHub login state is invalid");
  }
  const payload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const expected = await oauthStateSignature(env, payload);
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(401, "github_state_invalid", "GitHub login state is invalid");
  }
  let body: unknown;
  try {
    const bytes = base64ToBytesSafe(payload);
    if (bytes === undefined) {
      throw new Error("invalid base64url");
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(401, "github_state_invalid", "GitHub login state is invalid");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(401, "github_state_invalid", "GitHub login state is invalid");
  }
  const issuedAt = (body as { iat?: unknown }).iat;
  if (typeof issuedAt !== "number" || Date.now() / 1000 - issuedAt > STATE_TTL_SECONDS) {
    throw new HttpError(401, "github_state_expired", "GitHub login state expired");
  }
  const next = (body as { next?: unknown }).next;
  return safeNextPath(typeof next === "string" ? next : null);
}

async function oauthStateSignature(env: Env, payload: string): Promise<string> {
  const secret = envSecret(env, "GITHUB_OAUTH_CLIENT_SECRET")?.trim();
  if (secret === undefined || secret === "") {
    throw new HttpError(503, "github_oauth_unconfigured", "GitHub OAuth is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64URL(new Uint8Array(signature));
}

function base64UrlJSON(value: unknown): string {
  return bytesToBase64URL(new TextEncoder().encode(JSON.stringify(value)));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return diff === 0;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function redirectWithCookies(location: string, cookies: string[]): Response {
  return new Response(null, {
    status: 302,
    headers: [
      ["location", location],
      ...cookies.map((value): [string, string] => ["set-cookie", value]),
    ],
  });
}

function cookie(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: "Lax"; path: string },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    "SameSite=Lax",
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function expiredCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; SameSite=Lax; HttpOnly; Secure`;
}
