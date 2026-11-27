import { parsePositiveInt } from "./http";

export function responseCapBytes(env: Pick<Env, "MAX_RESPONSE_BYTES">): number {
  return parsePositiveInt(env.MAX_RESPONSE_BYTES, 2_097_152);
}

export function requestTimeoutMs(env: Pick<Env, "REQUEST_TIMEOUT_MS">): number {
  return parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000);
}
