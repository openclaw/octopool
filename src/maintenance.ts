import { pruneExpiredGitHubCache } from "./cache";
import { pruneOldAuditEvents } from "./db";
import { pruneExpiredTerminalLogs } from "./terminal-log-cache";

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
  let cursor: string | undefined;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    try {
      const page = await pruneExpiredTerminalLogs(env, BATCH_SIZE, cursor);
      if (!page.truncated) {
        break;
      }
      cursor = page.cursor;
    } catch (error) {
      console.error("actions log cache maintenance failed", error);
      break;
    }
  }
}
