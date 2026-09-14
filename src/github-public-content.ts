import { encodeOpaqueBytes } from "./encoding";
import { responseCapBytes } from "./github-limits";
import { encodedPathSegments } from "./github-path";
import { decodePathStrict, publicResponseHeaders } from "./github-public-utils";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

const MEDIA_DIFF = new Set([
  "application/vnd.github.diff",
  "application/vnd.github.v3.diff",
  "application/vnd.github.v3+diff",
]);
const MEDIA_PATCH = new Set([
  "application/vnd.github.patch",
  "application/vnd.github.v3.patch",
  "application/vnd.github.v3+patch",
]);

export function mediaFormat(accept: string | undefined): "diff" | "patch" | undefined {
  const values = (accept ?? "")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim().split(";")[0] ?? "");
  if (values.some((value) => MEDIA_PATCH.has(value))) {
    return "patch";
  }
  return values.some((value) => MEDIA_DIFF.has(value)) ? "diff" : undefined;
}

export function mediaWebRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
  media: "diff" | "patch",
): WebRequest | undefined {
  if (request.method !== "GET" || route.owner === undefined || route.repo === undefined) {
    return undefined;
  }
  const url = mediaWebURL(request, route, media);
  if (url === undefined) {
    return undefined;
  }
  const contentType = media === "patch" ? "text/x-patch" : "text/x-diff";
  return {
    url,
    headers: { accept: `${contentType}, text/plain, */*`, "user-agent": "octopool" },
    capBytes: responseCapBytes(env),
    usesApiQuota: false,
    payload: (bytes, headers, status) => {
      const { body, encoding } = encodeOpaqueBytes(bytes);
      return {
        status,
        headers: publicResponseHeaders(headers, contentType),
        body,
        body_encoding: encoding,
        backend: "web",
      };
    },
  };
}

function mediaWebURL(
  request: RelayRequest,
  route: RouteInfo,
  media: "diff" | "patch",
): string | undefined {
  switch (route.kind) {
    case "pr_view": {
      const number = /\/pulls\/([0-9]+)$/.exec(request.path)?.[1];
      return number === undefined
        ? undefined
        : `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "pull", number])}.${media}`;
    }
    case "commit_view": {
      const sha = /\/commits\/([0-9A-Fa-f]{7,64})$/.exec(request.path)?.[1];
      return sha === undefined
        ? undefined
        : `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "commit", sha])}.${media}`;
    }
    case "compare": {
      const encodedRef = /\/compare\/([^/?#]+)$/.exec(request.path)?.[1];
      const ref = encodedRef === undefined ? undefined : decodePathStrict(encodedRef);
      return ref === undefined
        ? undefined
        : `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "compare"])}/${encodeURIComponent(ref)}.${media}`;
    }
    default:
      return undefined;
  }
}
