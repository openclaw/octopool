import { APP_ORIGIN, isPublicRequest } from "./hosts";

export function publicWebHostRedirect(request: Request, url: URL, env: Env): Response | undefined {
  if (!isPublicRequest(request, env)) {
    return undefined;
  }
  if (url.pathname === "/login/github/callback") {
    return Response.redirect(`${APP_ORIGIN}${url.pathname}${url.search}`, 302);
  }
  if (url.pathname === "/login/github" || url.pathname === "/dashboard") {
    return Response.redirect(`${APP_ORIGIN}${url.pathname}${url.search}`, 302);
  }
  return undefined;
}
