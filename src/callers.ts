import { hashToken, newToken } from "./auth";
import { ensurePool } from "./db";
import { queries } from "./generated/sql";

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
  await ensurePool(env, pool);
  const name = user.name ?? user.login;
  const existing = await findLoginCaller(env, pool, user.id);
  if (existing === null) {
    return insertCaller(env, pool, user, name, identityVerifiedAt, client);
  }

  const statements = [
    env.DB.prepare(queries.updateCallerWebLogin).bind(
      name,
      user.login,
      user.id,
      identityVerifiedAt,
      existing.id,
    ),
    env.DB.prepare(queries.insertCallerPool).bind(existing.id, pool),
    ...(client === undefined
      ? []
      : [
          env.DB.prepare(queries.upsertCallerToken).bind(
            `caller_token_${crypto.randomUUID()}`,
            existing.id,
            await hashToken(client.token),
            client.clientName,
          ),
          env.DB.prepare(queries.pruneCallerTokens).bind(
            existing.id,
            client.clientName,
            existing.id,
            client.clientName,
          ),
        ]),
  ];
  await env.DB.batch(statements);
  return loginCaller(
    existing.id,
    name,
    user.login,
    env.ALLOWED_GITHUB_ORG,
    pool,
    client?.clientName,
  );
}

async function findLoginCaller(
  env: Env,
  pool: string,
  githubUserId: number,
): Promise<{ id: string } | null> {
  const alreadyGranted = await env.DB.prepare(queries.loginExistingCaller)
    .bind(githubUserId, env.ALLOWED_GITHUB_ORG, pool)
    .first<{ id: string }>();
  if (alreadyGranted !== null) {
    return alreadyGranted;
  }
  return env.DB.prepare(queries.findActiveCallerByGitHubUser)
    .bind(githubUserId, env.ALLOWED_GITHUB_ORG)
    .first<{ id: string }>();
}

async function insertCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  name: string,
  identityVerifiedAt: string,
  client?: { token: string; clientName: string },
): Promise<LoginCaller> {
  const callerId = `caller_${crypto.randomUUID()}`;
  const tokenHash = await hashToken(client?.token ?? newToken("op"));
  const statements = [
    env.DB.prepare(queries.insertCaller).bind(
      callerId,
      name,
      tokenHash,
      user.login,
      user.id,
      env.ALLOWED_GITHUB_ORG,
      identityVerifiedAt,
    ),
    env.DB.prepare(queries.insertCallerPool).bind(callerId, pool),
    ...(client === undefined
      ? []
      : [
          env.DB.prepare(queries.upsertCallerToken).bind(
            `caller_token_${crypto.randomUUID()}`,
            callerId,
            tokenHash,
            client.clientName,
          ),
          env.DB.prepare(queries.pruneCallerTokens).bind(
            callerId,
            client.clientName,
            callerId,
            client.clientName,
          ),
        ]),
  ];
  await env.DB.batch(statements);
  return loginCaller(callerId, name, user.login, env.ALLOWED_GITHUB_ORG, pool, client?.clientName);
}

function loginCaller(
  id: string,
  name: string,
  githubLogin: string,
  orgLogin: string,
  pool: string,
  clientName?: string,
): LoginCaller {
  return {
    id,
    name,
    github_login: githubLogin,
    org_login: orgLogin,
    pool,
    ...(clientName === undefined ? {} : { client_name: clientName }),
  };
}
