import { describe, expect, it, vi } from "vitest";
import { bearer, jsonResponse, relay, seedPool } from "./harness";

describe("weighted media negotiation", () => {
  it.each([
    {
      accept: "application/vnd.github.patch;q=0, application/json;q=1",
      contentType: "application/json",
      body: { number: 12, title: "API-selected representation" },
      encoding: "json",
    },
    {
      accept: "application/vnd.github.diff;q=1, application/vnd.github.patch;q=0",
      contentType: "text/x-diff",
      body: "diff --git a/README.md b/README.md\n",
      encoding: "text",
    },
  ])(
    "preserves the upstream representation for $accept",
    async ({ accept, contentType, body, encoding }) => {
      await seedPool();
      const api = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
        expect(request.url).toBe("https://api.github.com/repos/openclaw/octopool/pulls/12");
        expect(request.headers.get("accept")).toBe(accept);
        expect(bearer(request)).toBe("test-primary-token");
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          headers: { "content-type": contentType },
        });
      });
      vi.stubGlobal("fetch", api);

      const response = await relay("/repos/openclaw/octopool/pulls/12", undefined, {
        headers: { accept },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 200,
        body,
        body_encoding: encoding,
        headers: { "content-type": contentType },
      });
      expect(
        api.mock.calls.some(
          ([input, init]) => new URL(new Request(input, init).url).hostname === "github.com",
        ),
      ).toBe(false);
    },
  );
});
