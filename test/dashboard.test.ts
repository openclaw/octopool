import { execFileSync } from "node:child_process";
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

  it.each(["UTC", "Asia/Singapore", "America/Los_Angeles"])(
    "renders SQLite UTC ages in %s without changing zoned or invalid inputs",
    async (timezone) => {
      const html = await dashboardResponse().text();
      const helper = html.match(/function rel\(value\) \{[\s\S]*?\n\}/)?.[0];
      expect(helper).toBeDefined();
      const cases = [
        ["2026-11-26 12:00:00", "30s ago"],
        ["2026-11-26 12:00:00.500", "30s ago"],
        ["2026-11-26 11:58:30", "2m ago"],
        ["2026-11-26 10:00:30", "2h ago"],
        ["2026-11-24 12:00:00", "2026-11-24"],
        ["2026-11-26T12:00:00Z", "30s ago"],
        ["2026-11-26T20:00:00+08:00", "30s ago"],
        ["2026-11-26T04:00:00-08:00", "30s ago"],
        ["2026-11-26 12:01:00", "-30s ago"],
        ["", ""],
        [null, ""],
        ["invalid timestamp", "invalid timestamp"],
      ];
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runInNewContext } from "node:vm";
Date.now = () => Date.parse("2026-11-26T12:00:30Z");
const rel = runInNewContext(${JSON.stringify(helper)} + "; rel", { Date });
console.log(JSON.stringify(${JSON.stringify(cases)}.map(([value]) => rel(value))));`,
        ],
        { env: { ...process.env, TZ: timezone }, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual(cases.map(([, expected]) => expected));
    },
  );
});
