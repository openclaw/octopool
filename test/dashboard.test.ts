import { describe, expect, it } from "vitest";
import { dashboardResponse } from "../src/dashboard";

describe("dashboard page", () => {
  it("sizes table empty states from the table header instead of hardcoded column counts", async () => {
    const html = await dashboardResponse().text();
    expect(html).toContain('const ths = body.closest("table").tHead.rows[0].cells;');
    expect(html).toContain("td.colSpan = ths.length;");
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
    expect(html).toContain("Request patterns");
    expect(html).toContain("Fallback &amp; failure causes");
    expect(html).toContain("function ratePercent(rate)");
    expect(html).not.toContain("rate.remaining / 50");
    expect(html).not.toContain("OCTOPOOL_ADMIN_TOKEN");
    expect(html).not.toContain('localStorage.getItem("octopool.token")');
    expect(html).not.toContain('authorization: "Bearer "');
  });
});
