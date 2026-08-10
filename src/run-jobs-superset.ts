import { PUBLIC_SHAPES } from "./github-public-shapes";
import { isRecord } from "./object";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";

const MAX_PAGE_SIZE = 100;
const MAX_API_JOBS = 300;
const DEFAULT_PAGE_SIZE = 30;
const REPRESENTATION_HEADERS = new Set(["etag", "last-modified", "content-length", "link"]);

export type RunJobsSupersetView = {
  cacheRequest: RelayRequest;
  limit: number;
};

export function runJobsSupersetView(
  request: RelayRequest,
  route: RouteInfo,
): RunJobsSupersetView | undefined {
  if (
    route.kind !== "run_jobs" ||
    request.headers?.["x-octopool-public-shape"] !== PUBLIC_SHAPES.actionsJobs
  ) {
    return undefined;
  }
  const query = request.query ?? {};
  const allowed = new Set(["filter", "page", "per_page"]);
  if (
    Object.entries(query).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
    ) ||
    (query.page !== undefined && query.page !== "1") ||
    (query.filter !== undefined && query.filter !== "latest")
  ) {
    return undefined;
  }
  const limit = pageSize(query.per_page);
  if (query.per_page !== undefined && limit === undefined) {
    return undefined;
  }
  return {
    cacheRequest: {
      ...request,
      query: { page: "1", per_page: String(MAX_PAGE_SIZE) },
    },
    limit: limit ?? DEFAULT_PAGE_SIZE,
  };
}

export function runJobsSupersetIncomplete(
  response: GitHubRelayResponse,
  view: RunJobsSupersetView | undefined,
): boolean {
  if (view === undefined || !isRecord(response.body) || !Array.isArray(response.body.jobs)) {
    return false;
  }
  const total = response.body.total_count;
  return (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total !== response.body.jobs.length
  );
}

export async function completeRunJobsSuperset(
  response: GitHubRelayResponse,
  view: RunJobsSupersetView | undefined,
  fetchPage: (request: RelayRequest) => Promise<GitHubRelayResponse | undefined>,
): Promise<GitHubRelayResponse> {
  if (
    view === undefined ||
    response.status < 200 ||
    response.status >= 300 ||
    !isRecord(response.body) ||
    !Array.isArray(response.body.jobs)
  ) {
    return response;
  }
  const total = response.body.total_count;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total <= response.body.jobs.length ||
    total > MAX_API_JOBS
  ) {
    return response;
  }

  const jobs = [...response.body.jobs];
  const pageCount = Math.ceil(total / MAX_PAGE_SIZE);
  for (let page = 2; page <= pageCount; page++) {
    let next: GitHubRelayResponse | undefined;
    try {
      next = await fetchPage({
        ...view.cacheRequest,
        query: { ...view.cacheRequest.query, page: String(page) },
      });
    } catch {
      return response;
    }
    if (
      next === undefined ||
      next.status < 200 ||
      next.status >= 300 ||
      !isRecord(next.body) ||
      next.body.total_count !== total ||
      !Array.isArray(next.body.jobs)
    ) {
      return response;
    }
    jobs.push(...next.body.jobs);
  }
  if (jobs.length !== total) {
    return response;
  }
  return {
    ...response,
    body: { ...response.body, total_count: total, jobs },
  };
}

export function filterRunJobsSuperset(
  response: GitHubRelayResponse,
  view: RunJobsSupersetView | undefined,
): GitHubRelayResponse {
  if (view === undefined || !isRecord(response.body) || !Array.isArray(response.body.jobs)) {
    return response;
  }
  return {
    ...response,
    headers: Object.fromEntries(
      Object.entries(response.headers).filter(
        ([key]) => !REPRESENTATION_HEADERS.has(key.toLowerCase()),
      ),
    ),
    body: {
      ...response.body,
      jobs: response.body.jobs.slice(0, view.limit),
    },
  };
}

function pageSize(value: string | string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    return undefined;
  }
  return Number(value);
}
