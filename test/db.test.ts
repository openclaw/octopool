import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config-cache";
import { loadIdentities, loadPoolPolicy, pruneOldAuditEvents } from "../src/db";
import { restrictivePolicy } from "./fixtures/stored-policy";

describe("stored pool policy loading", () => {
  beforeEach(clearConfigCache);
  afterEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  function fixture(initial: string | null) {
    let raw = initial;
    const first = vi.fn(async () => (raw === null ? null : { policy_json: raw }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    return {
      env: { ...env(prepare), DEFAULT_ALLOWED_OWNERS: "openclaw" } satisfies Env,
      first,
      set: (next: string) => {
        raw = next;
      },
    };
  }

  it("keeps a missing pool distinct from an invalid stored policy", async () => {
    const db = fixture(null);
    await expect(loadPoolPolicy(db.env, "missing")).resolves.toBeNull();
  });

  it("does not cache failed parses and reads a repair on the next lookup", async () => {
    const db = fixture("null");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(loadPoolPolicy(db.env, "maintainers")).rejects.toMatchObject({
        status: 503,
        code: "pool_policy_unavailable",
      });
    }
    db.set(JSON.stringify(restrictivePolicy));
    await expect(loadPoolPolicy(db.env, "maintainers")).resolves.toEqual(restrictivePolicy);
    await expect(loadPoolPolicy(db.env, "maintainers")).resolves.toEqual(restrictivePolicy);
    expect(db.first).toHaveBeenCalledTimes(3);
  });

  it("expires a valid policy at 30 seconds without reviving it after a parse failure", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const db = fixture(JSON.stringify(restrictivePolicy));
    await expect(loadPoolPolicy(db.env, "maintainers")).resolves.toEqual(restrictivePolicy);
    db.set("[]");
    clock.mockReturnValue(30_999);
    await expect(loadPoolPolicy(db.env, "maintainers")).resolves.toEqual(restrictivePolicy);
    expect(db.first).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(31_000);
    await expect(loadPoolPolicy(db.env, "maintainers")).rejects.toMatchObject({
      code: "pool_policy_unavailable",
    });
    db.set("{}");
    await expect(loadPoolPolicy(db.env, "maintainers")).resolves.toMatchObject({
      allow_public_repos: true,
      allow_logs: true,
    });
    expect(db.first).toHaveBeenCalledTimes(3);
  });
});

describe("identity loading", () => {
  it("uses explicitly broad public PAT identities for public-only routes", async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: [
            {
              id: "pat_public",
              kind: "pat",
              login: "steipete",
              secret_ref: "OCTOPOOL_PAT_STEIPETE",
              installation_id: null,
              weight: 100,
            },
          ],
        })),
      })),
    }));
    const identities = await loadIdentities(env(prepare), "maintainers", {
      kind: "repo_view",
      owner: "steipete",
      repo: "ReleaseBar",
      publicOnly: true,
      resource: "core",
      routeKey: "GET /repos/steipete/ReleaseBar",
      cacheable: true,
      largePayload: false,
      logs: false,
    });

    expect(identities).toEqual([
      {
        id: "pat_public",
        kind: "pat",
        login: "steipete",
        secret_ref: "OCTOPOOL_PAT_STEIPETE",
        installation_id: null,
        weight: 100,
      },
    ]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("identity_scopes.owner = '*'"));
  });
});

describe("database maintenance", () => {
  it("prunes old audit rows in bounded batches", async () => {
    let boundLimit: unknown;
    const env = {
      DB: {
        prepare: (query: string) => {
          expect(query).toContain("created_at < datetime(CURRENT_TIMESTAMP, '-30 days')");
          return {
            bind: (limit: unknown) => {
              boundLimit = limit;
              return {
                run: async () => ({ meta: { changes: 41 } }),
              };
            },
          };
        },
      },
    } as unknown as Env;

    await expect(pruneOldAuditEvents(env, 100)).resolves.toBe(41);
    expect(boundLimit).toBe(100);
  });
});

function env(prepare: ReturnType<typeof vi.fn>): Env {
  return {
    DB: { prepare },
  } as unknown as Env;
}
