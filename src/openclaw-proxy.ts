import { PROXY_HOST_HEADER, PROXY_SECRET_HEADER } from "./hosts";

interface ProxyEnv {
  OCTOPOOL_ORIGIN: string;
  OCTOPOOL_PROXY_SECRET?: string;
}

export default {
  async fetch(request: Request, env: ProxyEnv): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol === "http:") {
      requestUrl.protocol = "https:";
      return Response.redirect(requestUrl.toString(), 308);
    }

    const upstream = new URL(request.url);
    const origin = new URL(env.OCTOPOOL_ORIGIN);
    upstream.protocol = origin.protocol;
    upstream.hostname = origin.hostname;
    upstream.port = origin.port;

    const secret = env.OCTOPOOL_PROXY_SECRET?.trim();
    if (secret === undefined || secret === "") {
      return new Response("proxy secret not configured", { status: 503 });
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set(PROXY_HOST_HEADER, new URL(request.url).hostname);
    headers.set(PROXY_SECRET_HEADER, secret);

    const init: RequestInit = {
      cache: "no-store",
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    return fetch(new Request(upstream, init));
  },
};
