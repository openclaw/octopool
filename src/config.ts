import { HttpError } from "./http";
import { isRecord } from "./object";
import type { PoolPolicy } from "./types";

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

export function envSecret(env: Env, name: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[name];
}

export function defaultPolicy(owners: string): PoolPolicy {
  return {
    allowed_owners: owners
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
    allow_public_repos: true,
    allow_search: false,
    allow_logs: true,
  };
}

export function parsePolicy(raw: string, fallbackOwners: string): PoolPolicy {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw poolPolicyUnavailable();
  }
  if (!isRecord(value)) {
    throw poolPolicyUnavailable();
  }
  // Missing fields (including an explicit {}) retain the stored-policy contract.
  // Present but invalid restrictions must never become new-pool defaults.
  const policy = defaultPolicy(fallbackOwners);
  if (Object.hasOwn(value, "allowed_owners")) {
    if (
      !Array.isArray(value.allowed_owners) ||
      !value.allowed_owners.every((item): item is string => typeof item === "string")
    ) {
      throw poolPolicyUnavailable();
    }
    policy.allowed_owners = value.allowed_owners.map((item) => item.toLowerCase());
  }
  for (const field of ["allow_public_repos", "allow_search", "allow_logs"] as const) {
    if (Object.hasOwn(value, field)) {
      const flag = value[field];
      if (typeof flag !== "boolean") {
        throw poolPolicyUnavailable();
      }
      policy[field] = flag;
    }
  }
  return policy;
}

function poolPolicyUnavailable(): HttpError {
  return new HttpError(503, "pool_policy_unavailable", "Pool policy is unavailable");
}
