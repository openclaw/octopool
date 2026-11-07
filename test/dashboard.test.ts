import { describe, expect, it } from "vitest";
import { dashboardResponse } from "../src/dashboard";

describe("dashboard page", () => {
  it("uses website session auth instead of browser-stored admin tokens", async () => {
    const html = await dashboardResponse().text();
    expect(html).toContain('href="/logout">Log out</a>');
    expect(html).toContain('credentials: "same-origin"');
    expect(html).not.toContain("OCTOPOOL_ADMIN_TOKEN");
    expect(html).not.toContain('localStorage.getItem("octopool.token")');
    expect(html).not.toContain('authorization: "Bearer "');
  });
});
