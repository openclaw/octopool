import { PUBLIC_SHAPES } from "./github-public-shapes";
import { isRecord } from "./object";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

const PUBLIC_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;
const REPRESENTATION_HEADERS = new Set(["etag", "last-modified", "content-length", "link"]);
const SUPPORTED_RUN_STATUSES = new Set([
  "completed",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
  "in_progress",
  "queued",
  "requested",
  "waiting",
  "pending",
]);

export type RunListView = {
  branch?: string;
  status?: string;
  limit: number;
};

export type RunListSupersetView = RunListView & {
  cacheRequest: RelayRequest;
};

export function runListShapeView(request: RelayRequest, route: RouteInfo): RunListView | undefined {
  if (!actionsSummaryRunList(request, route) || request.query?.limit === undefined) {
    return undefined;
  }
  const limit = cappedPageSize(request.query.limit);
  if (limit === undefined) {
    return undefined;
  }
  const perPage = boundedPageSize(request.query.per_page);
  return { limit: Math.min(perPage ?? MAX_PAGE_SIZE, limit) };
}

export function exactRunListRequest(request: RelayRequest, route: RouteInfo): RelayRequest {
  if (!actionsSummaryRunList(request, route)) {
    return request;
  }
  const query = { ...request.query };
  const limit = cappedPageSize(query.limit);
  delete query.limit;
  if (query.per_page === undefined && limit !== undefined) {
    query.per_page = String(limit);
  }
  return { ...request, query };
}

export function runListSupersetView(
  request: RelayRequest,
  route: RouteInfo,
): RunListSupersetView | undefined {
  if (
    (route.kind !== "run_list" && route.kind !== "workflow_run_list") ||
    request.headers?.["x-octopool-public-shape"] !== PUBLIC_SHAPES.actionsSummary
  ) {
    return undefined;
  }
  const query = request.query ?? {};
  const allowed = new Set(["branch", "status", "page", "per_page", "limit"]);
  if (
    Object.entries(query).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
    ) ||
    (query.page !== undefined && query.page !== "1")
  ) {
    return undefined;
  }
  const perPage = boundedPageSize(query.per_page);
  const limit = boundedPageSize(query.limit);
  if (
    (query.per_page !== undefined && perPage === undefined) ||
    (query.limit !== undefined && limit === undefined) ||
    (typeof query.status === "string" && !SUPPORTED_RUN_STATUSES.has(query.status))
  ) {
    return undefined;
  }
  const requestedLimit = Math.min(perPage ?? MAX_PAGE_SIZE, limit ?? perPage ?? DEFAULT_PAGE_SIZE);
  const supersetPageSize =
    requestedLimit <= PUBLIC_PAGE_SIZE
      ? PUBLIC_PAGE_SIZE
      : route.kind === "run_list"
        ? MAX_PAGE_SIZE
        : undefined;
  if (supersetPageSize === undefined) {
    return undefined;
  }
  return {
    cacheRequest: {
      ...request,
      query: { page: "1", per_page: String(supersetPageSize) },
    },
    ...(typeof query.branch === "string" ? { branch: query.branch } : {}),
    ...(typeof query.status === "string" ? { status: query.status } : {}),
    limit: requestedLimit,
  };
}

export function filterRunListSuperset(
  response: GitHubRelayResponse,
  view: RunListView | undefined,
  options: { preserveTotalCount?: boolean } = {},
): GitHubRelayResponse {
  if (
    view === undefined ||
    !isRecord(response.body) ||
    !Array.isArray(response.body.workflow_runs)
  ) {
    return response;
  }
  const filtered = filterRuns(response.body.workflow_runs, view);
  return {
    ...response,
    headers: Object.fromEntries(
      Object.entries(response.headers).filter(
        ([key]) => !REPRESENTATION_HEADERS.has(key.toLowerCase()),
      ),
    ),
    body: {
      ...response.body,
      ...(options.preserveTotalCount === true ? {} : { total_count: filtered.length }),
      workflow_runs: filtered.slice(0, view.limit),
    },
  };
}

export function runListSupersetUnderfilled(
  response: GitHubRelayResponse,
  view: RunListSupersetView | undefined,
): boolean {
  if (
    view === undefined ||
    (view.branch === undefined && view.status === undefined) ||
    !isRecord(response.body) ||
    !Array.isArray(response.body.workflow_runs) ||
    typeof response.body.total_count !== "number" ||
    !Number.isSafeInteger(response.body.total_count)
  ) {
    return false;
  }
  return (
    filterRuns(response.body.workflow_runs, view).length < view.limit &&
    response.body.total_count > response.body.workflow_runs.length
  );
}

function filterRuns(runs: unknown[], view: RunListView): Record<string, unknown>[] {
  return runs.filter((item): item is Record<string, unknown> => {
    if (!isRecord(item)) {
      return false;
    }
    if (view.branch !== undefined && item.head_branch !== view.branch) {
      return false;
    }
    return (
      view.status === undefined || item.status === view.status || item.conclusion === view.status
    );
  });
}

function actionsSummaryRunList(request: RelayRequest, route: RouteInfo): boolean {
  return (
    (route.kind === "run_list" || route.kind === "workflow_run_list") &&
    request.headers?.["x-octopool-public-shape"] === PUBLIC_SHAPES.actionsSummary
  );
}

function cappedPageSize(value: string | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value) || !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_PAGE_SIZE) : undefined;
}

function boundedPageSize(value: string | string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    return undefined;
  }
  return Number(value);
}
