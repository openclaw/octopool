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
};

export async function ensureCliCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  verifiedAt: string,
  token: string,
): Promise<LoginCaller> {
  return ensureCaller(env, pool, user, verifiedAt, token);
}

export async function ensureWebCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  verifiedAt: string,
): Promise<LoginCaller> {
  return ensureCaller(env, pool, user, verifiedAt);
}

async function ensureCaller(
  env: Env,
  pool: string,
  user: GitHubLoginUser,
  verifiedAt: string,
  loginToken?: string,
): Promise<LoginCaller> {
  await ensurePool(env, pool);
  const name = user.name ?? user.login;
  const existing = await findLoginCaller(env, pool, user.id);
  if (existing === null) {
    return insertCaller(env, pool, user, name, verifiedAt, loginToken);
  }

  const statements = [
    loginToken === undefined
      ? env.DB.prepare(queries.updateCallerWebLogin).bind(
          name,
          user.login,
          user.id,
          verifiedAt,
          existing.id,
        )
      : env.DB.prepare(queries.updateCallerLogin).bind(
          name,
          await hashToken(loginToken),
          user.login,
          user.id,
          verifiedAt,
          existing.id,
        ),
    env.DB.prepare(queries.insertCallerPool).bind(existing.id, pool),
  ];
  await env.DB.batch(statements);
  return loginCaller(existing.id, name, user.login, env.ALLOWED_GITHUB_ORG, pool);
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
  verifiedAt: string,
  loginToken?: string,
): Promise<LoginCaller> {
  const callerId = `caller_${crypto.randomUUID()}`;
  const tokenHash = await hashToken(loginToken ?? newToken("op"));
  await env.DB.batch([
    env.DB.prepare(queries.insertCaller).bind(
      callerId,
      name,
      tokenHash,
      user.login,
      user.id,
      env.ALLOWED_GITHUB_ORG,
      verifiedAt,
    ),
    env.DB.prepare(queries.insertCallerPool).bind(callerId, pool),
  ]);
  return loginCaller(callerId, name, user.login, env.ALLOWED_GITHUB_ORG, pool);
}

function loginCaller(
  id: string,
  name: string,
  githubLogin: string,
  orgLogin: string,
  pool: string,
): LoginCaller {
  return {
    id,
    name,
    github_login: githubLogin,
    org_login: orgLogin,
    pool,
  };
}
