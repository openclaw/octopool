import { afterEach, describe, expect, it, vi } from "vitest";
import { finishGitHubWebLogin, startGitHubWebLogin } from "../src/web-session";

describe("GitHub OAuth token exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps a hung GitHub OAuth token exchange to a typed upstream error", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          return;
        }
        const abort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = oauthEnv({ REQUEST_TIMEOUT_MS: "1" });
    const { request, url } = await signedCallback(env);

    await expect(finishGitHubWebLogin(request, env, url)).rejects.toMatchObject({
      status: 502,
      code: "github_oauth_failed",
      message: "GitHub OAuth token exchange failed",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

function oauthEnv(overrides: Record<string, string> = {}): Env {
  return {
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_OAUTH_CALLBACK_ORIGIN: "https://octopool.dev",
    ...overrides,
  } as unknown as Env;
}

async function signedCallback(env: Env): Promise<{ request: Request; url: URL }> {
  const start = await startGitHubWebLogin(
    new Request("https://octopool.openclaw.ai/login/github"),
    env,
    new URL("https://octopool.openclaw.ai/login/github"),
  );
  const state = new URL(
    start.headers.get("location") ?? "https://invalid.example/",
  ).searchParams.get("state");
  if (state === null || state === "") {
    throw new Error("expected signed OAuth state");
  }
  const callback = `https://octopool.openclaw.ai/login/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`;
  return {
    request: new Request(callback, {
      headers: { cookie: `octopool_oauth_state=${encodeURIComponent(state)}` },
    }),
    url: new URL(callback),
  };
}
