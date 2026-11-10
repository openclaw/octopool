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

  it("preserves valid numeric entities and decodes escaped ampersands only once", () => {
    expect(decodeHTML("&#65; &#x1f980; &#1114111; &#x10ffff;")).toBe("A 🦀 \u{10ffff} \u{10ffff}");
    expect(decodeHTML("&amp;#1114112; &amp;#x110000;")).toBe("&#1114112; &#x110000;");
    expect(decodeHTML("&#invalid; &#xnope;")).toBe("&#invalid; &#xnope;");
  });

  it("drops unterminated tag-like tails", () => {
    expect(plainHTML("safe <strong>text</strong><script")).toBe("safe text");
    expect(textMatch("title: safe <strong>text</strong><script", /^title: (.*)$/)).toBe(
      "safe text",
    );
  });
});
