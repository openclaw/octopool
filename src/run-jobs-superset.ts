import { PUBLIC_SHAPES } from "./github-public-shapes";
import { boundedPageSize, firstPageQuery, validScalarQuery } from "./github-public-utils";
import { isRecord } from "./object";
import { rethrowStringRewriteDenial } from "./github-egress";
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
    !validScalarQuery(query, allowed) ||
    !firstPageQuery(query) ||
    (query.filter !== undefined && query.filter !== "latest")
  ) {
    return undefined;
  }
  const limit = boundedPageSize(query.per_page, { strict: true });
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
    total > MAX_API_JOBS ||
    total !== response.body.jobs.length ||
    hasNextJobsPage(response)
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
    total > MAX_API_JOBS ||
    response.body.jobs.length !== MAX_PAGE_SIZE
  ) {
    return response;
  }

  const jobs = [...response.body.jobs];
  const pageCount = Math.ceil(total / MAX_PAGE_SIZE);
  let last = response;
  for (let page = 2; page <= pageCount; page++) {
    if (
      Object.keys(last.headers).some((key) => key.toLowerCase() === "link") &&
      !hasNextJobsPage(last)
    ) {
      return response;
    }
    let next: GitHubRelayResponse | undefined;
    try {
      next = await fetchPage({
        ...view.cacheRequest,
        query: { ...view.cacheRequest.query, page: String(page) },
      });
    } catch (error) {
      rethrowStringRewriteDenial(error);
      return response;
    }
    if (
      next === undefined ||
      next.status < 200 ||
      next.status >= 300 ||
      !isRecord(next.body) ||
      next.body.total_count !== total ||
      !Array.isArray(next.body.jobs) ||
      next.body.jobs.length !== Math.min(MAX_PAGE_SIZE, total - jobs.length)
    ) {
      return response;
    }
    jobs.push(...next.body.jobs);
    last = next;
  }
  if (jobs.length !== total || hasNextJobsPage(last)) {
    return response;
  }
  return {
    ...response,
    // The first page's next link no longer describes the merged collection.
    headers: Object.fromEntries(
      Object.entries(response.headers).filter(([key]) => key.toLowerCase() !== "link"),
    ),
    body: { ...response.body, total_count: total, jobs },
  };
}

function hasNextJobsPage(response: GitHubRelayResponse): boolean {
  const link = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "link")?.[1];
  if (link === undefined) {
    return false;
  }
  for (const match of link.matchAll(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/gi)) {
    if ((match[1] ?? match[2] ?? "").toLowerCase().split(/\s+/).includes("next")) {
      return true;
    }
  }
  return false;
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
