import { describe, expect, it } from "vitest";
import { httpsRedirect, secureResponse } from "../src/security";

describe("transport security", () => {
  it("redirects public HTTP requests to HTTPS", () => {
    const response = httpsRedirect(new Request("http://octopool.dev/dashboard?x=1"));

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe("https://octopool.dev/dashboard?x=1");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("does not redirect local HTTP requests", () => {
    expect(httpsRedirect(new Request("http://localhost:8787/"))).toBeUndefined();
    expect(httpsRedirect(new Request("http://127.0.0.1:8787/"))).toBeUndefined();
    expect(httpsRedirect(new Request("http://[::1]:8787/"))).toBeUndefined();
  });

  it("adds HSTS to public HTTPS responses", () => {
    const response = secureResponse(
      new Request("https://octopool.dev/"),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    );

    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains; preload",
    );
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("does not add HSTS to local responses", () => {
    const response = secureResponse(new Request("http://localhost:8787/"), new Response("ok"));

    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});
