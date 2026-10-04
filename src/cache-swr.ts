import { backendAdmissionStub } from "./backend-admission";
import { BackendWork, admitBackendWork, assertBackendWorkActive } from "./backend-work";
import { startOwnedCacheFill, type CacheFillCoordinator } from "./cache-fill";
import type { RouteKind } from "./route-manifest";
import { parseSQLiteTimestamp } from "./sqlite-time";

export const SWR_WINDOW_SECONDS = 60;
const MAX_REFRESHES = 8;
const pending = new Set<string>();

export function supportsStaleWhileRevalidate(kind: RouteKind): boolean {
  switch (kind) {
    case "run_view":
    case "run_jobs":
    case "run_list":
    case "workflow_run_list":
    case "commit_check_runs":
    case "commit_check_runs_ref":
    case "commit_check_suites":
    case "commit_check_suites_ref":
    case "check_suite_view":
    case "check_suite_check_runs":
    case "commit_status":
    case "commit_status_ref":
    case "commit_statuses":
    case "commit_statuses_ref":
    case "job_view":
    case "pr_files":
    case "issue_comments":
    case "issue_comment_list":
    case "pr_view":
    case "contents":
      return true;
    default:
      return false;
  }
}

export function withinSWRWindow(expiresAt: string): boolean {
  const expiredFor = Date.now() - parseSQLiteTimestamp(expiresAt);
  return expiredFor >= 0 && expiredFor < SWR_WINDOW_SECONDS * 1000;
}

// Call outside the foreground BackendWork scope. No pending promise is shared
// across request lifetimes; durable ownership also coalesces across isolates.
export function scheduleCacheRefresh(
  env: Env,
  ctx: ExecutionContext,
  coordinator: CacheFillCoordinator,
  pool: string,
  cacheKey: string,
  client: string,
  refresh: () => Promise<void>,
): void {
  const limit = BackendWork.limit(env) - 1;
  if (limit < 1 || pending.size >= MAX_REFRESHES || pending.has(cacheKey)) return;
  pending.add(cacheKey);
  const backend = new BackendWork(backendAdmissionStub(env, pool), client, limit);
  ctx.waitUntil(
    backend
      .run(AbortSignal.timeout(20_000), ctx, async () => {
        try {
          // acquire is a nonblocking try; the reduced limit reserves a slot for
          // foreground work under the same caller/client admission key.
          await admitBackendWork();
          const capability = await coordinator.tryAcquirePublication(`swr:${cacheKey}`);
          if (capability === undefined) return;
          const owner = startOwnedCacheFill(coordinator, capability);
          try {
            assertBackendWorkActive();
            await refresh();
          } finally {
            await owner.fail();
          }
        } finally {
          // Count even late non-abortable storage until the work actually settles.
          pending.delete(cacheKey);
        }
      })
      .catch(() => console.error("background CI cache refresh failed or admission unavailable")),
  );
}
