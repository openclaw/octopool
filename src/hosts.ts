const APP_HOST = "octopool.openclaw.ai";
export const APP_ORIGIN = `https://${APP_HOST}`;
export const PUBLIC_HOST = "octopool.dev";
export const PROXY_HOST_HEADER = "x-octopool-forwarded-host";
export const PROXY_SECRET_HEADER = "x-octopool-proxy-secret";

export function effectiveHost(request: Request, env?: unknown): string {
  const forwarded = request.headers.get(PROXY_HOST_HEADER)?.trim().toLowerCase();
  if (forwarded === APP_HOST && proxyHeaderAuthorized(request, env)) {
    return forwarded;
  }
  return new URL(request.url).hostname.toLowerCase();
}

export function effectiveOrigin(request: Request, env?: unknown): string {
  const host = effectiveHost(request, env);
  if (host === APP_HOST) {
    return APP_ORIGIN;
  }
  return new URL(request.url).origin;
}

function isPublicHost(hostname: string): boolean {
  return hostname.toLowerCase() === PUBLIC_HOST;
}

export function isPublicRequest(request: Request, env?: unknown): boolean {
  return isPublicHost(effectiveHost(request, env));
}

function proxyHeaderAuthorized(request: Request, env?: unknown): boolean {
  const configured = (env as Record<string, string | undefined> | undefined)?.[
    "OCTOPOOL_PROXY_SECRET"
  ]?.trim();
  if (configured === undefined || configured === "") {
    return false;
  }
  return request.headers.get(PROXY_SECRET_HEADER) === configured;
}
