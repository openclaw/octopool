import { describe, expect, it, vi } from "vitest";
import { mockEnrollmentAccount } from "./enrollment-support";
import { CALLER_TOKEN, POOL, callWorker, githubUpstream, jsonResponse, seedPool } from "./harness";

const endpoints = ["/v1/login/github-cli", "/v1/github/request"] as const;

for (const endpoint of endpoints) {
  describe(`JSON media types for ${endpoint}`, () => {
    it.each([
      "application/json",
      "Application/JSON",
      "APPLICATION/JSON; charset=utf-8",
      "application/json ; charset=UTF-8",
    ])("accepts %s", async (contentType) => {
      if (endpoint === "/v1/login/github-cli") {
        mockEnrollmentAccount();
      } else {
        await seedPool();
        vi.stubGlobal("fetch", githubUpstream({ primary: jsonResponse({ number: 42 }) }));
      }

      const response = await callWorker(endpoint, {
        method: "POST",
        headers: { "content-type": contentType, authorization: `Bearer ${CALLER_TOKEN}` },
        body: JSON.stringify(
          endpoint === "/v1/login/github-cli"
            ? { github_token: "synthetic-github", client_name: "media-type-test" }
            : { pool: POOL, method: "GET", path: "/repos/openclaw/octopool/issues/42" },
        ),
      });

      expect(response.status).toBe(endpoint === "/v1/login/github-cli" ? 201 : 200);
      expect(await response.json()).toMatchObject(
        endpoint === "/v1/login/github-cli"
          ? { caller: { github_login: "enrollment-user" }, token: expect.any(String) }
          : { status: 200, body: { number: 42 } },
      );
    });

    it.each([
      undefined,
      "text/plain",
      "application/jsonp",
      "application/json-seq",
      'text/plain; note="application/json"',
    ])("rejects %s before parsing or upstream requests", async (contentType) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);

      const response = await callWorker(endpoint, {
        method: "POST",
        headers: contentType === undefined ? {} : { "content-type": contentType },
        body: "{",
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("preserves the invalid JSON response for a supported media type", async () => {
      const response = await callWorker(endpoint, {
        method: "POST",
        headers: { "content-type": "Application/JSON; charset=utf-8" },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_json" } });
    });
  });
}
