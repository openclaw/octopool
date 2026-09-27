import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../src/github-egress";
import { completedJobPageProof } from "../src/github-public-actions";

const html = readFileSync(
  new URL("./fixtures/actions-job-completion/completed-check-run.html.txt", import.meta.url),
  "utf8",
);
const shortURL = "https://github.com/openclaw/openclaw/runs/106220362714";
const canonicalURL =
  "https://github.com/openclaw/openclaw/actions/runs/35563377671/job/106220362714";
const prove = (settings: { MAX_RESPONSE_BYTES?: string; REQUEST_TIMEOUT_MS?: string } = {}) =>
  completedJobPageProof(
    withGitHubEgress(settings as Env, []),
    "openclaw",
    "openclaw",
    "106220362714",
  );

afterEach(() => vi.unstubAllGlobals());

describe("token-free completed job page transport", () => {
  it.each([undefined, canonicalURL])(
    "proves the direct page or exact-job redirect: %s",
    async (redirect) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.headers.get("accept")).toBe("text/html");
        expect(request.redirect).toBe("manual");
        if (redirect !== undefined && request.url === shortURL)
          return new Response(null, { status: 302, headers: { location: redirect } });
        expect(request.url).toBe(redirect ?? shortURL);
        return new Response(html);
      });
      vi.stubGlobal("fetch", fetch);
      await expect(prove()).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(redirect === undefined ? 1 : 2);
    },
  );

  it.each([
    "https://github.com/openclaw/openclaw/actions/runs/35563377671/job/106220362715",
    "https://github.com/openclaw/other/actions/runs/35563377671/job/106220362714",
    "https://github.com/login",
    `${canonicalURL}?job=106220362714`,
    "https://raw.githubusercontent.com/openclaw/openclaw/runs/106220362714",
    "https://example.com/openclaw/openclaw/runs/106220362714",
  ])("rejects an unexpected redirect even if the body claims completion: %s", async (location) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) =>
        new Request(input, init).url === shortURL
          ? new Response(null, { status: 302, headers: { location } })
          : new Response(html),
      ),
    );
    await expect(prove()).resolves.toBe(false);
  });

  it.each([403, 404, 503])("does not use a %s page body as proof", async (status) => {
    vi.stubGlobal("fetch", async () => new Response(html, { status }));
    await expect(prove()).resolves.toBe(false);
  });

  it("fails closed for an oversized page without throwing", async () => {
    vi.stubGlobal("fetch", async () => new Response(html));
    await expect(prove({ MAX_RESPONSE_BYTES: "128" })).resolves.toBe(false);
  });

  it("fails closed when the existing transport times out", async () => {
    vi.stubGlobal(
      "fetch",
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    await expect(prove({ REQUEST_TIMEOUT_MS: "10" })).resolves.toBe(false);
  });

  it("bounds a stalled response body with the same timeout", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel })));
    await expect(prove({ REQUEST_TIMEOUT_MS: "10" })).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves string-rewrite denial instead of falling through to another backend", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const env = withGitHubEgress({} as Env, [{ pattern: "106220362714", replacement: "blocked" }]);
    await expect(
      completedJobPageProof(env, "openclaw", "openclaw", "106220362714"),
    ).rejects.toMatchObject({ code: "string_rewrite_denied" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
