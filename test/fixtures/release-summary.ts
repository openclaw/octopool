import { hashToken } from "../../src/auth";
import type { RelayRequest, RouteInfo } from "../../src/types";

export const releaseMarkdown =
  '\r\n## Release notes\r\n\r\n### Fixes\r\n\r\n- Keep `inline code`.\r\n- Read [the docs][guide].  \r\n\r\n```typescript\r\nconst label = "café 🦞";\r\n\tconsole.log(label);  \r\n```\r\n\r\n[guide]: https://example.test/docs "Guide"\r\n\r\n';

// Rendered HTML cannot identify the original reference links, fences, or whitespace.
export const releaseHTML = `
  <nav><li class="breadcrumb-item-selected">v0.8.0</li></nav>
  <h1>0.8.0</h1>
  released this <relative-time datetime="2026-06-10T07:55:39Z"></relative-time>
  <div data-test-selector="body-content" class="markdown-body"><h2>Release notes</h2>
<h3>Fixes</h3>
<ul>
<li>Keep <code>inline code</code>.</li>
<li>Read <a href="https://example.test/docs" title="Guide">the docs</a>.</li>
</ul>
<pre><code class="language-typescript">const label = "café 🦞";
\tconsole.log(label);
</code></pre></div>
  </div>
  <div class="Box-footer"></div>
`;

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
