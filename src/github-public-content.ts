import { bytesToBase64 } from "./encoding";
import { responseCapBytes } from "./github-limits";
import { encodedPathSegments, safeRelativePath } from "./github-path";
import { decodePathStrict, publicResponseHeaders, scalarQuery } from "./github-public-utils";
import { defaultGitHubJSONAccept } from "./github-response";
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
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: (body, headers, status) => ({
      status,
      headers: publicResponseHeaders(headers, contentType),
      body: new TextDecoder().decode(body),
      body_encoding: "text",
      backend: "web",
    }),
  };
}

export function rawContentRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    route.kind !== "contents" ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const ref = scalarQuery(request.query, "ref");
  if (ref === undefined || !safeRelativePath(ref, 200)) {
    return undefined;
  }
  const contentPath = contentPathFromRequest(request, route);
  if (contentPath === undefined || !safeRelativePath(contentPath, 1024)) {
    return undefined;
  }
  const rawURL = `https://raw.githubusercontent.com/${encodedPathSegments([route.owner, route.repo, ref, contentPath])}`;
  return {
    url: rawURL,
    headers: { accept: "text/plain, */*", "user-agent": "octopool" },
    capBytes: responseCapBytes(env, route),
    usesApiQuota: false,
    payload: (body, headers, status) => {
      const sha = gitBlobSHA(body);
      const apiPath = `/repos/${route.owner}/${route.repo}/contents/${contentPath}`;
      const apiURL = `https://api.github.com${apiPath}?ref=${encodeURIComponent(ref)}`;
      const htmlURL = `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "blob", ref, contentPath])}`;
      return {
        status,
        headers: publicResponseHeaders(headers, "application/json"),
        body: {
          type: "file",
          encoding: "base64",
          name: contentPath.split("/").at(-1) ?? contentPath,
          path: contentPath,
          sha,
          size: body.byteLength,
          content: bytesToBase64(body),
          url: apiURL,
          html_url: htmlURL,
          git_url: `https://api.github.com/repos/${route.owner}/${route.repo}/git/blobs/${sha}`,
          download_url: rawURL,
          _links: {
            self: apiURL,
            git: `https://api.github.com/repos/${route.owner}/${route.repo}/git/blobs/${sha}`,
            html: htmlURL,
          },
        },
        body_encoding: "json",
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

function contentPathFromRequest(request: RelayRequest, route: RouteInfo): string | undefined {
  const prefix = `/repos/${route.owner}/${route.repo}/contents/`;
  if (!request.path.startsWith(prefix)) {
    return undefined;
  }
  const value = request.path.slice(prefix.length);
  return value === "" ? undefined : decodePathStrict(value);
}

function gitBlobSHA(body: Uint8Array): string {
  // WebCrypto SHA-1 is unavailable in some Workers runtimes; Git object IDs require SHA-1.
  return sha1(new Uint8Array([...new TextEncoder().encode(`blob ${body.byteLength}\0`), ...body]));
}

function sha1(message: Uint8Array): string {
  const words: number[] = [];
  for (let index = 0; index < message.length; index++) {
    words[index >> 2] = (words[index >> 2] ?? 0) | (message[index]! << (24 - (index % 4) * 8));
  }
  words[message.length >> 2] =
    (words[message.length >> 2] ?? 0) | (0x80 << (24 - (message.length % 4) * 8));
  words[(((message.length + 8) >> 6) << 4) + 15] = message.length * 8;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  for (let offset = 0; offset < words.length; offset += 16) {
    const w = Array.from({ length: 80 }, (_, index) => words[offset + index] ?? 0);
    for (let index = 16; index < 80; index++) {
      w[index] = rotateLeft(w[index - 3]! ^ w[index - 8]! ^ w[index - 14]! ^ w[index - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index++) {
      const [f, k] =
        index < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : index < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : index < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const temp = (rotateLeft(a, 5) + f + e + k + w[index]!) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}
