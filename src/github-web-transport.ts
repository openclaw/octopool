import { requestTimeoutMs } from "./github-limits";
import { rethrowStringRewriteDenial, type GitHubEgressEnv } from "./github-egress";
import { HttpError } from "./http";
import { readBodyCapped } from "./response-body";

export async function fetchWebResponse(
  env: GitHubEgressEnv,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirectNotModified = false,
): Promise<{ response: Response; url: string } | undefined> {
  let response: Response;
  try {
    response = await env.githubEgress.fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    rethrowStringRewriteDenial(error);
    return undefined;
  }
  const responseURL = response.url || url;
  if (
    response.status < 300 ||
    response.status >= 400 ||
    (response.status === 304 && !redirectNotModified)
  ) {
    return { response, url: responseURL };
  }
  const location = response.headers.get("location");
  if (location === null) {
    await cancelResponseBody(response);
    return undefined;
  }
  let redirectedURL: URL;
  try {
    redirectedURL = new URL(location, responseURL);
  } catch {
    await cancelResponseBody(response);
    return undefined;
  }
  if (redirectedURL.protocol !== "https:" || !allowedWebRedirectHost(redirectedURL.hostname)) {
    await cancelResponseBody(response);
    return undefined;
  }
  try {
    await cancelResponseBody(response);
    const redirected = await env.githubEgress.fetch(redirectedURL.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (redirected.status >= 300 && redirected.status < 400) {
      return undefined;
    }
    return {
      response: redirected,
      url: redirected.url || redirectedURL.toString(),
    };
  } catch (error) {
    rethrowStringRewriteDenial(error);
    return undefined;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function fetchPublicPage(
  url: string,
  capBytes: number,
  env: GitHubEgressEnv,
  accept = "text/html",
): Promise<string | undefined> {
  const fetched = await fetchWebResponse(
    env,
    url,
    { accept, "user-agent": "octopool" },
    requestTimeoutMs(env),
    true,
  );
  if (fetched === undefined || fetched.response.status < 200 || fetched.response.status >= 300) {
    return undefined;
  }
  try {
    return new TextDecoder().decode(await readWebBody(fetched.response, capBytes));
  } catch {
    return undefined;
  }
}

export function readWebBody(response: Response, capBytes: number): Promise<Uint8Array> {
  return readBodyCapped(
    response,
    capBytes,
    () => new HttpError(502, "github_web_response_too_large", "GitHub web response is too large"),
  );
}

function allowedWebRedirectHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "patch-diff.githubusercontent.com" ||
    lower === "github.com" ||
    lower === "raw.githubusercontent.com"
  );
}
