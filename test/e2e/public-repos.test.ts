import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { queries } from "../../src/generated/sql";
import { githubUpstream, jsonResponse, relay, seedPool } from "./harness";
import {
  ensurePublicGitHubRepo,
  PUBLIC_PROOF_EDGE_NAMESPACE,
  storePublicRepoProof,
} from "../../src/public-repos";
import { publicProofCoordinatorStub } from "../../src/pool-coordinator";
import { proofPublicationResource } from "../../src/cache-publication";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { withGitHubEgress } from "../../src/github-egress";
import { parseSQLiteTimestamp, sqliteTimestamp } from "../../src/sqlite-time";
import { observePublicationD1 } from "./publication-d1-observer";

describe("public repository proof expiry", () => {
  it("requires D1 historical proofs to expire strictly after the current time", async () => {
    await env.DB.prepare(
      `INSERT INTO github_public_repo_proofs (protocol_epoch, owner, repo, checked_at, expires_at, is_public, publication_id, publication_token)
       VALUES ('publication-v1', 'openclaw', 'octopool', datetime('now', '-10 seconds'), CURRENT_TIMESTAMP, 1, 1, 'fixture')`,
    ).run();
    const proof = await env.DB.prepare(
      `SELECT checked_at FROM github_public_repo_proofs
       WHERE owner = 'openclaw' AND repo = 'octopool'`,
    ).first<{ checked_at: string }>();
    expect(proof).not.toBeNull();

    const atExpiry = await env.DB.prepare(queries.coveringPublicRepoProof)
      .bind("openclaw", "octopool", proof!.checked_at, "publication-v1")
      .first();
    expect(atExpiry).toBeNull();

    await env.DB.prepare(
      `UPDATE github_public_repo_proofs
       SET expires_at = datetime('now', '+1 minute')
       WHERE owner = 'openclaw' AND repo = 'octopool'`,
    ).run();
    const unexpired = await env.DB.prepare(queries.coveringPublicRepoProof)
      .bind("openclaw", "octopool", proof!.checked_at, "publication-v1")
      .first();
    expect(unexpired).toMatchObject({ checked_at: proof!.checked_at });
    await env.DB.prepare("UPDATE github_public_repo_proofs SET is_public = 0").run();
    expect(
      await env.DB.prepare(queries.coveringPublicRepoProof)
        .bind("openclaw", "octopool", proof!.checked_at, "publication-v1")
        .first(),
    ).toBeNull();
  });

  it.each([-1_000, 0, 1_000])(
    "checks Worker consumption time on an actual returned D1 row (expiry offset %s)",
    async (offset) => {
      const checkedAt = sqliteTimestamp(Date.now());
      const coordinator = publicProofCoordinatorStub(env);
      const capability = (await coordinator.tryAcquirePublication(
        proofPublicationResource("openclaw", "octopool"),
      ))!;
      expect(
        await storePublicRepoProof(env, "openclaw", "octopool", true, checkedAt, capability),
      ).toBe("shared");
      await coordinator.completePublication(capability, "shared");
      await deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
      const returned: string[] = [];
      const db = observePublicationD1(env.DB, {
        after: async (sql, _values, result) => {
          if (sql !== queries.coveringPublicRepoProof) return;
          expect(result.results).toHaveLength(1);
          const { expires_at: expiry } = result.results[0] as { expires_at: string };
          returned.push(expiry);
          // Native D1 returned this row; only JS consumption time now moves.
          vi.setSystemTime(parseSQLiteTimestamp(expiry) + offset);
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("unavailable", { status: 503 })),
      );
      const route = classifyRoute(
        { pool: "a", method: "GET", path: "/repos/openclaw/octopool" },
        defaultPolicy("openclaw"),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const result = ensurePublicGitHubRepo(
          withGitHubEgress({ ...env, DB: db }, []),
          route,
          checkedAt,
        );
        if (offset < 0) await expect(result).resolves.toBeUndefined();
        else
          await expect(result).rejects.toMatchObject({
            status: 502,
            code: "repo_public_check_failed",
          });
        expect(returned.length).toBe(offset < 0 ? 1 : 2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("fails closed at the relay when the historical proof expires", async () => {
    await seedPool();
    vi.stubGlobal(
      "fetch",
      githubUpstream({
        primary: jsonResponse({ id: 30, full_name: "openclaw/octopool", private: false }),
      }),
    );
    expect((await relay("/repos/openclaw/octopool")).status).toBe(200);

    const cache = await env.DB.prepare("SELECT cache_key FROM github_cache_entries LIMIT 1").first<{
      cache_key: string;
    }>();
    expect(cache).not.toBeNull();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE github_cache_entries
         SET expires_at = datetime('now', '-1 second'),
             stale_expires_at = datetime('now', '+1 hour')
         WHERE cache_key = ?`,
      ).bind(cache!.cache_key),
      env.DB.prepare(
        `UPDATE github_public_repo_proofs
         SET expires_at = CURRENT_TIMESTAMP
         WHERE owner = 'openclaw' AND repo = 'octopool'`,
      ),
    ]);
    await Promise.all([
      deleteEdgeJSON("github-publication-v1", cache!.cache_key),
      deleteEdgeJSON("public-repo-publication-v1", "openclaw/octopool"),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ message: "upstream unavailable" }, 503)),
    );

    const response = await relay("/repos/openclaw/octopool");
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({
      error: { code: "fallback_local", details: { reason: "repo_public_check_failed" } },
    });
  });
});
