import { describe, expect, it } from "vitest";
import { parseJSONBytes } from "../src/github-public-utils";

const encoder = new TextEncoder();

describe("public JSON byte decoding", () => {
  it.each([
    { name: "invalid leading byte", bytes: [0xff] },
    { name: "invalid continuation", bytes: [0xc3, 0x28] },
    { name: "surrogate", bytes: [0xed, 0xa0, 0x80] },
    { name: "out-of-range code point", bytes: [0xf4, 0x90, 0x80, 0x80] },
  ])("rejects malformed UTF-8: $name", ({ bytes }) => {
    const body = new Uint8Array([
      ...encoder.encode('{"name":"'),
      ...bytes,
      ...encoder.encode('"}'),
    ]);
    expect(parseJSONBytes(body)).toBeUndefined();
  });

  it.each(["replacement �", "日本語 🦊", "plain ASCII"])("preserves valid text %s", (name) => {
    expect(parseJSONBytes(encoder.encode(JSON.stringify({ name })))).toEqual({ name });
  });

  it("keeps accepting a UTF-8 BOM", () => {
    expect(
      parseJSONBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"ok":true}')])),
    ).toEqual({ ok: true });
  });
});
