import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { deleteEdgeJSON } from "../../src/edge-cache";
import { queries } from "../../src/generated/sql";
import { githubUpstream, jsonResponse, relay, seedPool } from "./harness";

describe("public repository proof expiry", () => {
  it("requires D1 historical proofs to expire strictly after the current time", async () => {
    await env.DB.prepare(
      `INSERT INTO github_public_repos (owner, repo, checked_at, expires_at)
       VALUES ('openclaw', 'octopool', datetime('now', '-10 seconds'), CURRENT_TIMESTAMP)`,
    ).run();
    const proof = await env.DB.prepare(
      `SELECT checked_at FROM github_public_repos
       WHERE owner = 'openclaw' AND repo = 'octopool'`,
    ).first<{ checked_at: string }>();
    expect(proof).not.toBeNull();

    const atExpiry = await env.DB.prepare(queries.coveringPublicRepoProof)
      .bind("openclaw", "octopool", proof!.checked_at)
      .first();
    expect(atExpiry).toBeNull();

    await env.DB.prepare(
      `UPDATE github_public_repos
       SET expires_at = datetime('now', '+1 minute')
       WHERE owner = 'openclaw' AND repo = 'octopool'`,
    ).run();
    const unexpired = await env.DB.prepare(queries.coveringPublicRepoProof)
      .bind("openclaw", "octopool", proof!.checked_at)
      .first();
    expect(unexpired).toMatchObject({ checked_at: proof!.checked_at });
  });

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
        `UPDATE github_public_repos
         SET expires_at = CURRENT_TIMESTAMP
         WHERE owner = 'openclaw' AND repo = 'octopool'`,
      ),
    ]);
    await Promise.all([
      deleteEdgeJSON("github-v1", cache!.cache_key),
      deleteEdgeJSON("public-repo-v1", "openclaw/octopool"),
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
