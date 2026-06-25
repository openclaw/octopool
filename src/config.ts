import { HttpError } from "./http";

export function defaultLoginPool(env: Env): string {
  const configured = (env as unknown as Record<string, string | undefined>).DEFAULT_LOGIN_POOL;
  return configured === undefined || configured.trim() === "" ? "maintainers" : configured.trim();
}

export function requestedLoginPool(env: Env, requested: unknown): string {
  const allowed = defaultLoginPool(env);
  if (requested === undefined || requested === null || requested === "") {
    return allowed;
  }
  if (typeof requested !== "string" || requested.trim() !== allowed) {
    throw new HttpError(403, "pool_denied", "CLI login cannot self-grant this pool");
  }
  return allowed;
}
