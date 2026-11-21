import { afterEach, expect, it, vi } from "vitest";
import { backendAdmissionStub } from "../src/backend-admission";
import { scheduleCacheRefresh } from "../src/cache-swr";
import {
  cachePolicyForRouteKind,
  supportsStaleWhileRevalidate,
  withinSWRWindow,
} from "../src/cache-policy";
import { ROUTES, type RouteKind } from "../src/route-manifest";
import { fakeCacheFillCoordinator, fixtureOwner } from "./cache-fill-test-support";

vi.mock("../src/backend-admission", () => ({ backendAdmissionStub: vi.fn() }));
afterEach(() => vi.useRealTimers());

it("caps refreshes across clients at eight and frees capacity after completion", async () => {
  const admission = {
    acquire: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async (): Promise<void> => undefined),
  };
  vi.mocked(backendAdmissionStub).mockReturnValue(
    admission as unknown as ReturnType<typeof backendAdmissionStub>,
  );
  const coordinator = {
    ...fakeCacheFillCoordinator([]),
    tryAcquirePublication: vi.fn(async (resource: string) => fixtureOwner(resource, resource)),
  };
  const background: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  } as unknown as ExecutionContext;
  const gate = Promise.withResolvers<void>();
  const refresh = vi.fn(() => gate.promise);
  const schedule = (index: number) =>
    scheduleCacheRefresh(
      {} as Env,
      ctx,
      coordinator,
      "pool",
      `cache-${index}`,
      JSON.stringify(["caller", `client-${index}`]),
      refresh,
    );

  try {
    // Each client has its own admission allowance; only the isolate cap binds.
    for (let index = 0; index < 9; index++) schedule(index);
    expect(admission.acquire).toHaveBeenCalledTimes(8);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(8));
    gate.resolve();
    await Promise.all(background);

    schedule(8);
    await Promise.all(background);
    expect(refresh).toHaveBeenCalledTimes(9);
    expect(coordinator.tryAcquirePublication).toHaveBeenLastCalledWith("swr:cache-8");
  } finally {
    gate.resolve();
    while (background.length) await Promise.all(background.splice(0));
    vi.mocked(backendAdmissionStub).mockReset();
  }
});

it("bounds SWR strictly to the minute after fresh expiry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
  expect(withinSWRWindow("2026-09-29 00:00:00.001")).toBe(false);
  expect(withinSWRWindow("2026-09-29 00:00:00.000")).toBe(true);
  expect(withinSWRWindow("2026-09-28 23:59:00.001")).toBe(true);
  expect(withinSWRWindow("2026-09-28 23:59:00.000")).toBe(false);
  expect(withinSWRWindow("2026-09-28 23:58:59.999")).toBe(false);
  expect(withinSWRWindow("invalid")).toBe(false);
});

const swrKinds = new Set<RouteKind>([
  "run_view",
  "run_jobs",
  "run_list",
  "workflow_run_list",
  "commit_check_runs",
  "commit_check_runs_ref",
  "commit_check_suites",
  "commit_check_suites_ref",
  "check_suite_view",
  "check_suite_check_runs",
  "commit_status",
  "commit_status_ref",
  "commit_statuses",
  "commit_statuses_ref",
  "job_view",
  "pr_files",
  "issue_comments",
  "issue_comment_list",
  "pr_view",
  "contents",
]);

it.each([...new Set<RouteKind>([...ROUTES.map((route) => route.kind), "graphql_read"])])(
  "keeps the explicit SWR policy for %s without exposing private metadata",
  (kind) => {
    expect(supportsStaleWhileRevalidate(kind)).toBe(swrKinds.has(kind));
    expect(cachePolicyForRouteKind(kind)).not.toHaveProperty("swr");
  },
);
