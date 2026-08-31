import { env } from "cloudflare:workers";
import { bodyPublicationResource } from "../../src/cache-publication";
import { expect, it, vi } from "vitest";
import { acquireOwnedCacheFill } from "../../src/cache-fill";
import { githubCacheKey, writeGitHubCache } from "../../src/cache";
import { queries } from "../../src/generated/sql";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import type { RelayRequest } from "../../src/types";
import { seedPool, POOL } from "./harness";
import { ownedWork } from "./owned-work";

it.each(["execution", "acknowledgment"])(
  "fences the production writer held before %s",
  async (phase) => {
    await seedPool();
    const request: RelayRequest = {
      pool: POOL,
      method: "GET",
      path: "/repos/openclaw/octopool/issues/42",
    };
    const route = classifyRoute(request, defaultPolicy("openclaw"));
    const key = await githubCacheKey(POOL, request, route);
    const coordinator = poolCoordinatorStub(env, POOL);
    const a = await acquireOwnedCacheFill(coordinator, bodyPublicationResource(key));
    expect(a.kind).toBe("owner");
    if (a.kind !== "owner") return;
    const actualEdge = caches.default;
    const edgePut = vi.fn((key: RequestInfo, value: Response) => actualEdge.put(key, value));
    vi.stubGlobal("caches", {
      default: {
        match: actualEdge.match.bind(actualEdge),
        delete: actualEdge.delete.bind(actualEdge),
        put: edgePut,
      },
    });
    const gate = ownedWork.gate();
    let started = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql !== queries.writeGitHubCache) return statement;
            return new Proxy(statement, {
              get(real, method) {
                if (method === "bind")
                  return (...values: unknown[]) => {
                    const bound = real.bind(...values);
                    return new Proxy(bound, {
                      get(actual, operation) {
                        if (operation === "run" || operation === "all" || operation === "first")
                          return async (...args: unknown[]) => {
                            const result =
                              phase === "acknowledgment"
                                ? await Reflect.apply(Reflect.get(actual, operation), actual, args)
                                : undefined;
                            started = true;
                            await gate.promise;
                            return phase === "acknowledgment"
                              ? result
                              : Reflect.apply(Reflect.get(actual, operation), actual, args);
                          };
                        const value = Reflect.get(actual, operation, actual);
                        return typeof value === "function" ? value.bind(actual) : value;
                      },
                    });
                  };
                const value = Reflect.get(real, method, real);
                return typeof value === "function" ? value.bind(real) : value;
              },
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const unregister = ownedWork.registerRelease(() => a.owner.fail());
    const pending = ownedWork.track(
      a.owner.publish(() =>
        writeGitHubCache(
          { ...env, DB: db },
          key,
          request,
          route,
          { status: 200, headers: {}, body: "old" },
          a.owner.capability,
        ),
      ),
    );
    try {
      await expect.poll(() => started).toBe(true);
      await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?")
        .bind(a.owner.capability.id)
        .run();
      const b = await acquireOwnedCacheFill(coordinator, bodyPublicationResource(key));
      expect(b.kind).toBe("owner");
      if (b.kind !== "owner") throw new Error("replacement grant missing");
      try {
        expect(
          await b.owner.publish(() =>
            writeGitHubCache(
              env,
              key,
              request,
              route,
              { status: 200, headers: {}, body: "new" },
              b.owner.capability,
            ),
          ),
        ).toEqual({ storage: "shared", completion: "accepted" });
      } finally {
        await b.owner.fail();
      }
      gate.release();
      const outcome = await pending;
      const stored = await env.DB.prepare(
        "SELECT body_json FROM github_cache_entries WHERE cache_key = ?",
      )
        .bind(key)
        .first("body_json");
      console.log("delayed execution regression", { outcome, stored });
      expect({ outcome, stored }).toEqual({
        outcome: { storage: phase === "execution" ? "rejected" : "shared", completion: "lost" },
        stored: '"new"',
      });
      // Only B puts after a rejected A mutation; a historical A commit may put.
      expect(edgePut).toHaveBeenCalledTimes(phase === "execution" ? 1 : 2);
    } finally {
      gate.release();
      await pending;
      await a.owner.fail();
      unregister();
    }
  },
);
