import { beforeEach, describe, expect, it, vi } from "vitest";
import { envelopeBytes, opaqueBytes } from "../fixtures/opaque-bytes";
import { bearer, jsonResponse, rateHeaders, relay, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";

type Envelope = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: string;
  relay: { cache: string; backend: string };
};
const apiPath = "/repos/openclaw/octopool/contents/README.md";
const mediaPath = "/repos/openclaw/octopool/pulls/12";

describe("opaque Worker wire bytes", () => {
  beforeEach(seedPool);

  it.each(["application/vnd.github.raw", "application/vnd.github+json"])(
    "keeps malformed JSON bytes lossless with %s negotiation",
    async (accept) => {
      const bytes = [0x7b, 0xff];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          if (bearer(input, init) === "test-org-token") return jsonResponse({ private: false });
          return new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/json" },
          });
        }),
      );
      const response = await relay(apiPath, undefined, { headers: { accept } });
      expect(response.status).toBe(200);
      const wire = await response.json<Envelope>();
      expect(envelopeBytes(wire)).toEqual(bytes);
      expect(wire.body_encoding).toBe("base64");
    },
  );

  it.each(opaqueBytes)("preserves pooled API $name through fill and hit", async (fixture) => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
      expect(new URL(request.url).pathname).toBe(apiPath);
      expect(bearer(request)).toBe("test-primary-token");
      return new Response(new Uint8Array(fixture.bytes), {
        headers: {
          "content-type": "text/plain",
          etag: '"wire"',
          ...rateHeaders({ remaining: 4998 }),
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    for (const cache of ["miss", "hit"]) {
      const response = await relay(apiPath, undefined, {
        headers: { accept: "application/vnd.github.raw" },
      });
      expect(response.status).toBe(200);
      const wire = await response.json<Envelope>();
      expect.soft(envelopeBytes(wire)).toEqual(fixture.bytes);
      expect.soft(wire).toMatchObject({
        status: 200,
        body_encoding: fixture.encoding,
        headers: { "content-type": "text/plain", etag: '"wire"' },
        relay: { cache },
      });
      if (fixture.bytes.length === 0) expect(wire.body).toBeNull();
    }
    expect(
      upstream.mock.calls.filter(([input, init]) => bearer(input, init) === "test-primary-token"),
    ).toHaveLength(1);
  });

  it.each(
    opaqueBytes.map((fixture, index) => ({ ...fixture, media: index % 2 ? "patch" : "diff" })),
  )("preserves preferred public $media $name through fill and hit", async (fixture) => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://github.com/openclaw/octopool/pull/12.${fixture.media}`);
      expect(request.headers.has("authorization")).toBe(false);
      return new Response(new Uint8Array(fixture.bytes), {
        headers: { "content-type": `text/x-${fixture.media}`, etag: '"media"' },
      });
    });
    vi.stubGlobal("fetch", upstream);
    for (const cache of ["miss", "hit"]) {
      const response = await relay(mediaPath, undefined, {
        headers: { accept: `application/vnd.github.${fixture.media}` },
      });
      expect(response.status).toBe(200);
      const wire = await response.json<Envelope>();
      expect.soft(envelopeBytes(wire)).toEqual(fixture.bytes);
      expect
        .soft(wire)
        .toMatchObject({ status: 200, body_encoding: fixture.encoding, relay: { cache } });
      if (fixture.bytes.length === 0) expect(wire.body).toBe("");
    }
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["api", "diff"])(
    "caps chunked %s before envelope expansion and cancels on overflow",
    async (transport) => {
      let size = 4;
      let pulls = 0;
      const cancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          if (bearer(request) === "test-org-token") return jsonResponse({ private: false });
          if (transport === "diff" && new URL(request.url).hostname === "api.github.com")
            return jsonResponse({ message: "unavailable" }, 503);
          if (transport === "diff") expect(request.headers.has("authorization")).toBe(false);
          else expect(bearer(request)).toBe("test-primary-token");
          let sent = 0;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls++;
                  if (sent === size) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(new Uint8Array([0xff, 0xfe]));
                  sent += 2;
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/plain" } },
          );
        }),
      );
      const path = transport === "api" ? apiPath : mediaPath;
      const headers = {
        accept: transport === "api" ? "application/vnd.github.raw" : "application/vnd.github.diff",
        "cache-control": "max-age=0",
      };
      const exact = await requestWithEnv({ MAX_RESPONSE_BYTES: "4" }, path, { headers });
      expect(exact.status).toBe(200);
      const wire = await exact.json<Envelope>();
      expect(envelopeBytes(wire)).toEqual([0xff, 0xfe, 0xff, 0xfe]);
      expect(wire.body_encoding).toBe("base64");
      expect(String(wire.body).length).toBeGreaterThan(4);
      expect(cancel).not.toHaveBeenCalled();
      size = 8;
      pulls = 0;
      const overflow = await requestWithEnv({ MAX_RESPONSE_BYTES: "4" }, path, { headers });
      expect(overflow.status).toBeGreaterThanOrEqual(400);
      expect(cancel).toHaveBeenCalled();
      // Each attempted backend cancels on the third 2-byte chunk, before consuming 8 bytes.
      expect(pulls).toBe(cancel.mock.calls.length * 3);
    },
  );
});
