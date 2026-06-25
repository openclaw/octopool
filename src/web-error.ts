import { HttpError } from "./http";

const TITLES: Record<string, string> = {
  caller_not_provisioned: "Pool access unavailable",
  dashboard_denied: "Dashboard access denied",
  github_login_denied: "GitHub login cancelled",
  github_state_expired: "Login expired",
  github_state_invalid: "Login could not be verified",
  org_member_denied: "Org membership required",
  pool_denied: "Pool access denied",
};

export function wantsJson(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/html");
}

export function shouldUseWebError(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && !url.pathname.startsWith("/v1/") && !wantsJson(request);
}

export function webErrorResponse(error: unknown, requestId: string): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = webErrorMessage(error);
  const title = TITLES[code] ?? (status >= 500 ? "Something broke" : "Request blocked");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} - octopool</title>
  <style>
    :root{color-scheme:dark;background:#15171d;color:#f5f7fb;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0%,#263244 0,#15171d 52%)}
    main{width:min(560px,100%);border:1px solid #313948;background:#191d25;padding:28px;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
    .mark{font-size:13px;line-height:1;margin-bottom:16px;color:#ff875f;text-transform:uppercase;letter-spacing:.12em;font-weight:700}
    h1{font-size:28px;line-height:1.15;margin:0 0 12px}
    p{color:#c8cfda;font-size:16px;line-height:1.6;margin:0 0 18px}
    code{color:#ff875f;background:#252b36;border:1px solid #343c4c;border-radius:5px;padding:2px 5px}
    .actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}
    a{color:#8fb1ff;text-decoration:none}
    .button{display:inline-flex;align-items:center;height:42px;padding:0 14px;border-radius:6px;border:1px solid #3a4658;background:#242b37;color:#f5f7fb}
    .meta{font-size:13px;color:#8993a3;margin-top:20px}
  </style>
</head>
<body>
  <main>
    <div class="mark">octopool</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="actions">
      <a class="button" href="/">Home</a>
      <a class="button" href="https://docs.octopool.dev/">Docs</a>
      <a class="button" href="/login/github?next=/dashboard">Sign in again</a>
    </div>
    <p class="meta">Code <code>${escapeHtml(code)}</code> | request <code>${escapeHtml(requestId)}</code></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function webErrorMessage(error: unknown): string {
  if (!(error instanceof HttpError)) {
    return "Octopool hit an internal error. Please try again, and include the request id if it keeps happening.";
  }
  if (error.code === "caller_not_provisioned") {
    return "Your GitHub account is verified, but Octopool could not grant this pool automatically.";
  }
  if (error.code === "dashboard_denied") {
    return "Your GitHub account can use Octopool, but it does not have dashboard admin access.";
  }
  if (error.code === "org_member_denied") {
    return "Octopool is currently limited to verified OpenClaw GitHub org members.";
  }
  return error.message;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
