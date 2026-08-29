import { HttpError } from "./http";
import {
  assertNoStringRewriteMatch,
  compileStringRewriteRules,
  guardStringRewriteRead,
  type StringRewriteRule,
} from "./string-rewrites";

// A new frozen context per authenticated relay request, never a mutation of the
// Worker binding object. The private compiled snapshot cannot cross requests.
export type GitHubEgressEnv = Env & {
  readonly githubEgress: Readonly<{
    fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  }>;
};

export function withGitHubEgress(env: Env, rules: readonly StringRewriteRule[]): GitHubEgressEnv {
  const compiled = Object.freeze(
    compileStringRewriteRules(rules.map(({ pattern, replacement }) => ({ pattern, replacement }))),
  );
  const githubEgress = Object.freeze({
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      const raw = String(input);
      // WHATWG URL strips these controls before fetch; encoded %09 is different.
      if (/[\t\r\n]/.test(raw)) throw stringRewriteEgressDenied();
      let request: Request;
      try {
        request = new Request(raw, { ...init, redirect: "manual" });
      } catch {
        // Platform parser errors can echo a URL or header; never expose them.
        throw stringRewriteEgressDenied();
      }
      if (compiled.length !== 0) {
        const url = new URL(request.url);
        const headers: Record<string, string> = {};
        for (const [key, value] of request.headers) {
          // Credentials belong to the existing authentication layer, not policy content.
          if (key !== "authorization") headers[key] = value;
        }
        assertNoStringRewriteMatch(request.url, compiled);
        guardStringRewriteRead(
          {
            pool: "",
            method: "GET",
            path: url.pathname,
            query: Object.fromEntries(
              [...new Set(url.searchParams.keys())].map((key) => [
                key,
                url.searchParams.getAll(key),
              ]),
            ),
            headers,
          },
          compiled,
        );
        if (init?.body !== undefined && init.body !== null) {
          // Only internal authentication probes have bodies; relay data stays GET-only.
          if (typeof init.body !== "string") throw stringRewriteEgressDenied();
          assertNoStringRewriteMatch(init.body, compiled);
          const inspect = (value: unknown): void => {
            if (typeof value === "string") assertNoStringRewriteMatch(value, compiled);
            else if (value !== null && typeof value === "object") {
              for (const [key, item] of Object.entries(value)) {
                assertNoStringRewriteMatch(key, compiled);
                inspect(item);
              }
            }
          };
          let body: unknown;
          try {
            body = JSON.parse(init.body);
          } catch {
            throw stringRewriteEgressDenied();
          }
          inspect(body);
        }
      }
      return fetch(request.url, {
        ...init,
        headers: Object.fromEntries(request.headers),
        redirect: "manual",
      });
    },
  });
  return Object.freeze({ ...env, githubEgress });
}

export function stringRewriteEgressDenied(): HttpError {
  return new HttpError(403, "string_rewrite_denied", "Request blocked by string protection");
}

export function rethrowStringRewriteDenial(error: unknown): void {
  if (error instanceof HttpError && error.code === "string_rewrite_denied") throw error;
}
