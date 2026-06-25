const HSTS = "max-age=31536000; includeSubDomains; preload";

export function httpsRedirect(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || isLocalHost(url.hostname)) {
    return undefined;
  }
  url.protocol = "https:";
  return new Response(null, {
    status: 308,
    headers: {
      location: url.toString(),
      "cache-control": "no-store",
    },
  });
}

export function secureResponse(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  if (url.protocol === "https:" && !isLocalHost(url.hostname)) {
    headers.set("strict-transport-security", HSTS);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
