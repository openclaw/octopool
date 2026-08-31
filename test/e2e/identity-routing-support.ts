import { env } from "cloudflare:workers";
import { clearConfigCache } from "../../src/config-cache";
import worker from "../../src/index";
import type { RelayRequest } from "../../src/types";
import { CALLER_TOKEN, POOL, runWithContext } from "./harness";

export const PATH = "/repos/openclaw/octopool";
export const conditional = { headers: { "if-none-match": '"identity-routing"' } };

export function requestWithEnv(
  overrides: Record<string, unknown> = {},
  path = PATH,
  options: Pick<RelayRequest, "headers" | "query"> = conditional,
): Promise<Response> {
  clearConfigCache();
  return requestWithWarmEnv(overrides, path, options);
}

export function requestWithWarmEnv(
  overrides: Record<string, unknown> = {},
  path = PATH,
  options: Pick<RelayRequest, "headers" | "query"> = conditional,
): Promise<Response> {
  return runWithContext((ctx) =>
    worker.fetch(
      new Request("https://octopool.dev/v1/github/request", {
        method: "POST",
        headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ pool: POOL, method: "GET", path, ...options }),
      }),
      { ...env, ...overrides } as Env,
      ctx,
    ),
  );
}

export async function appIdentity(installation: number | null = 91001): Promise<void> {
  await env.DB.prepare(
    "UPDATE identities SET kind = 'github_app', secret_ref = 'TEST_APP_KEY', installation_id = ? WHERE id = 'primary'",
  )
    .bind(installation)
    .run();
}
