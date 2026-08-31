import { requestTimeoutMs } from "./github-limits";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { publicAPIRequest, releaseAPIRequest, storePublicAPIRate } from "./github-public-api";
import { actionsPageRequest } from "./github-public-actions";
import { mediaFormat, mediaWebRequest, rawContentRequest } from "./github-public-content";
import { gitRefRequest } from "./github-public-git";
import { summaryPageRequest } from "./github-public-pages";
import { githubResponseHeaders } from "./github-response";
import type { WebRequest } from "./github-web-types";
import { fetchWebResponse, readWebBody } from "./github-web-transport";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

export async function callGitHubWeb(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse | undefined> {
  let requests = webRequests(env, request, route);
  if (requests.length === 0) {
    return undefined;
  }
  const hasPublicAlternative =
    requests.some((candidate) => candidate.usesApiQuota) &&
    requests.some((candidate) => !candidate.usesApiQuota);
  if (hasPublicAlternative) {
    requests = [
      ...requests.filter((candidate) => !candidate.usesApiQuota),
      ...requests.filter((candidate) => candidate.usesApiQuota),
    ];
  }
  for (const web of requests) {
    const timeoutMs = requestTimeoutMs(env);
    const fetched = await fetchWebResponse(env, web.url, web.headers, timeoutMs);
    if (fetched === undefined) {
      continue;
    }
    const { response, url: responseURL } = fetched;
    if (web.usesApiQuota) {
      await storePublicAPIRate(env, route.resource, response.headers);
    }
    if (response.status < 200 || response.status >= 300) {
      continue;
    }
    try {
      const body = await readWebBody(response, web.capBytes);
      const payload = await web.payload(
        new Uint8Array(body),
        response.headers,
        response.status,
        responseURL,
      );
      if (payload !== undefined) {
        return { ...payload, backend: web.usesApiQuota ? "github" : "web" };
      }
    } catch (error) {
      rethrowStringRewriteDenial(error);
      continue;
    }
  }
  return undefined;
}

export async function callAnonymousGitHubAPI(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): Promise<GitHubRelayResponse | undefined> {
  const api = webRequests(env, request, route).find((candidate) => candidate.usesApiQuota);
  if (api === undefined) {
    return undefined;
  }
  const fetched = await fetchWebResponse(
    env,
    api.url,
    { ...api.headers, ...conditionalHeaders(request.headers) },
    requestTimeoutMs(env),
  );
  if (fetched === undefined) {
    return undefined;
  }
  const { response, url: responseURL } = fetched;
  await storePublicAPIRate(env, route.resource, response.headers);
  if (response.status === 304) {
    return {
      status: 304,
      headers: githubResponseHeaders(response.headers),
      body: null,
      body_encoding: "text",
      backend: "github",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }
  try {
    const body = await readWebBody(response, api.capBytes);
    const payload = await api.payload(
      new Uint8Array(body),
      response.headers,
      response.status,
      responseURL,
    );
    return payload === undefined ? undefined : { ...payload, backend: "github" };
  } catch (error) {
    rethrowStringRewriteDenial(error);
    return undefined;
  }
}

function conditionalHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return {
    ...(headers?.["if-none-match"] === undefined
      ? {}
      : { "if-none-match": headers["if-none-match"] }),
    ...(headers?.["if-modified-since"] === undefined
      ? {}
      : { "if-modified-since": headers["if-modified-since"] }),
  };
}

function webRequests(env: GitHubEgressEnv, request: RelayRequest, route: RouteInfo): WebRequest[] {
  const media = mediaFormat(request.headers?.accept);
  if (media !== undefined) {
    const mediaRequest = mediaWebRequest(env, request, route, media);
    return mediaRequest === undefined ? [] : [mediaRequest];
  }
  const out: WebRequest[] = [];
  const release = releaseAPIRequest(env, request, route);
  if (release !== undefined) {
    out.push(release);
  }
  const publicApi = publicAPIRequest(env, request, route);
  if (publicApi !== undefined) {
    out.push(publicApi);
  }
  const gitRef = gitRefRequest(env, request, route);
  if (gitRef !== undefined) {
    out.push(gitRef);
  }
  const summaryPage = summaryPageRequest(env, request, route);
  if (summaryPage !== undefined) {
    out.push(summaryPage);
  }
  const actions = actionsPageRequest(env, request, route);
  if (actions !== undefined) {
    out.push(actions);
  }
  const rawContent = rawContentRequest(env, request, route);
  if (rawContent !== undefined) {
    out.push(rawContent);
  }
  return out;
}
