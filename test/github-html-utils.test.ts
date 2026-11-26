import { describe, expect, it } from "vitest";
import { decodeHTML, htmlAttribute, plainHTML, textMatch } from "../src/github-html-utils";

describe("GitHub HTML text extraction", () => {
  it.each([
    "&#1114112;",
    "&#x110000;",
    "&#X110000;",
    "&#9999999999999999999999999999999999999999;",
    `&#${"9".repeat(400)};`,
    `&#x${"f".repeat(400)};`,
  ])("replaces an out-of-range numeric entity %s without aborting extraction", (entity) => {
    expect(decodeHTML(`before ${entity} after`)).toBe("before \uFFFD after");
    expect(plainHTML(`<b>before ${entity}</b> after`)).toBe("before \uFFFD after");
    expect(htmlAttribute(`title="before ${entity} after"`, "title")).toBe("before \uFFFD after");
  });

  it.each(
    [
      0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039,
      0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc,
      0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
    ].map((decoded, index) => [0x80 + index, decoded] as const),
  )("normalizes C1 numeric reference %i to %i", (encoded, decoded) => {
    const expected = String.fromCodePoint(decoded);
    for (const entity of [`&#${encoded};`, `&#x${encoded.toString(16)};`]) {
      expect(decodeHTML(entity)).toBe(expected);
      expect(plainHTML(`<b>${entity}</b>`)).toBe(expected);
      expect(htmlAttribute(`title="${entity}"`, "title")).toBe(expected);
    }
  });

  it.each([0, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0x110000])(
    "replaces invalid numeric code point %i",
    (codePoint) => {
      expect(decodeHTML(`&#${codePoint}; &#x${codePoint.toString(16)};`)).toBe("\uFFFD \uFFFD");
    },
  );

  it.each([0x1, 0x7f, 0xd7ff, 0xe000, 0xfdd0, 0xffff, 0x10ffff])(
    "preserves numeric code point %i outside the HTML replacements",
    (codePoint) => {
      const expected = String.fromCodePoint(codePoint);
      expect(decodeHTML(`&#${codePoint}; &#x${codePoint.toString(16)};`)).toBe(
        `${expected} ${expected}`,
      );
    },
  );

  it("preserves valid numeric entities and decodes escaped ampersands only once", () => {
    expect(decodeHTML("&#65; &#x1f980; &#1114111; &#x10ffff;")).toBe("A 🦀 \u{10ffff} \u{10ffff}");
    expect(decodeHTML("&amp;#1114112; &amp;#x110000;")).toBe("&#1114112; &#x110000;");
    expect(decodeHTML("&#invalid; &#xnope;")).toBe("&#invalid; &#xnope;");
  });

  it.each([
    ["&#38;lt;", "&lt;"],
    ["&#38;quot;", "&quot;"],
    ["&#x26;#65;", "&#65;"],
    ["&#x26;#x41;", "&#x41;"],
    ["&#x26;amp;", "&amp;"],
    ["&#x26;#38;lt;", "&#38;lt;"],
    ["&#38;#x110000;", "&#x110000;"],
  ])("decodes %s only once", (encoded, literal) => {
    expect(decodeHTML(encoded)).toBe(literal);
    expect(plainHTML(`<b>${encoded}</b>`)).toBe(literal);
    expect(htmlAttribute(`title="${encoded}"`, "title")).toBe(literal);
  });

  it("keeps supported named entities and malformed references compatible", () => {
    expect(decodeHTML("&quot; &#39; &lt; &gt; &amp;")).toBe(`" ' < > &`);
    expect(decodeHTML("&QUOT; &unknown; &#x; &#65")).toBe("&QUOT; &unknown; &#x; &#65");
  });

  it("drops unterminated tag-like tails", () => {
    expect(plainHTML("safe <strong>text</strong><script")).toBe("safe text");
    expect(textMatch("title: safe <strong>text</strong><script", /^title: (.*)$/)).toBe(
      "safe text",
    );
  });

  it.each([
    `<span title="a > b">visible</span>`,
    `<span title='a > b'>visible</span>`,
    `<span title="a < b > c" data-note="'">visible</span>`,
    `<span title='a < b > c' data-note='"'>visible</span>`,
    `<!-- " > hidden -->visible`,
    `<!-- <span title='hidden'> -->visible`,
  ])("ignores angle brackets inside attributes and comments: %s", (html) => {
    expect(plainHTML(`before ${html} after`)).toBe("before visible after");
    expect(textMatch(`title: ${html}`, /^title: (.*)$/)).toBe("visible");
  });

  it.each([`<span title="a > b`, `<span title='a > b`, `<!-- hidden > tail`])(
    "drops unterminated quoted tags and comments: %s",
    (tail) => {
      expect(plainHTML(`safe ${tail}`)).toBe("safe");
    },
  );
});
