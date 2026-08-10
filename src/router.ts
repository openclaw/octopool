import { authenticateAdmin, authenticateCaller } from "./auth";
import { parseClientName } from "./client-name";
import { defaultLoginPool } from "./config";
import { dashboardData } from "./dashboard-data";
import { dashboardResponse } from "./dashboard";
import { discoveryResponse } from "./discovery";
import { poolHealth } from "./health";
import { isPublicRequest } from "./hosts";
import { HttpError, jsonResponse, routeParam } from "./http";
import { rootResponse } from "./landing";
import { createCaller, loginGitHubCLI, upsertIdentity } from "./provisioning";
import { relayGitHub } from "./relay";
import { parseStatsWindow, poolStats } from "./stats";
import {
  finishGitHubWebLogin,
  logoutWebSession,
  requireDashboardAdmin,
  startGitHubWebLogin,
  webLoginRedirect,
  webMeResponse,
} from "./web-session";
import { publicWebHostRedirect } from "./web-routing";

export async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/.well-known/octopool") {
    return discoveryResponse(request, env);
  }
  if (request.method === "GET" && url.pathname === "/") {
    return rootResponse(request, requestId, env);
  }
  const webHostRedirect = publicWebHostRedirect(request, url, env);
  if (webHostRedirect !== undefined) {
    return webHostRedirect;
  }
  if (
    isPublicRequest(request, env) &&
    (url.pathname === "/v1/me" || url.pathname === "/v1/dashboard")
  ) {
    throw new HttpError(404, "not_found", "Route not found");
  }
  if (request.method === "GET" && url.pathname === "/login/github") {
    return startGitHubWebLogin(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/login/github/callback") {
    return finishGitHubWebLogin(request, env, url);
  }
  if (request.method === "GET" && url.pathname === "/logout") {
    return logoutWebSession(request, env);
  }
  if (request.method === "GET" && url.pathname === "/dashboard") {
    try {
      await requireDashboardAdmin(request, env, defaultLoginPool(env));
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return webLoginRedirect(request, env);
      }
      throw error;
    }
    return dashboardResponse();
  }
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const session = await requireDashboardAdmin(request, env, defaultLoginPool(env));
    return webMeResponse(session);
  }
  if (request.method === "GET" && url.pathname === "/v1/dashboard") {
    return dashboardData(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/login/github-cli") {
    return loginGitHubCLI(request, env);
  }
  if (request.method === "GET" && /^\/v1\/pools\/[^/]+\/stats$/.test(url.pathname)) {
    const pool = routeParam(url.pathname, /^\/v1\/pools\/(?<pool>[^/]+)\/stats$/, "pool");
    const caller = await authenticateCaller(request, env, pool);
    const window = parseStatsWindow(url.searchParams.get("since"));
    const rawClientFilter = url.searchParams.get("client");
    const clientFilter = rawClientFilter === null ? undefined : parseClientName(rawClientFilter);
    return jsonResponse(await poolStats(env, pool, caller, window, clientFilter));
  }
  if (request.method === "GET" && /^\/v1\/pools\/[^/]+\/health$/.test(url.pathname)) {
    const pool = routeParam(url.pathname, /^\/v1\/pools\/(?<pool>[^/]+)\/health$/, "pool");
    await authenticateCaller(request, env, pool);
    return poolHealth(env, pool);
  }
  if (request.method === "POST" && url.pathname === "/v1/github/request") {
    return relayGitHub(request, env, ctx, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/admin/callers") {
    await authenticateAdmin(request, env);
    return createCaller(request, env);
  }
  if (request.method === "POST" && /^\/v1\/admin\/pools\/[^/]+\/identities$/.test(url.pathname)) {
    await authenticateAdmin(request, env);
    const pool = routeParam(
      url.pathname,
      /^\/v1\/admin\/pools\/(?<pool>[^/]+)\/identities$/,
      "pool",
    );
    return upsertIdentity(request, env, pool);
  }
  throw new HttpError(404, "not_found", "Route not found");
}
