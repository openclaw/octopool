import { responseCapBytes } from "./github-limits";
import { gitRefResponse, parseGitUploadPackAdvertisement } from "./github-git";
import { encodedPathSegments, safeRelativePath } from "./github-path";
import { defaultGitHubJSONAccept } from "./github-response";
import { decodePathStrict, publicJSONResponse } from "./github-public-utils";
import { parseRepositoryNodeIDHTML } from "./github-html";
import { fetchPublicPage } from "./github-web-transport";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

export function gitRefRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    (route.kind !== "git_ref" && route.kind !== "git_matching_refs") ||
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    Object.keys(request.query ?? {}).length !== 0
  ) {
    return undefined;
  }
  const prefix =
    route.kind === "git_ref"
      ? `/repos/${route.owner}/${route.repo}/git/ref/`
      : `/repos/${route.owner}/${route.repo}/git/matching-refs/`;
  const requested = decodePathStrict(request.path.slice(prefix.length));
  if (
    requested === undefined ||
    !safeRelativePath(requested, 200) ||
    (requested !== "heads" &&
      !requested.startsWith("heads/") &&
      requested !== "tags" &&
      !requested.startsWith("tags/"))
  ) {
    return undefined;
  }
  return {
    url: `https://github.com/${encodedPathSegments([route.owner, `${route.repo}.git`])}/info/refs?service=git-upload-pack`,
    headers: {
      accept: "application/x-git-upload-pack-advertisement",
      "user-agent": "octopool",
    },
    capBytes: responseCapBytes(env),
    usesApiQuota: false,
    payload: async (body, headers, status) => {
      const refs = parseGitUploadPackAdvertisement(body);
      if (refs === undefined) {
        return undefined;
      }
      const repositoryPage = await fetchPublicPage(
        `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "issues"])}?q=is%3Aissue`,
        responseCapBytes(env),
        env,
      );
      const repositoryNodeID =
        repositoryPage === undefined ? undefined : parseRepositoryNodeIDHTML(repositoryPage);
      const parsed =
        repositoryNodeID === undefined
          ? undefined
          : gitRefResponse(
              refs,
              repositoryNodeID,
              route.owner!,
              route.repo!,
              requested,
              route.kind === "git_matching_refs",
            );
      return parsed === undefined ? undefined : publicJSONResponse(headers, status, parsed);
    },
  };
}
