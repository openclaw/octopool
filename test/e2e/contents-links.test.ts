import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentsLinks } from "../fixtures/contents-links";
import { relay, seedPool } from "./harness";

type Envelope = {
  body: (typeof contentsLinks)[number]["body"];
  body_encoding: string;
  relay: { cache: string; backend: string };
};

describe("contents self-links at the Worker", () => {
  beforeEach(seedPool);

  it.each([
    ["../file.txt", 400, "invalid_path"],
    ["%2e%2e/file.txt", 400, "invalid_path"],
    ["docs/./file.txt", 400, "invalid_path"],
    ["", 424, "fallback_local"],
  ])("retains the existing path boundary for %s", async (suffix, status, code) => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const response = await relay(`/repos/openclaw/octopool/contents/${suffix}`, undefined, {
      query: { ref: "main" },
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(contentsLinks)(
    "preserves $label through a real raw fill and cache hit",
    async (fixture) => {
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(fixture.body.download_url);
        expect(request.headers.has("authorization")).toBe(false);
        return new Response(new Uint8Array([0, 255, 65]), {
          headers: { "content-type": "application/octet-stream" },
        });
      });
      vi.stubGlobal("fetch", upstream);
      for (const cache of ["miss", "hit"]) {
        const response = await relay(fixture.request.path, undefined, fixture.request);
        expect(response.status).toBe(200);
        const wire = await response.json<Envelope>();
        expect.soft(wire.body).toEqual(fixture.body);
        expect
          .soft(wire)
          .toMatchObject({ body_encoding: "json", relay: { cache, backend: "web" } });
        expect.soft(wire.body.url).toBe(wire.body._links.self);
        const url = new URL(wire.body.url);
        expect.soft(url.hash).toBe("");
        expect
          .soft(decodeURIComponent(url.pathname))
          .toBe(`/repos/openclaw/octopool/contents/${fixture.body.path}`);
        expect.soft([...url.searchParams]).toEqual([["ref", fixture.request.query.ref]]);
        expect
          .soft(Array.from(atob(wire.body.content), (char) => char.charCodeAt(0)))
          .toEqual([0, 255, 65]);
      }
      expect(upstream).toHaveBeenCalledExactlyOnceWith(
        fixture.body.download_url,
        expect.any(Object),
      );
    },
  );
});
