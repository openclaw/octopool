import { describe, expect, it } from "vitest";
import { plainHTML, textMatch } from "../src/github-html-utils";

describe("GitHub HTML text extraction", () => {
  it("drops unterminated tag-like tails", () => {
    expect(plainHTML("safe <strong>text</strong><script")).toBe("safe text");
    expect(textMatch("title: safe <strong>text</strong><script", /^title: (.*)$/)).toBe(
      "safe text",
    );
  });
});
