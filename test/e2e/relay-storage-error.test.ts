import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { queries } from "../../src/generated/sql";
import { HttpError } from "../../src/http";
import worker from "../../src/index";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import {
  CALLER_TOKEN,
  POOL,
  githubUpstream,
  jsonResponse,
  relay,
  runWithContext,
  seedPool,
} from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";
import { ownedWork } from "./owned-work";

const path = "/repos/openclaw/octopool/actions/runs";

async function expectStorageFallback(response: Response): Promise<void> {
  expect(response.status).toBe(424);
  const body = await response.json<{ error: { request_id: string } }>();
  expect(body).toMatchObject({
    error: { code: "fallback_local", details: { reason: "relay_storage_unavailable" } },
  });
  expect(
    await env.DB.prepare(
      "SELECT status, error_code, fallback_reason FROM audit_events WHERE request_id = ?",
    )
      .bind(body.error.request_id)
      .all(),
  ).toMatchObject({
    results: [
      { status: 424, error_code: "fallback_local", fallback_reason: "relay_storage_unavailable" },
    ],
  });
}

describe("relay storage failure boundary", () => {
  it.each(["empty", "failed"])(
    "audits cancellation only once after a late %s stale read",
    async (outcome) => {
      await seedPool();
      const staleStarted = ownedWork.gate();
      const staleGate = ownedWork.gate();
      const responseReturned = ownedWork.gate();
      const input = new AbortController();
      const DB = observePublicationD1(env.DB, {
        before: async (sql) => {
          if (sql === queries.readGitHubCache)
            throw new HttpError(503, "no_identity", "Synthetic pool failure");
          if (sql === queries.readGitHubCacheAny) {
            staleStarted.release();
            await staleGate.promise;
            if (outcome === "failed") throw new Error("D1_ERROR: Network connection lost.");
          }
        },
      });
      const pending = runWithContext(async (ctx) => {
        const response = await worker.fetch(
          new Request("https://octopool.dev/v1/github/request", {
            method: "POST",
            signal: input.signal,
            headers: {
              authorization: `Bearer ${CALLER_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ pool: POOL, method: "GET", path }),
          }),
          { ...env, DB },
          ctx,
        );
        responseReturned.release();
        expect(response.status).toBe(424);
      });
      try {
        await staleStarted.promise;
        input.abort();
        await responseReturned.promise;
      } finally {
        staleGate.release();
        await pending;
      }
      expect(
        await env.DB.prepare("SELECT error_code, fallback_reason FROM audit_events").all(),
      ).toMatchObject({
        results: [{ error_code: "fallback_local", fallback_reason: "relay_overloaded" }],
      });
    },
  );

  it.each([
    new Error("D1_ERROR: Network connection lost."),
    new Error("D1_ERROR: internal error"),
    new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued."),
  ])("audits a transient cache read failure and logs its original cause: %s", async (failure) => {
    await seedPool();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    const DB = observePublicationD1(env.DB, {
      before: async (sql) => {
        if (sql === queries.readGitHubCache) throw failure;
      },
    });
    await expectStorageFallback(await requestWithEnv({ DB }, path, {}));
    expect(logged).toHaveBeenCalledWith("relay storage unavailable", failure);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("maps publication ownership D1 failures propagated through real DO RPC", async () => {
    await seedPool();
    const stub = poolCoordinatorStub(env, POOL);
    type Observed = { env: Env; originalEnv?: Env };
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as Observed;
      target.originalEnv = target.env;
      target.env = {
        ...target.env,
        DB: observePublicationD1(target.env.DB, {
          before: async (sql) => {
            if (sql === queries.acquirePublicationOwner)
              throw new Error("D1_ERROR: Network connection lost.");
          },
        }),
      };
    });
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    try {
      await expectStorageFallback(await relay(path));
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      // A failed blockConcurrencyWhile resets the instance and breaks its stub.
      await runInDurableObject(poolCoordinatorStub(env, POOL), (instance) => {
        const target = instance as unknown as Observed;
        if (target.originalEnv !== undefined) target.env = target.originalEnv;
      });
    }
  });

  it.each(["retryable", "overloaded"])(
    "preserves an admission DO %s exception for auditing",
    async (flag) => {
      await seedPool();
      const failure = Object.assign(new Error("DO RPC unavailable"), { [flag]: true });
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      await expectStorageFallback(
        await requestWithEnv(
          {
            BACKEND_ADMISSION: {
              idFromName: env.BACKEND_ADMISSION.idFromName.bind(env.BACKEND_ADMISSION),
              get: () => ({
                acquire: async () => {
                  throw failure;
                },
                release: async () => undefined,
              }),
            },
          },
          path,
          {},
        ),
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("keeps a non-transient D1 failure as an audited 500", async () => {
    await seedPool();
    const DB = observePublicationD1(env.DB, {
      before: async (sql) => {
        if (sql === queries.readGitHubCache) throw new Error("D1_ERROR: no such table: synthetic");
      },
    });
    const response = await requestWithEnv({ DB }, path, {});
    expect(response.status).toBe(500);
    const body = await response.json<{ error: { request_id: string } }>();
    expect(body).toMatchObject({ error: { code: "internal_error" } });
    expect(
      await env.DB.prepare(
        "SELECT status, error_code, fallback_reason FROM audit_events WHERE request_id = ?",
      )
        .bind(body.error.request_id)
        .first(),
    ).toEqual({ status: 500, error_code: "internal_error", fallback_reason: null });
  });

  it("does not reinterpret GitHub 503 responses as relay storage failures", async () => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      githubUpstream({ primary: jsonResponse({ message: "Network connection lost." }, 503) }),
    );
    const response = await relay(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 503,
      body: { message: "Network connection lost." },
    });
  });

  it("does not reinterpret a GitHub transport failure as a storage failure", async () => {
    await seedPool();
    const upstream = githubUpstream({ primary: jsonResponse({}) });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (new Headers(init?.headers).get("authorization") === "Bearer test-primary-token")
          throw new Error("Network connection lost.");
        return upstream(input, init);
      }),
    );
    const response = await relay(path);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("keeps admin storage failures and relay write rejection unchanged", async () => {
    await seedPool();
    const DB = observePublicationD1(env.DB, {
      before: async () => {
        throw new Error("D1_ERROR: Network connection lost.");
      },
    });
    const response = await runWithContext((ctx) =>
      worker.fetch(
        new Request("https://octopool.dev/v1/admin/callers", {
          method: "POST",
          headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
          body: JSON.stringify({ github_login: "new-caller", pool: POOL }),
        }),
        { ...env, DB },
        ctx,
      ),
    );
    expect(response.status).toBe(500);
    const write = await runWithContext((ctx) =>
      worker.fetch(
        new Request("https://octopool.dev/v1/github/request", {
          method: "POST",
          headers: { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ pool: POOL, method: "POST", path }),
        }),
        { ...env, DB },
        ctx,
      ),
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "method_denied" } });
  });
});
