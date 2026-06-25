import { describe, expect, it } from "vitest";
import { dashboardResponse } from "../src/dashboard";

describe("dashboard page", () => {
  it("separates the account footer from tablet-sized pool controls", async () => {
    const html = await dashboardResponse().text();
    expect(html).toContain(
      ".who{margin-top:14px;padding:14px 0 0;border-top:1px solid var(--line-soft);border-left:0}",
    );
  });

  it("uses website session auth instead of browser-stored admin tokens", async () => {
    const html = await dashboardResponse().text();
    expect(html).toContain("Relay control room");
    expect(html).toContain('rel="icon" href="data:image/svg+xml');
    expect(html).toContain("Checking web session.");
    expect(html).toContain('href="/logout">Log out</a>');
    expect(html).toContain('credentials: "same-origin"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Eligible cache hit");
    expect(html).toContain("Request Patterns");
    expect(html).toContain("Fallback & Failure Causes");
    expect(html).toContain("function ratePercent(rate)");
    expect(html).not.toContain("rate.remaining / 50");
    expect(html).not.toContain("OCTOPOOL_ADMIN_TOKEN");
    expect(html).not.toContain('localStorage.getItem("octopool.token")');
    expect(html).not.toContain('authorization: "Bearer "');
  });
});
