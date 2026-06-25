import { describe, expect, it } from "vitest";
import { runScheduledMaintenance } from "../src/maintenance";

describe("scheduled maintenance", () => {
  it("prunes expired cache and old audit rows", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare: (query: string) => {
          queries.push(query);
          return {
            bind: () => ({
              run: async () => ({ meta: { changes: 0 } }),
            }),
          };
        },
      },
    } as unknown as Env;

    await runScheduledMaintenance(env);

    expect(queries).toEqual([
      expect.stringContaining("DELETE FROM github_cache_entries"),
      expect.stringContaining("DELETE FROM audit_events"),
    ]);
  });
});
