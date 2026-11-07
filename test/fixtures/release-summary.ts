import { hashToken } from "../../src/auth";
import type { RelayRequest, RouteInfo } from "../../src/types";

export const releaseMarkdown =
  '\r\n## Release notes\r\n\r\n### Fixes\r\n\r\n- Keep `inline code`.\r\n- Read [the docs][guide].  \r\n\r\n```typescript\r\nconst label = "café 🦞";\r\n\tconsole.log(label);  \r\n```\r\n\r\n[guide]: https://example.test/docs "Guide"\r\n\r\n';

// Frozen pre-fix key layout for these default-query release requests.
export function legacyReleaseKey(
  request: RelayRequest,
  route: RouteInfo,
  identity?: { kind: string; id: string },
  protocolEpoch?: string,
) {
  return hashToken(
    JSON.stringify({
      ...(protocolEpoch === undefined ? {} : { protocol_epoch: protocolEpoch }),
      pool: request.pool,
      method: request.method,
      path: request.path,
      query: {},
      headers:
        request.headers?.["x-octopool-public-shape"] === undefined
          ? {}
          : { "x-octopool-public-shape": request.headers["x-octopool-public-shape"] },
      route_key: route.routeKey,
      ...(identity === undefined ? {} : { identity: `${identity.kind}:${identity.id}` }),
    }),
  );
}
