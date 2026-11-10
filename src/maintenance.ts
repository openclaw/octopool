import { pruneExpiredPublicationOwners } from "./cache-publication";
import { queries } from "./generated/sql";

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export async function runScheduledMaintenance(env: Env): Promise<void> {
  const failures: unknown[] = [];
  const prune = async (table: string, callback: () => Promise<number>): Promise<void> => {
    try {
      await pruneTable(table, callback);
    } catch (error) {
      failures.push(error);
    }
  };
  await prune("cache_publication_owners", () => pruneExpiredPublicationOwners(env, BATCH_SIZE));
  for (const [table, query] of [
    ["github_public_repo_proofs", queries.deleteExpiredPublicRepoProofs],
    ["github_cache_entries", queries.deleteExpiredGitHubCacheBatch],
    ["audit_events", queries.deleteOldAuditEventsBatch],
    ["web_sessions", queries.deleteExpiredWebSessions],
    ["github_pr_state_proofs", queries.deleteExpiredPRStateProofs],
  ] as const) {
    await prune(table, async () => {
      const result = await env.DB.prepare(query).bind(BATCH_SIZE).run();
      return result.meta.changes;
    });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Scheduled maintenance failed for multiple tables");
  }
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
