import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { observeD1Batches } from "./d1-batch-observer";
import { githubCacheKey, GITHUB_EDGE_CACHE_NAMESPACE } from "../../src/cache";
import { loadIdentities } from "../../src/db";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { queries } from "../../src/generated/sql";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import type { RelayRequest } from "../../src/types";
import { seedPublicRepoProof, writeOwnedGitHubCache } from "./cache-publication-fixture";
import { POOL, jsonResponse, seedPool } from "./harness";
import { requestWithEnv } from "./identity-routing-support";
import { observePublicationD1 } from "./publication-d1-observer";

describe("batched run proof lookup", () => {
  it.each(["valid", "wrong run", "wrong URL", "revoked"])(
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
              id: index === 0 && scenario === "wrong run" ? 43 : 42,
              url:
                index === 0 && scenario === "wrong URL"
                  ? "https://api.github.com/repos/openclaw/octopool/actions/runs/43"
                  : `https://api.github.com${path}`,
              run_attempt: index === 0 && scenario !== "valid" ? 3 : 2,
            },
          },
          identity,
        );
        await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
      }
      for (const attempt of [2, 3]) {
        const jobsRequest: RelayRequest = {
          ...request,
          path: `${path}/attempts/${attempt}/jobs`,
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
              jobs: [{ id: attempt, run_id: 42, run_attempt: attempt }],
            },
          },
        );
      }
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
      const db = observeD1Batches(observed, (statements) => batches.push(statements.length));
      const upstream = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", upstream);
      const response = await requestWithEnv({ DB: db }, `${path}/jobs`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        body: { total_count: 1, jobs: [{ id: 2, run_id: 42, run_attempt: 2 }] },
        relay: { cache: "hit" },
      });
      expect(batches).toContain(2);
      expect(changed).toBe(scenario === "revoked");
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});

describe("batched attempt completion proof", () => {
  it.each(["first", "second form", "second identity", "revoked", "wrong attempt"])(
    "preserves completion evidence from %s",
    async (scenario) => {
      await seedPool({ secondary: true });
      const runPath = "/repos/openclaw/octopool/actions/runs/42";
      const attemptPath = `${runPath}/attempts/2`;
      const jobsPath = `${attemptPath}/jobs`;
      const headers = { "x-octopool-public-shape": "actions-summary-v1" };
      const route = classifyRoute(
        { pool: POOL, method: "GET", path: runPath, headers },
        defaultPolicy("openclaw"),
      );
      const identities = await loadIdentities(env, POOL, route);
      const keys: string[] = [];
      for (const [index, identity] of identities.entries()) {
        for (const path of [runPath, attemptPath]) {
          const request: RelayRequest = { pool: POOL, method: "GET", path, headers };
          const route = classifyRoute(request, defaultPolicy("openclaw"));
          const key = await githubCacheKey(POOL, request, route, identity);
          keys.push(key);
          const valid =
            scenario !== "wrong attempt" &&
            (scenario !== "second form" || path === attemptPath) &&
            (scenario !== "second identity" || index === 1);
          await writeOwnedGitHubCache(
            env,
            key,
            request,
            route,
            {
              status: 200,
              headers: {},
              body: { id: 42, status: "completed", run_attempt: valid ? 2 : 3 },
            },
            identity,
          );
          await deleteEdgeJSON(GITHUB_EDGE_CACHE_NAMESPACE, key);
        }
      }
      await seedPublicRepoProof(env, route);
      let revoked = false;
      const observed = observePublicationD1(env.DB, {
        after: async (sql, values) => {
          if (
            scenario === "revoked" &&
            !revoked &&
            sql === queries.readGitHubCache &&
            values[0] === keys[0]
          ) {
            revoked = true;
            await env.DB.prepare("UPDATE identities SET status = 'disabled'").run();
          }
        },
      });
      const batches: number[] = [];
      const db = observeD1Batches(observed, (statements) => batches.push(statements.length));
      const metadata: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.pathname === jobsPath)
            return jsonResponse({
              total_count: 1,
              jobs: [{ id: 1, status: "completed", conclusion: "success" }],
            });
          if (/\/actions\/runs\/42(?:\/attempts\/2)?$/.test(url.pathname))
            metadata.push(url.pathname);
          return jsonResponse({ message: "metadata unavailable" }, 503);
        }),
      );
      const response = await requestWithEnv({ DB: db }, jobsPath, {
        headers: { "x-octopool-public-shape": "actions-jobs-v1" },
        query: { per_page: "100" },
      });
      expect(response.status).toBe(200);
      expect(batches).toContain(4);
      expect(revoked).toBe(scenario === "revoked");
      const valid = scenario !== "revoked" && scenario !== "wrong attempt";
      expect(metadata.length === 0).toBe(valid);
      expect(
        await env.DB.prepare(
          "SELECT unixepoch(expires_at) - unixepoch(created_at) AS ttl FROM github_cache_entries WHERE route_kind = 'run_jobs'",
        ).first(),
      ).toEqual({ ttl: valid ? 21_600 : 60 });
    },
  );
});
