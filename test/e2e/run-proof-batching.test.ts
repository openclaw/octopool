import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { githubCacheKey, GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { queries } from "../../src/generated/sql";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import type { RelayRequest } from "../../src/types";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { POOL, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";

describe("batched run proof lookup", () => {
  it.each(["valid", "invalid", "revoked"])(
    "validates %s candidates after prefetch",
    async (scenario) => {
      await seedPool({ secondary: true });
      const path = "/repos/openclaw/octopool/actions/runs/42";
      const request: RelayRequest = { pool: POOL, method: "GET", path, query: {} };
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      const identities = await loadIdentities(env, POOL, route);
      const keys: string[] = [];
      for (const [index, identity] of identities.entries()) {
        const key = await githubCacheKey(POOL, request, route, identity);
        keys.push(key);
        await writeOwnedGitHubCache(
          env,
          key,
          request,
          route,
          {
            status: 200,
            headers: {},
            body: {
              id: index === 0 && scenario === "invalid" ? 43 : 42,
              url: `https://api.github.com${path}`,
              run_attempt: index === 0 && scenario === "revoked" ? 3 : 2,
            },
          },
          identity,
        );
        await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
      }
      const jobsRequest: RelayRequest = {
        ...request,
        path: `${path}/attempts/2/jobs`,
        query: { page: "1", per_page: "30" },
      };
      const jobsRoute = classifyRoute(jobsRequest, defaultPolicy("openclaw"));
      await writeOwnedGitHubCache(
        env,
        await githubCacheKey(POOL, jobsRequest, jobsRoute),
        jobsRequest,
        jobsRoute,
        {
          status: 200,
          headers: {},
          body: {
            total_count: 1,
            jobs: [{ id: 1, run_id: 42, run_attempt: 2 }],
          },
        },
      );
      await seedPublicRepoProof(env, route);
      let changed = false;
      const observed = observePublicationD1(env.DB, {
        after: async (sql, values) => {
          if (
            scenario === "revoked" &&
            !changed &&
            sql === queries.readGitHubCache &&
            values[0] === keys[0]
          ) {
            changed = true;
            await env.DB.prepare("UPDATE identities SET status = 'disabled' WHERE id = ?")
              .bind(identities[0]!.id)
              .run();
          }
        },
      });
      const batches: number[] = [];
      const db = new Proxy(observed, {
        get(target, property) {
          if (property === "batch")
            return (statements: D1PreparedStatement[]) => {
              batches.push(statements.length);
              return target.batch(statements);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const response = await requestWithEnv({ DB: db }, `${path}/jobs`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        body: { total_count: 1, jobs: [{ id: 1, run_id: 42, run_attempt: 2 }] },
        relay: { cache: "hit" },
      });
      expect(batches).toContain(2);
      expect(changed).toBe(scenario === "revoked");
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});
