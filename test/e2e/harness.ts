import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../../src/index";
import { hashToken } from "../../src/auth";
import type { RelayRequest } from "../../src/types";

export const CALLER_TOKEN = "caller-token";
export const POOL = "maintainers";

export async function relay(
  path: string,
  token = CALLER_TOKEN,
  options: Pick<RelayRequest, "query" | "headers" | "route_hint"> = {},
): Promise<Response> {
  return callWorker("/v1/github/request", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ pool: POOL, method: "GET", path, ...options }),
  });
}

export async function callWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const url = path.startsWith("https://") ? path : `https://octopool.dev${path}`;
  const response = await worker.fetch(new Request(url, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function runScheduled(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled({} as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
}

export async function seedPool(options: { secondary?: boolean } = {}): Promise<void> {
  const policy = JSON.stringify({
    allowed_owners: ["openclaw"],
    allow_public_repos: true,
    allow_search: true,
    allow_logs: true,
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pools (id, name, policy_json) VALUES (?, ?, ?)").bind(
      POOL,
      POOL,
      policy,
    ),
    env.DB.prepare(
      `INSERT INTO callers (
        id, name, token_hash, github_login, org_login, org_verified_at, status, github_user_id,
        dashboard_role
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'active', ?, 'admin')`,
    ).bind("caller", "Caller", await hashToken(CALLER_TOKEN), "caller", "openclaw", 42),
    env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES (?, ?)").bind(
      "caller",
      POOL,
    ),
    env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES (?, ?, ?, ?)",
    ).bind("caller-client-token", "caller", await hashToken(CALLER_TOKEN), "test-mac"),
    identity("primary", "TEST_PAT_PRIMARY", 200),
    scope("primary"),
    ...(options.secondary === true
      ? [identity("secondary", "TEST_PAT_SECONDARY", 100), scope("secondary")]
      : []),
  ]);
}

export async function seedCaller(id: string, token: string, login: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO callers (
        id, name, token_hash, github_login, org_login, org_verified_at, status, github_user_id
      ) VALUES (?, ?, ?, ?, 'openclaw', CURRENT_TIMESTAMP, 'active', ?)`,
    ).bind(id, login, await hashToken(token), login, id === "other" ? 43 : 44),
    env.DB.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES (?, ?)").bind(id, POOL),
    env.DB.prepare(
      "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES (?, ?, ?, ?)",
    ).bind(`${id}-client-token`, id, await hashToken(token), `${login}-mac`),
  ]);
}

export async function seedWebSession(): Promise<string> {
  const session = "test-web-session";
  await env.DB.prepare(
    `INSERT INTO web_sessions (session_hash, caller_id, expires_at)
     VALUES (?, 'caller', datetime('now', '+1 day'))`,
  )
    .bind(await hashToken(session))
    .run();
  return session;
}

export async function seedAudit(
  requestId: string,
  callerId: string,
  routeKind: string,
  cacheStatus: string,
  status: number,
  options: {
    errorCode?: string;
    fallbackReason?: string;
    cacheable?: number;
    callerTokenId?: string;
    clientName?: string;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (
      request_id, caller_id, caller_token_id, client_name, pool_id, route_key, route_kind, identity_id, status,
      error_code, fallback_reason, duration_ms, cache_status, cacheable, coalesced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'primary', ?, ?, ?, 10, ?, ?, 0)`,
  )
    .bind(
      requestId,
      callerId,
      options.callerTokenId ?? `${callerId}-client-token`,
      options.clientName ?? (callerId === "caller" ? "test-mac" : `${callerId}-mac`),
      POOL,
      `${routeKind}:fixture`,
      routeKind,
      status,
      options.errorCode ?? null,
      options.fallbackReason ?? null,
      cacheStatus,
      options.cacheable ?? 1,
    )
    .run();
}

export function githubUpstream(responses: {
  primary: Response;
  secondary?: Response;
}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    switch (bearer(request)) {
      case "test-org-token":
        return jsonResponse({ private: false });
      case "test-primary-token":
        return responses.primary.clone();
      case "test-secondary-token":
        return (responses.secondary ?? responses.primary).clone();
      default:
        return jsonResponse({ message: "public backend unavailable" }, 503);
    }
  });
}

export function bearer(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const request = new Request(input, init);
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined;
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

export function orgMembershipResponse(member: boolean): Response {
  return jsonResponse({
    data: {
      user: {
        organizations: {
          nodes: member ? [{ login: "openclaw" }] : [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  });
}

export function rateHeaders(options: { remaining: number; retryAfter?: number }): HeadersInit {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(options.remaining),
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": "core",
    ...(options.retryAfter === undefined ? {} : { "retry-after": String(options.retryAfter) }),
  };
}

function identity(id: string, secretRef: string, weight: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO identities (id, pool_id, kind, login, secret_ref, status, weight)
     VALUES (?, ?, 'pat', ?, ?, 'active', ?)`,
  ).bind(id, POOL, id, secretRef, weight);
}

function scope(identityId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO identity_scopes (identity_id, owner, repo, permission, allow_private)
     VALUES (?, 'openclaw', NULL, 'read', 0)`,
  ).bind(identityId);
}
