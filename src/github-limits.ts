import { parsePositiveInt } from "./http";

export function responseCapBytes(env: { MAX_RESPONSE_BYTES?: string }): number {
  return parsePositiveInt(env.MAX_RESPONSE_BYTES, 2_097_152);
}

export function requestTimeoutMs(env: { REQUEST_TIMEOUT_MS?: string }): number {
  return parsePositiveInt(env.REQUEST_TIMEOUT_MS, 15_000);
}
