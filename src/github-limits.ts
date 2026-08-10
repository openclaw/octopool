import { parsePositiveInt } from "./http";

export function responseCapBytes(env: Env): number {
  return parsePositiveInt(env.MAX_RESPONSE_BYTES, 2_097_152);
}
