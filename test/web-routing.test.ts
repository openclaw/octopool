import { describe, expect, it, vi } from "vitest";
import { discoveryResponse } from "../src/discovery";
import { PROXY_HOST_HEADER, PROXY_SECRET_HEADER } from "../src/hosts";
import { errorResponse, HttpError } from "../src/http";
import { rootResponse } from "../src/landing";
import proxyWorker from "../src/openclaw-proxy";
import { publicWebHostRedirect } from "../src/web-routing";
import { startGitHubWebLogin } from "../src/web-session";
import { shouldUseWebError, webErrorResponse } from "../src/web-error";

describe("web routing helpers", () => {
  it("serves server discovery for public and proxied app hosts", async () => {
    const publicDiscovery = await discoveryResponse(
      new Request("https://octopool.dev/.well-known/octopool"),
      discoveryEnv(),
    ).json();
    expect(publicDiscovery).toMatchObject({
      service: "octopool",
      version: 1,
      api_base: "https://octopool.dev",
      app_base: "https://octopool.openclaw.ai",
      default_pool: "maintainers",
      allowed_org: "openclaw",
      auth: { cli_github_token: true, web_login: true },
    });

    const appDiscovery = await discoveryResponse(
      new Request("https://octopool.dev/.well-known/octopool", {
        headers: {
          [PROXY_HOST_HEADER]: "octopool.openclaw.ai",
          [PROXY_SECRET_HEADER]: "proxy-secret",
        },
      }),
      discoveryEnv(),
    ).json();
    expect(appDiscovery).toMatchObject({
      api_base: "https://octopool.openclaw.ai",
      app_base: "https://octopool.openclaw.ai",
    });
  });

  it("serves the landing page by default and JSON only when requested", async () => {
    const proxyEnv = { OCTOPOOL_PROXY_SECRET: "proxy-secret" };
    const html = rootResponse(new Request("https://octopool.openclaw.ai/"), "req-html");
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("vary")).toBe("Accept");
    const app = await html.text();
    expect(app).toContain("<title>octopool</title>");
    expect(app).toContain("Sign in with GitHub");
    expect(app).toContain('href="/dashboard"');

    const proxiedApp = await rootResponse(
      new Request("https://octopool.dev/", {
        headers: {
          [PROXY_HOST_HEADER]: "octopool.openclaw.ai",
          [PROXY_SECRET_HEADER]: "proxy-secret",
        },
      }),
      "req-proxied",
      proxyEnv,
    ).text();
    expect(proxiedApp).toContain("Sign in with GitHub");
    expect(proxiedApp).toContain('href="/dashboard"');
    expect(proxiedApp).not.toContain("brew install openclaw/tap/octopool");

    const publicHtml = await rootResponse(
      new Request("https://octopool.dev/", {
        headers: { [PROXY_HOST_HEADER]: "octopool.openclaw.ai" },
      }),
      "req-public",
      proxyEnv,
    ).text();
    expect(publicHtml).toContain("brew install openclaw/tap/octopool");
    expect(publicHtml).toContain('class="copy-command"');
    expect(publicHtml).toContain('aria-label="Copy install command"');
    expect(publicHtml).not.toContain("Sign in with GitHub");
    expect(publicHtml).not.toContain('href="/dashboard"');

    const json = rootResponse(
      new Request("https://octopool.dev/", { headers: { accept: "application/json" } }),
      "req-json",
    );
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(json.headers.get("vary")).toBe("Accept");
    await expect(json.json()).resolves.toMatchObject({ ok: true, service: "octopool" });
  });

  it("renders browser-facing errors as HTML", async () => {
    const request = new Request("https://octopool.dev/login/github/callback", {
      headers: { accept: "text/html" },
    });
    expect(shouldUseWebError(request)).toBe(true);

    const response = webErrorResponse(
      new HttpError(403, "caller_not_provisioned", "Caller is not provisioned for this pool"),
      "req-web",
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Pool access unavailable");
    expect(html).toContain("could not grant this pool automatically");
    expect(html).not.toContain('{"error"');
  });

  it("forwards public GitHub OAuth callbacks to the authoritative app host", async () => {
    const response = publicWebHostRedirect(
      new Request("https://octopool.dev/login/github/callback?code=abc&state=state.123.sig"),
      new URL("https://octopool.dev/login/github/callback?code=abc&state=state.123.sig"),
      discoveryEnv(),
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://octopool.openclaw.ai/login/github/callback?code=abc&state=state.123.sig",
    );
  });

  it("keeps API errors as JSON even for broad accepts", () => {
    const request = new Request("https://octopool.dev/v1/pools/maintainers/health", {
      headers: { accept: "text/html,application/json" },
    });
    expect(shouldUseWebError(request)).toBe(false);
  });

  it("reports backend overload as a typed retryable error, not internal_error", async () => {
    const response = errorResponse(
      new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."),
      "req-overload",
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "relay_overloaded", request_id: "req-overload" },
    });
  });

  it("includes safe error details in API error responses", async () => {
    const response = errorResponse(
      new HttpError(401, "github_auth_failed", "GitHub token check failed with 403", {
        github_rate_limit_reset: "1779928316",
        github_rate_limit_remaining: "0",
      }),
      "req-rate",
    );

    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "github_auth_failed",
        request_id: "req-rate",
        details: {
          github_rate_limit_reset: "1779928316",
          github_rate_limit_remaining: "0",
        },
      },
    });
  });

  it("starts GitHub OAuth with stateless signed state", async () => {
    const env = oauthEnv();
    const response = await startGitHubWebLogin(
      new Request("https://octopool.dev/login/github", {
        headers: {
          [PROXY_HOST_HEADER]: "octopool.openclaw.ai",
          [PROXY_SECRET_HEADER]: "proxy-secret",
        },
      }),
      env,
      new URL("https://octopool.dev/login/github?next=/" + "x".repeat(300)),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://octopool.dev/login/github/callback",
    );
    expect(state).toMatch(/^state\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/);
    expect(response.headers.get("set-cookie")).toContain(encodeURIComponent(state));
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("redirects HTTP at the public-host proxy before forwarding", async () => {
    const response = await proxyWorker.fetch(new Request("http://octopool.dev/dashboard"), {
      OCTOPOOL_ORIGIN: "https://octopool.dev",
      OCTOPOOL_PROXY_SECRET: "proxy-secret",
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://octopool.dev/dashboard");
  });

  it("forwards app-host proxy requests with authenticated host context and no cache", async () => {
    const fetchMock = vi.fn(async (_request: Request) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await proxyWorker.fetch(
        new Request("https://octopool.openclaw.ai/login/github", {
          headers: {
            accept: "text/html",
            host: "octopool.openclaw.ai",
          },
        }),
        {
          OCTOPOOL_ORIGIN: "https://octopool.dev",
          OCTOPOOL_PROXY_SECRET: "proxy-secret",
        },
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
      expect(new URL(forwarded.url).origin).toBe("https://octopool.dev");
      expect(forwarded.cache).toBe("no-store");
      expect(forwarded.headers.get("host")).toBeNull();
      expect(forwarded.headers.get(PROXY_HOST_HEADER)).toBe("octopool.openclaw.ai");
      expect(forwarded.headers.get(PROXY_SECRET_HEADER)).toBe("proxy-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards the public host into the authoritative data plane", async () => {
    const fetchMock = vi.fn(async (_request: Request) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await proxyWorker.fetch(
        new Request("https://octopool.dev/.well-known/octopool"),
        {
          OCTOPOOL_ORIGIN: "https://octopool.openclaw.ai",
          OCTOPOOL_PROXY_SECRET: "proxy-secret",
        },
      );

      expect(response.status).toBe(200);
      const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
      expect(new URL(forwarded.url).origin).toBe("https://octopool.openclaw.ai");
      expect(forwarded.headers.get(PROXY_HOST_HEADER)).toBe("octopool.dev");
      expect(forwarded.headers.get(PROXY_SECRET_HEADER)).toBe("proxy-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function oauthEnv(): Env & { DB: { prepare: ReturnType<typeof vi.fn> } } {
  const prepare = vi.fn();
  return {
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_OAUTH_CALLBACK_ORIGIN: "https://octopool.dev",
    OCTOPOOL_PROXY_SECRET: "proxy-secret",
    DB: { prepare },
  } as unknown as Env & { DB: { prepare: ReturnType<typeof vi.fn> } };
}

function discoveryEnv(): Env {
  return {
    ALLOWED_GITHUB_ORG: "openclaw",
    OCTOPOOL_PROXY_SECRET: "proxy-secret",
  } as unknown as Env;
}
