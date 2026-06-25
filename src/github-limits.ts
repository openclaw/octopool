import { parsePositiveInt } from "./http";
import type { RouteInfo } from "./types";

export function responseCapBytes(env: Env, route: RouteInfo): number {
  const cap = parsePositiveInt(env.MAX_RESPONSE_BYTES, 2_097_152);
  return route.largePayload || route.fullResponseCap ? cap : Math.min(cap, 1_048_576);
}
