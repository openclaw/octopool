import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledMaintenance } from "../src/maintenance";

const TABLES = [
  "cache_publication_owners",
  "github_public_repo_proofs",
  "github_cache_entries",
  "audit_events",
] as const;
type Table = (typeof TABLES)[number];

describe("scheduled maintenance", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prunes expired cache and old audit rows", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare: (query: string) => {
          queries.push(query);
          return {
            bind: () => ({
              all: async () => ({ results: [] }),
              run: async () => ({ meta: { changes: 0 } }),
            }),
          };
        },
      },
    } as unknown as Env;

    await runScheduledMaintenance(env);

    expect(queries).toEqual([
      expect.stringContaining("DELETE FROM cache_publication_owners"),
      expect.stringContaining("DELETE FROM github_public_repo_proofs"),
      expect.stringContaining("DELETE FROM github_cache_entries"),
      expect.stringContaining("DELETE FROM audit_events"),
    ]);
    expect(console.log).toHaveBeenCalledTimes(TABLES.length);
    for (const table of TABLES) {
      expect(console.log).toHaveBeenCalledWith({
        event: "octopool.maintenance",
        table,
        deleted_rows: 0,
        batches: 1,
        budget_exhausted: false,
        failed: false,
        duration_ms: expect.any(Number),
      });
    }
  });

  it.each(TABLES)(
    "bounds a busy %s without consuming another table's budget",
    async (busyTable) => {
      const { env, calls } = maintenanceEnv((table) => (table === busyTable ? 500 : 0));

      await runScheduledMaintenance(env);

      expect(calls.filter((table) => table === busyTable)).toHaveLength(20);
      expect(calls).toHaveLength(23);
      expect(console.log).toHaveBeenCalledWith(
        expect.objectContaining({
          table: busyTable,
          deleted_rows: 10_000,
          batches: 20,
          budget_exhausted: true,
          failed: false,
        }),
      );
      expect(console.log).toHaveBeenCalledTimes(TABLES.length);
    },
  );

  it("reports a drained backlog after the first short batch", async () => {
    const counts = [500, 500, 12];
    const { env } = maintenanceEnv((table) => (table === "audit_events" ? counts.shift()! : 0));

    await runScheduledMaintenance(env);

    expect(console.log).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "audit_events",
        deleted_rows: 1_012,
        batches: 3,
        budget_exhausted: false,
        failed: false,
      }),
    );
  });

  it("reports partial progress and preserves fail-fast errors", async () => {
    const failure = new Error("database unavailable");
    let proofBatches = 0;
    const { env, calls } = maintenanceEnv((table) => {
      if (table !== "github_public_repo_proofs") return 0;
      if (proofBatches++ === 0) return 500;
      throw failure;
    });

    await expect(runScheduledMaintenance(env)).rejects.toBe(failure);

    expect(calls).toEqual([
      "cache_publication_owners",
      "github_public_repo_proofs",
      "github_public_repo_proofs",
    ]);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        table: "github_public_repo_proofs",
        deleted_rows: 500,
        batches: 1,
        budget_exhausted: false,
        failed: true,
      }),
    );
  });
});

function maintenanceEnv(prune: (table: Table) => number): { env: Env; calls: Table[] } {
  const calls: Table[] = [];
  const env = {
    DB: {
      prepare: (query: string) => {
        const table = TABLES.find((name) => query.includes(`DELETE FROM ${name}`));
        if (table === undefined) throw new Error("Unexpected maintenance statement");
        return {
          bind: (limit: number) => {
            expect(limit).toBe(500);
            const run = () => {
              calls.push(table);
              return prune(table);
            };
            return {
              all: async () => ({ results: Array.from({ length: run() }) }),
              run: async () => ({ meta: { changes: run() } }),
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}
