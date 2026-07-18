import { pruneExpiredGitHubCache } from "./cache";
import { pruneOldAuditEvents } from "./db";

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export async function runScheduledMaintenance(env: Env): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if ((await pruneExpiredGitHubCache(env, BATCH_SIZE)) < BATCH_SIZE) {
      break;
    }
  }
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if ((await pruneOldAuditEvents(env, BATCH_SIZE)) < BATCH_SIZE) {
      break;
    }
  }
}
