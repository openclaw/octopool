import { PUBLIC_SHAPES } from "./github-public-shapes";
import { boundedPageSize, firstPageQuery, validScalarQuery } from "./github-public-utils";
import { isRecord } from "./object";
import { rethrowStringRewriteDenial } from "./github-egress";
import { GitHubTransportError } from "./github";
import {
  defaultGitHubJSONAccept,
  isTransientGitHubStatus,
  transformedGitHubHeaders,
} from "./github-response";
import type { GitHubRelayResponse, RelayRequest, RouteInfo } from "./types";
import type { CachedGitHubResponse } from "./cache";

const MAX_PAGE_SIZE = 100;
const MAX_API_JOBS = 300;
const DEFAULT_PAGE_SIZE = 30;

export class RunJobsUnavailableError extends Error {
  constructor() {
    super("GitHub jobs page is temporarily unavailable");
  }
}

export type RunJobsSupersetView = {
  cacheRequest: RelayRequest;
  limit: number;
};

export function rawRunJobsSupersetView(
  request: RelayRequest,
  route: RouteInfo,
): RunJobsSupersetView | undefined {
  if (
    route.kind !== "run_jobs" ||
    request.headers?.["x-octopool-public-shape"] !== undefined ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const query = request.query ?? {};
  if (
    !validScalarQuery(query, new Set(["filter", "page", "per_page"])) ||
    !firstPageQuery(query) ||
    (query.filter !== undefined && query.filter !== "latest")
  ) {
    return undefined;
  }
  const limit = boundedPageSize(query.per_page, { strict: true, defaultValue: DEFAULT_PAGE_SIZE });
  if (limit === undefined || limit >= MAX_PAGE_SIZE) return undefined;
  return {
    cacheRequest: {
      ...request,
      query: { ...query, page: "1", per_page: String(MAX_PAGE_SIZE) },
    },
    limit,
  };
}

export function rawRunJobsAttemptLookup(request: RelayRequest, route: RouteInfo) {
  if (
    route.kind !== "run_jobs" ||
    request.headers?.["x-octopool-public-shape"] !== undefined ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  )
    return undefined;
  const query = request.query ?? {};
  const page = query.page ?? "1";
  const size = boundedPageSize(query.per_page, { strict: true, defaultValue: DEFAULT_PAGE_SIZE });
  const match =
    /^(\/repos\/[^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)(?:\/attempts\/([1-9][0-9]*))?\/jobs$/.exec(
      request.path,
    );
  if (
    !validScalarQuery(query, new Set(["filter", "page", "per_page"])) ||
    (query.filter !== undefined && query.filter !== "latest") ||
    typeof page !== "string" ||
    !/^[1-9][0-9]*$/.test(page) ||
    size === undefined ||
    match === null ||
    !Number.isSafeInteger(Number(page) * size) ||
    !Number.isSafeInteger(Number(match[2])) ||
    (match[3] !== undefined && !Number.isSafeInteger(Number(match[3])))
  )
    return undefined;
  return {
    runPath: `${match[1]}/actions/runs/${match[2]}`,
    runId: Number(match[2]),
    attempt: match[3] === undefined ? undefined : Number(match[3]),
    page: Number(page),
    size,
  };
}

export function cachedLatestRunAttempt(
  cached: CachedGitHubResponse,
  lookup: NonNullable<ReturnType<typeof rawRunJobsAttemptLookup>>,
): number | undefined {
  const run = cached.body;
  return cached.status === 200 &&
    cached.body_encoding === "json" &&
    isRecord(run) &&
    run.id === lookup.runId &&
    typeof run.url === "string" &&
    run.url.toLowerCase() === `https://api.github.com${lookup.runPath}`.toLowerCase() &&
    Number.isSafeInteger(run.run_attempt) &&
    Number(run.run_attempt) > 0
    ? Number(run.run_attempt)
    : undefined;
}

export function equivalentRunJobsRequests(
  request: RelayRequest,
  lookup: NonNullable<ReturnType<typeof rawRunJobsAttemptLookup>>,
  latest: number,
): RelayRequest[] {
  if (lookup.attempt !== undefined && lookup.attempt !== latest) return [];
  const path =
    lookup.attempt === undefined
      ? `${lookup.runPath}/attempts/${latest}/jobs`
      : `${lookup.runPath}/jobs`;
  // Attempt endpoints retain distinct omitted/explicit filter keys. Probe both
  // exact representations without changing their normal fill keys.
  return (lookup.attempt === undefined ? [undefined, "latest"] : [undefined]).map((filter) => ({
    ...request,
    path,
    query: {
      page: String(lookup.page),
      per_page: String(lookup.size),
      ...(filter === undefined ? {} : { filter }),
    },
  }));
}

export function projectEquivalentRunJobs(
  cached: CachedGitHubResponse,
  source: RelayRequest,
  target: RelayRequest,
  lookup: NonNullable<ReturnType<typeof rawRunJobsAttemptLookup>>,
  latest: number,
  proof: CachedGitHubResponse,
): CachedGitHubResponse | undefined {
  const body = cached.body;
  if (
    cached.status !== 200 ||
    cached.body_encoding !== "json" ||
    !isRecord(body) ||
    !Array.isArray(body.jobs) ||
    !Number.isSafeInteger(body.total_count) ||
    Number(body.total_count) < 0 ||
    body.jobs.length !==
      Math.min(
        lookup.size,
        Math.max(0, Number(body.total_count) - (lookup.page - 1) * lookup.size),
      ) ||
    !body.jobs.every(
      (job) => isRecord(job) && job.run_id === lookup.runId && job.run_attempt === latest,
    ) ||
    // Empty latest pages have no attempt fields. Second-resolution timestamps
    // must establish strict ordering; equal timestamps are ambiguous.
    (body.jobs.length === 0 &&
      source.path === `${lookup.runPath}/jobs` &&
      cached.created_at <= proof.created_at)
  )
    return undefined;
  const headers = transformedGitHubHeaders(cached.headers);
  const link = Object.entries(cached.headers).find(([key]) => key.toLowerCase() === "link")?.[1];
  if (link !== undefined) {
    const repository = isRecord(proof.body) ? proof.body.repository : undefined;
    const numericPath =
      isRecord(repository) && Number.isSafeInteger(repository.id) && Number(repository.id) > 0
        ? source.path.replace(/^\/repos\/[^/]+\/[^/]+/, `/repositories/${repository.id}`)
        : undefined;
    let valid = true;
    let links = 0;
    headers.link = link.replace(/<([^>]+)>/g, (_match, address: string) => {
      links++;
      try {
        const url = new URL(address);
        if (
          url.origin !== "https://api.github.com" ||
          (url.pathname.toLowerCase() !== source.path.toLowerCase() && url.pathname !== numericPath)
        ) {
          valid = false;
          return "";
        }
        url.pathname = target.path;
        url.searchParams.delete("filter");
        if (target.query?.filter === "latest") url.searchParams.set("filter", "latest");
        return `<${url}>`;
      } catch {
        valid = false;
        return "";
      }
    });
    if (!valid || links === 0) return undefined;
  }
  if (Number(body.total_count) > lookup.page * lookup.size !== hasNextJobsPage(cached))
    return undefined;
  return { ...cached, headers };
}

export function completeRawRunJobsPage(response: GitHubRelayResponse, limit: number): boolean {
  return (
    response.status === 200 &&
    response.body_encoding === "json" &&
    isRecord(response.body) &&
    Array.isArray(response.body.jobs) &&
    Number.isSafeInteger(response.body.total_count) &&
    response.body.total_count === response.body.jobs.length &&
    response.body.jobs.length <= limit &&
    !Object.keys(response.headers).some((key) => key.toLowerCase() === "link")
  );
}

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

export function runJobsSupersetHasMergedPages(
  response: GitHubRelayResponse,
  view: RunJobsSupersetView | undefined,
): boolean {
  return (
    view !== undefined &&
    isRecord(response.body) &&
    Array.isArray(response.body.jobs) &&
    response.body.jobs.length > MAX_PAGE_SIZE
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
      if (error instanceof GitHubTransportError) throw new RunJobsUnavailableError();
      return response;
    }
    if (next !== undefined && isTransientGitHubStatus(next.status)) {
      throw new RunJobsUnavailableError();
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
    // Page-one validators and framing cannot describe the merged collection.
    headers: transformedGitHubHeaders(response.headers),
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
    headers: transformedGitHubHeaders(response.headers),
    body: {
      ...response.body,
      jobs: response.body.jobs.slice(0, view.limit),
    },
  };
}
