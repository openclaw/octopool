import { PUBLIC_SHAPES } from "./github-public-shapes";
import { boundedPageSize, firstPageQuery, validScalarQuery } from "./github-public-utils";
import { transformedGitHubHeaders } from "./github-response";
import { isRecord } from "./object";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

const PUBLIC_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;
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
  const perPage = boundedPageSize(request.query.per_page, { strict: true });
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
  if (!validScalarQuery(query, allowed) || !firstPageQuery(query)) {
    return undefined;
  }
  const perPage = boundedPageSize(query.per_page, { strict: true });
  const limit = boundedPageSize(query.limit, { strict: true });
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
    headers: transformedGitHubHeaders(response.headers),
    body: {
      ...response.body,
      ...(options.preserveTotalCount === true ? {} : { total_count: filtered.length }),
      workflow_runs: filtered.slice(0, view.limit),
    },
  };
}

export function largerRunListCacheRequest(
  view: RunListSupersetView | undefined,
): RelayRequest | undefined {
  if (view?.cacheRequest.query?.per_page !== String(PUBLIC_PAGE_SIZE)) return undefined;
  return { ...view.cacheRequest, query: { page: "1", per_page: String(MAX_PAGE_SIZE) } };
}

export function projectLargerRunListPage(
  response: GitHubRelayResponse,
): GitHubRelayResponse | undefined {
  if (
    !isRecord(response.body) ||
    !Array.isArray(response.body.workflow_runs) ||
    response.body.workflow_runs.length < PUBLIC_PAGE_SIZE
  )
    return undefined;
  // Preserve the small canonical page's totals and underfill behavior: older
  // matches outside this prefix must not satisfy a filtered small-page request.
  return {
    ...response,
    body: {
      ...response.body,
      workflow_runs: response.body.workflow_runs.slice(0, PUBLIC_PAGE_SIZE),
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
    !Array.isArray(response.body.workflow_runs)
  ) {
    return false;
  }
  // A bounded public page can report only the captured page size as total_count.
  // Fewer local matches therefore never prove that older matching runs do not exist.
  return filterRuns(response.body.workflow_runs, view).length < view.limit;
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
