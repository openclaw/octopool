import { hashToken, newToken } from "./auth";
import { ensurePool } from "./db";
import { queries } from "./generated/sql";
import { HttpError } from "./http";

type GitHubLoginUser = {
  id: number;
  login: string;
  name?: string;
};

type LoginCaller = {
  id: string;
  name: string;
  github_login: string;
  org_login: string;
  pool: string;
  client_name?: string;
};

export async function ensureCliCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  identityVerifiedAt: string,
  token: string,
  clientName: string,
): Promise<LoginCaller> {
  return ensureCaller(env, pool, user, identityVerifiedAt, { token, clientName });
}

export async function ensureWebCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  identityVerifiedAt: string,
): Promise<LoginCaller> {
  return ensureCaller(env, pool, user, identityVerifiedAt);
}

async function ensureCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  identityVerifiedAt: string,
  client?: { token: string; clientName: string },
): Promise<LoginCaller> {
  if (!Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new HttpError(502, "github_user_invalid", "GitHub user response was incomplete");
  }
  await ensurePool(env, pool);
  const tokenHash = await hashToken(client?.token ?? newToken("op"));
  const org = env.ALLOWED_GITHUB_ORG;
  const statements = [
    env.DB.prepare(queries.upsertCallerEnrollment).bind(
      `caller_${crypto.randomUUID()}`,
      user.name ?? user.login,
      tokenHash,
      user.login,
      user.id,
      org,
      identityVerifiedAt,
    ),
    env.DB.prepare(queries.insertCallerPool).bind(user.id, org, pool),
    ...(client === undefined
      ? []
      : [
          env.DB.prepare(queries.upsertCallerToken).bind(
            `caller_token_${crypto.randomUUID()}`,
            user.id,
            org,
            tokenHash,
            client.clientName,
          ),
          env.DB.prepare(queries.pruneCallerTokens).bind(user.id, org, client.clientName),
        ]),
  ];
  // Identity subselects resolve every dependent write inside this transaction.
  // The candidate UUID is never authoritative after an enrollment conflict.
  const [enrollment] = await env.DB.batch<Omit<LoginCaller, "pool" | "client_name">>(statements);
  const caller = enrollment?.results[0];
  if (caller === undefined) {
    throw new Error("Enrollment returned no caller");
  }
  return {
    ...caller,
    pool,
    ...(client === undefined ? {} : { client_name: client.clientName }),
  };
}
