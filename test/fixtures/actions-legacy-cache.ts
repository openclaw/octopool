import { hashToken } from "../../src/auth";
import type { RelayRequest, RouteInfo } from "../../src/types";

// Freeze the pre-fix key layout independently of the production key generator.
export function legacyActionsKey(
  request: RelayRequest,
  route: RouteInfo,
  identity?: { kind: string; id: string },
) {
  return hashToken(
    JSON.stringify({
      pool: request.pool,
      method: request.method,
      path: request.path,
      query: Object.fromEntries(
        Object.entries(request.query ?? {})
          .filter(
            ([key, value]) =>
              !(key === "page" && value === "1") && !(key === "per_page" && value === "30"),
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      headers:
        request.headers?.["x-octopool-public-shape"] === undefined
          ? {}
          : { "x-octopool-public-shape": request.headers["x-octopool-public-shape"] },
      route_key: route.routeKey,
      ...(identity === undefined ? {} : { identity: `${identity.kind}:${identity.id}` }),
    }),
  );
}
