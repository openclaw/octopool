import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, base64ToBytesSafe, bytesToBase64, bytesToBase64URL } from "../src/encoding";
import {
  appendRelayQuery,
  decodeURIComponentSafe,
  encodedPathSegments,
  safeRelativePath,
} from "../src/github-path";
import { defaultGitHubJSONAccept, githubResponseHeaders } from "../src/github-response";
import { isRecord } from "../src/object";
import { readBodyCapped } from "../src/response-body";
import { parseSQLiteTimestamp, sqliteTimestamp } from "../src/sqlite-time";

describe("shared GitHub primitives", () => {
  it("round-trips standard and URL-safe base64", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x61]);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytesSafe(bytesToBase64URL(bytes))).toEqual(bytes);
    expect(base64ToBytesSafe("not base64!")).toBeUndefined();
  });

  it("normalizes SQLite UTC timestamps at second precision", () => {
    const epoch = Date.UTC(2026, 5, 18, 7, 30, 15, 987);
    expect(sqliteTimestamp(epoch)).toBe("2026-06-18 07:30:15");
    expect(parseSQLiteTimestamp("2026-06-18 07:30:15")).toBe(Date.UTC(2026, 5, 18, 7, 30, 15));
    expect(parseSQLiteTimestamp("2026-06-18T07:30:15Z")).toBe(Date.UTC(2026, 5, 18, 7, 30, 15));
  });

  it("recognizes records without accepting arrays", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("encodes slash-separated GitHub path components without losing boundaries", () => {
    expect(encodedPathSegments(["openclaw", "octo pool", "refs/heads/main"])).toBe(
      "openclaw/octo%20pool/refs/heads/main",
    );
    expect(decodeURIComponentSafe("dependabot%5Bbot%5D")).toBe("dependabot[bot]");
    expect(decodeURIComponentSafe("bad%2")).toBe("bad%2");
    expect(safeRelativePath("refs/heads/main", 200)).toBe(true);
    expect(safeRelativePath("refs/../main", 200)).toBe(false);
  });

  it("preserves repeated relay query values in order", () => {
    const url = new URL("https://api.github.com/repos/openclaw/octopool");

    appendRelayQuery(url, { label: ["bug", "help wanted"], page: "2" });

    expect(url.search).toBe("?label=bug&label=help+wanted&page=2");
  });

  it("projects only safe response headers with backend-specific content metadata", () => {
    const headers = new Headers({
      "cache-control": "public, max-age=60",
      "content-type": "text/html",
      etag: "abc",
      "set-cookie": "secret=yes",
      "x-ratelimit-remaining": "50",
    });

    expect(
      githubResponseHeaders(headers, {
        contentType: "application/json",
        includeCacheControl: true,
      }),
    ).toEqual({
      "cache-control": "public, max-age=60",
      "content-type": "application/json",
      etag: "abc",
      "x-ratelimit-remaining": "50",
    });
    expect(defaultGitHubJSONAccept(undefined)).toBe(true);
    expect(defaultGitHubJSONAccept("")).toBe(true);
    expect(defaultGitHubJSONAccept("", false)).toBe(false);
    expect(defaultGitHubJSONAccept("text/html")).toBe(false);
  });

  it("combines streamed chunks within the cap", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );

    await expect(readBodyCapped(response, 3, () => new Error("too large"))).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("cancels an oversized stream and preserves the configured error", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel,
      }),
    );

    await expect(readBodyCapped(response, 3, () => new Error("too large"))).rejects.toThrow(
      "too large",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
