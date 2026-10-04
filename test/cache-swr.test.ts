import { afterEach, expect, it, vi } from "vitest";
import { supportsStaleWhileRevalidate, withinSWRWindow } from "../src/cache-swr";
import type { RouteKind } from "../src/route-manifest";

vi.mock("../src/backend-admission", () => ({ backendAdmissionStub: vi.fn() }));
afterEach(() => vi.useRealTimers());

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

it.each<RouteKind>([
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
])("permits SWR for %s", (kind) => expect(supportsStaleWhileRevalidate(kind)).toBe(true));

it.each<RouteKind>(["graphql_read", "job_logs", "ref_statuses"])("excludes %s from SWR", (kind) =>
  expect(supportsStaleWhileRevalidate(kind)).toBe(false),
);
