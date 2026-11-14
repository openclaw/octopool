import { describe, expect, it } from "vitest";
import { jsonResponse } from "../src/http";

const forms: { name: string; make: (entries: [string, string][]) => HeadersInit }[] = [
  { name: "record", make: Object.fromEntries },
  { name: "pairs", make: (entries) => entries },
  { name: "Headers", make: (entries) => new Headers(entries) },
];

describe("JSON response headers", () => {
  it.each(forms)("preserves custom $name headers and cache-control casing", async ({ make }) => {
    const response = jsonResponse(
      { ok: true },
      201,
      make([
        ["X-Trace", "test-trace"],
        ["Cache-Control", "private, max-age=60"],
        ["Content-Type", "application/json; charset=utf-8"],
      ]),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-trace")).toBe("test-trace");
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each(forms)("adds default cache control to $name headers", ({ make }) => {
    const response = jsonResponse({}, 200, make([["X-Trace", "test-trace"]]));
    expect(response.headers.get("x-trace")).toBe("test-trace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("does not mutate a supplied Headers object", () => {
    const headers = new Headers({ "x-trace": "test-trace" });
    jsonResponse({}, 200, headers);
    expect([...headers]).toEqual([["x-trace", "test-trace"]]);
  });

  it("keeps default status and cache control without supplied headers", async () => {
    const response = jsonResponse({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });
});
