import { describe, expect, it, vi } from "vitest";
import { ensureCliCaller, ensureWebCaller } from "../src/callers";

const VERIFIED_AT = "2026-08-31T00:00:00.000Z";
const storedCaller = {
  id: "canonical-caller",
  name: "Alice",
  github_login: "alice",
  org_login: "openclaw",
};

describe("caller enrollment boundary", () => {
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
    "123",
  ])("rejects invalid new immutable ID %s before any storage call", async (id) => {
    const { env, prepare, batch } = boundaryEnv();
    await expect(
      ensureWebCaller(env, "maintainers", { id: id as number, login: "alice" }, VERIFIED_AT),
    ).rejects.toMatchObject({ status: 502 });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["CLI", "browser"])(
    "returns the canonical %s caller only after the full batch resolves",
    async (surface) => {
      const { env, batch } = boundaryEnv();
      let complete!: (value: Awaited<ReturnType<typeof batch>>) => void;
      batch.mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      let returned = false;
      const pending = enroll(env, surface).then((value) => {
        returned = true;
        return value;
      });
      try {
        await vi.waitFor(() => expect(batch).toHaveBeenCalledOnce());
        expect(returned).toBe(false);
      } finally {
        complete([{ results: [storedCaller] }]);
      }
      expect(await pending).toEqual({
        ...storedCaller,
        pool: "maintainers",
        ...(surface === "CLI" ? { client_name: "laptop" } : {}),
      });
    },
  );

  it.each(["CLI", "browser"])(
    "does not return a candidate caller on %s batch failure",
    async (surface) => {
      const { env, batch } = boundaryEnv();
      batch.mockRejectedValueOnce(new Error("synthetic batch failure"));
      await expect(enroll(env, surface)).rejects.toThrow("synthetic batch failure");
    },
  );

  it("rejects an empty batch result instead of returning its candidate UUID", async () => {
    const { env, batch } = boundaryEnv();
    batch.mockResolvedValueOnce([{ results: [] }]);
    await expect(enroll(env, "browser")).rejects.toThrow("Enrollment returned no caller");
  });
});

function enroll(env: Env, surface: string) {
  const user = { id: Number.MAX_SAFE_INTEGER, login: "alice", name: "Alice" };
  return surface === "CLI"
    ? ensureCliCaller(env, "maintainers", user, VERIFIED_AT, "synthetic-token", "laptop")
    : ensureWebCaller(env, "maintainers", user, VERIFIED_AT);
}

// Only input/result timing is mocked here. SQL and atomicity are covered by
// the real Workerd/D1 enrollment, migration and HTTP regressions.
function boundaryEnv() {
  const prepare = vi.fn(() => ({
    bind: vi.fn(() => ({ run: vi.fn(async () => ({ success: true })) })),
  }));
  const batch = vi.fn(async () => [{ results: [storedCaller] }]);
  return {
    env: {
      ALLOWED_GITHUB_ORG: "openclaw",
      DEFAULT_ALLOWED_OWNERS: "openclaw",
      DB: { prepare, batch },
    } as unknown as Env,
    prepare,
    batch,
  };
}
