import { pruneExpiredPublicationOwners } from "./cache-publication";
import { queries } from "./generated/sql";
import { pruneExpiredGitHubCache } from "./cache";
import { pruneOldAuditEvents } from "./db";

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export async function runScheduledMaintenance(env: Env): Promise<void> {
  await pruneTable("cache_publication_owners", () =>
    pruneExpiredPublicationOwners(env, BATCH_SIZE),
  );
  await pruneTable("github_public_repo_proofs", async () => {
    const result = await env.DB.prepare(queries.deleteExpiredPublicRepoProofs)
      .bind(BATCH_SIZE)
      .run();
    return result.meta.changes;
  });
  await pruneTable("github_cache_entries", () => pruneExpiredGitHubCache(env, BATCH_SIZE));
  await pruneTable("audit_events", () => pruneOldAuditEvents(env, BATCH_SIZE));
  await pruneTable("web_sessions", async () => {
    const result = await env.DB.prepare(queries.deleteExpiredWebSessions).bind(BATCH_SIZE).run();
    return result.meta.changes;
  });
  await pruneTable("github_pr_state_proofs", async () => {
    const result = await env.DB.prepare(queries.deleteExpiredPRStateProofs).bind(BATCH_SIZE).run();
    return result.meta.changes;
  });
}

async function pruneTable(table: string, prune: () => Promise<number>): Promise<void> {
  const started = Date.now();
  let deletedRows = 0;
  let batches = 0;
  let lastBatch = 0;
  let failed = false;
  try {
    while (batches < MAX_BATCHES) {
      lastBatch = await prune();
      batches++;
      deletedRows += lastBatch;
      if (lastBatch < BATCH_SIZE) break;
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A full final batch signals exhausted capacity, not a proven remaining backlog.
    console.log({
      event: "octopool.maintenance",
      table,
      deleted_rows: deletedRows,
      batches,
      budget_exhausted: batches === MAX_BATCHES && lastBatch === BATCH_SIZE,
      failed,
      duration_ms: Date.now() - started,
    });
  }
}
