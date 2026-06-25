import { describe, expect, it, vi } from "vitest";
import { ensureCliCaller, ensureWebCaller } from "../src/callers";

describe("caller grants", () => {
  it("auto-enrolls verified org members for CLI login", async () => {
    const { env, statements } = mockEnv({
      activeCaller: null,
    });

    const caller = await ensureCliCaller(
      env,
      "maintainers",
      { id: 123, login: "alice", name: "Alice" },
      "2026-06-03T12:00:00.000Z",
      "op_plain",
    );

    expect(caller).toMatchObject({
      name: "Alice",
      github_login: "alice",
      org_login: "openclaw",
      pool: "maintainers",
    });
    expect(caller.id).toMatch(/^caller_/);
    expect(statements.some((statement) => statement.query.includes("INSERT INTO callers"))).toBe(
      true,
    );
    expect(
      statements.some((statement) =>
        statement.query.includes("INSERT OR IGNORE INTO caller_pools"),
      ),
    ).toBe(true);
    expect(env.DB.batch).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Object)]));
  });

  it("reuses an existing caller and grants the login pool", async () => {
    const { env, statements } = mockEnv({
      grantedCaller: null,
      activeCaller: { id: "caller_existing" },
    });

    const caller = await ensureWebCaller(
      env,
      "maintainers",
      { id: 123, login: "alice" },
      "2026-06-03T12:00:00.000Z",
    );

    expect(caller.id).toBe("caller_existing");
    expect(statements.some((statement) => statement.query.includes("UPDATE callers"))).toBe(true);
    expect(
      statements.some((statement) =>
        statement.query.includes("INSERT OR IGNORE INTO caller_pools"),
      ),
    ).toBe(true);
    expect(statements.some((statement) => statement.query.includes("INSERT INTO callers"))).toBe(
      false,
    );
  });

  it("prefers an existing caller already granted to the login pool", async () => {
    const { env, statements } = mockEnv({
      grantedCaller: { id: "caller_granted" },
      activeCaller: { id: "caller_ungranted" },
    });

    const caller = await ensureWebCaller(
      env,
      "maintainers",
      { id: 123, login: "alice" },
      "2026-06-03T12:00:00.000Z",
    );

    expect(caller.id).toBe("caller_granted");
    expect(
      statements.filter(
        (statement) =>
          statement.query.includes("FROM callers") &&
          statement.query.includes("WHERE callers.github_user_id"),
      ),
    ).toHaveLength(1);
  });
});

function mockEnv({
  grantedCaller,
  activeCaller,
}: {
  grantedCaller?: { id: string } | null;
  activeCaller: { id: string } | null;
}) {
  const statements: Array<{ query: string; args: unknown[] }> = [];
  const prepare = vi.fn((query: string) => ({
    bind: vi.fn((...args: unknown[]) => {
      const bound = {
        query,
        args,
        first: vi.fn(async () => {
          if (query.includes("JOIN caller_pools")) {
            return grantedCaller ?? null;
          }
          if (query.includes("FROM callers") && query.includes("WHERE github_user_id")) {
            return activeCaller;
          }
          return null;
        }),
        run: vi.fn(async () => ({ success: true })),
      };
      statements.push(bound);
      return bound;
    }),
  }));
  const batch = vi.fn(async () => []);
  return {
    env: {
      ALLOWED_GITHUB_ORG: "openclaw",
      DEFAULT_ALLOWED_OWNERS: "openclaw",
      DB: { prepare, batch },
    } as unknown as Env & { DB: { batch: ReturnType<typeof vi.fn> } },
    statements,
  };
}
