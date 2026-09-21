import { requestTimeoutMs, responseCapBytes } from "./github-limits";
import { decodeURIComponentSafe, encodedPathSegments } from "./github-path";
import {
  boundedPageSize,
  firstPageQuery,
  htmlWebRequest,
  parseJSONBytes,
  publicJSONResponse,
  scalarQuery,
  validScalarQuery,
} from "./github-public-utils";
import { defaultGitHubJSONAccept } from "./github-response";
import {
  parseActionsJobGroupsPageJSON,
  parseActionsJobHTML,
  parseActionsRunHTML,
  parseActionsRunListHTML,
  parseCommitPatchSHA,
} from "./github-html";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { fetchPublicPage, fetchWebResponse, readWebBody } from "./github-web-transport";
import { cancelResponseBody } from "./response-body";
import { transformedGitHubHeaders } from "./github-response";
import { rethrowStringRewriteDenial } from "./github-egress";
import type { GitHubEgressEnv } from "./github-egress";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

const MAX_PUBLIC_JOB_PAGES = 25;
const MAX_RUN_LIST_HYDRATIONS = 8;
const RUN_LIST_TIMEOUT_MS = 1000;

export function actionsPageRequest(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  ) {
    return undefined;
  }
  const shape = request.headers?.["x-octopool-public-shape"];
  if (
    (route.kind === "run_list" || route.kind === "workflow_run_list") &&
    shape === PUBLIC_SHAPES.actionsSummary
  ) {
    return actionsRunListRequest(env, request, route);
  }
  if (route.kind === "run_view" && shape === PUBLIC_SHAPES.actionsSummary) {
    return actionsRunRequest(env, request, route);
  }
  if (route.kind === "run_jobs" && shape === PUBLIC_SHAPES.actionsJobs) {
    return actionsRunJobsRequest(env, request, route);
  }
  return undefined;
}

function actionsRunListRequest(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  const query = actionsListQuery(request.query);
  if (query === undefined) {
    return undefined;
  }
  const workflow =
    route.kind === "workflow_run_list"
      ? /\/actions\/workflows\/([^/]+)\/runs$/.exec(request.path)?.[1]
      : undefined;
  if (route.kind === "workflow_run_list" && workflow === undefined) {
    return undefined;
  }
  const url = new URL(
    `https://github.com/${encodedPathSegments([
      route.owner!,
      route.repo!,
      "actions",
      ...(workflow === undefined ? [] : ["workflows", decodeURIComponentSafe(workflow)]),
    ])}`,
  );
  if (query.search !== "") {
    url.searchParams.set("query", query.search);
  }
  const web = htmlWebRequest(env, url.toString(), async (body, headers, status, _url, signal) => {
    const parsed = parseActionsRunListHTML(
      new TextDecoder().decode(body),
      route.owner!,
      route.repo!,
    );
    if (parsed === undefined) {
      return undefined;
    }
    // actionsListQuery rejects requests above the public page's 25-card capacity.
    if (
      parsed.workflow_runs.length <
      (parsed.capped ? Math.min(query.perPage, 25) : Math.min(parsed.total_count, query.perPage))
    ) {
      return undefined;
    }
    // Count the whole page before truncation: canonical fills select all 25 cards.
    if (parsed.workflow_runs.filter(needsRunEnrichment).length > MAX_RUN_LIST_HYDRATIONS) {
      return undefined;
    }
    const controller = new AbortController();
    const enrichmentSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    try {
      const runs = await Promise.all(
        parsed.workflow_runs.slice(0, query.perPage).map(async (run) => {
          const complete = needsRunEnrichment(run)
            ? await enrichActionsRun(env, route, run, enrichmentSignal)
            : run;
          if (complete === undefined) throw new Error("Incomplete Actions run enrichment");
          return complete;
        }),
      );
      enrichmentSignal.throwIfAborted();
      return publicJSONResponse(headers, status, {
        total_count: parsed.total_count,
        workflow_runs: runs,
      });
    } catch (error) {
      rethrowStringRewriteDenial(error);
      return undefined;
    } finally {
      controller.abort();
    }
  });
  // This includes list/redirect bodies, parsing, run pages and commit patches.
  return { ...web, timeoutMs: RUN_LIST_TIMEOUT_MS };
}

function needsRunEnrichment(run: Record<string, unknown>): boolean {
  return !isFullGitSHA(run.head_sha) || typeof run.event !== "string";
}

function actionsRunRequest(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (Object.keys(request.query ?? {}).length !== 0) {
    return undefined;
  }
  const match = /\/actions\/runs\/([0-9]+)(?:\/attempts\/([0-9]+))?$/.exec(request.path);
  const id = match?.[1];
  const attempt = match?.[2];
  if (id === undefined) {
    return undefined;
  }
  return htmlWebRequest(
    env,
    `https://github.com/${encodedPathSegments([
      route.owner!,
      route.repo!,
      "actions",
      "runs",
      id,
      ...(attempt === undefined ? [] : ["attempts", attempt]),
    ])}`,
    async (body, headers, status) => {
      const parsed = parseActionsRunHTML(
        new TextDecoder().decode(body),
        route.owner!,
        route.repo!,
        Number(id),
        attempt === undefined ? undefined : Number(attempt),
      );
      const complete =
        parsed === undefined ? undefined : await completeActionsRunSHA(env, route, parsed);
      return complete === undefined ? undefined : publicJSONResponse(headers, status, complete);
    },
  );
}

function actionsRunJobsRequest(
  env: GitHubEgressEnv,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  const match = /\/actions\/runs\/([0-9]+)\/attempts\/([0-9]+)\/jobs$/.exec(request.path);
  const id = match?.[1];
  const attempt = match?.[2];
  const query = actionsJobsQuery(request.query);
  if (id === undefined || attempt === undefined || query === undefined) {
    return undefined;
  }
  const runID = Number(id);
  const url = `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "actions", "runs", id, "job_groups_batch"])}?attempt=${attempt}`;
  const batchURL = (batch: number) => `${url}&batch=${batch}&size=1`;
  const requestHeaders = {
    accept: "application/json",
    referer: `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "actions", "runs", id])}`,
    "user-agent": "octopool",
    "x-requested-with": "XMLHttpRequest",
  };
  return {
    url: batchURL(0),
    headers: requestHeaders,
    capBytes: responseCapBytes(env),
    usesApiQuota: false,
    payload: async (body, headers, status) => {
      let page = parseActionsJobGroupsPageJSON(
        parseJSONBytes(body),
        route.owner!,
        route.repo!,
        runID,
      );
      if (
        page === undefined ||
        page.groupCount !== Math.min(1, page.totalCount) ||
        page.totalCount > MAX_PUBLIC_JOB_PAGES
      )
        return undefined;
      const total = page.totalCount;
      const summaries = [...page.jobs];
      const ids = new Set(summaries.map((job) => job.id));
      let groups = page.groupCount;
      let batches = 1;
      while (page.hasMore && batches < MAX_PUBLIC_JOB_PAGES) {
        if (groups >= total) return undefined;
        const fetched = await fetchWebResponse(
          env,
          batchURL(batches),
          requestHeaders,
          requestTimeoutMs(env),
          true,
        );
        if (fetched === undefined) return undefined;
        if (fetched.response.status !== 200) {
          await cancelResponseBody(fetched.response);
          return undefined;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readWebBody(fetched.response, responseCapBytes(env));
        } catch {
          return undefined;
        }
        page = parseActionsJobGroupsPageJSON(
          parseJSONBytes(bytes),
          route.owner!,
          route.repo!,
          runID,
        );
        if (page === undefined || page.totalCount !== total || page.groupCount !== 1)
          return undefined;
        for (const job of page.jobs) {
          if (ids.has(job.id)) return undefined;
          ids.add(job.id);
          summaries.push(job);
        }
        groups += page.groupCount;
        batches++;
      }
      if (
        page.hasMore ||
        groups !== total ||
        Math.min(summaries.length, query.perPage) > MAX_PUBLIC_JOB_PAGES
      )
        return undefined;
      const jobs = await Promise.all(
        summaries.slice(0, query.perPage).map(async (summary) => {
          const page = await fetchPublicPage(
            `https://github.com${summary.href}`,
            responseCapBytes(env),
            env,
          );
          return page === undefined
            ? undefined
            : parseActionsJobHTML(page, summary, route.owner!, route.repo!);
        }),
      );
      if (jobs.some((job) => job === undefined)) return undefined;
      const response = publicJSONResponse(headers, status, { total_count: summaries.length, jobs });
      // A group page's validators cannot describe the hydrated job pages.
      return { ...response, headers: transformedGitHubHeaders(response.headers) };
    },
  };
}

function actionsListQuery(
  query: Record<string, string | string[]> | undefined,
): { perPage: number; search: string } | undefined {
  const allowed = new Set(["per_page", "page", "branch", "status"]);
  if (!validScalarQuery(query, allowed) || !firstPageQuery(query)) {
    return undefined;
  }
  const perPage = boundedPageSize(query?.per_page, { defaultValue: 25, max: 25 });
  if (perPage === undefined) {
    return undefined;
  }
  if (scalarQuery(query, "branch") !== undefined || scalarQuery(query, "status") !== undefined) {
    return undefined;
  }
  return { perPage, search: "" };
}

function actionsJobsQuery(
  query: Record<string, string | string[]> | undefined,
): { perPage: number } | undefined {
  const allowed = new Set(["per_page", "page", "filter"]);
  if (
    !validScalarQuery(query, allowed) ||
    !firstPageQuery(query) ||
    (scalarQuery(query, "filter") !== undefined && scalarQuery(query, "filter") !== "latest")
  ) {
    return undefined;
  }
  const perPage = boundedPageSize(query?.per_page, { defaultValue: 30 });
  return perPage === undefined ? undefined : { perPage };
}

async function enrichActionsRun(
  env: GitHubEgressEnv,
  route: RouteInfo,
  run: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (
    route.owner === undefined ||
    route.repo === undefined ||
    typeof run.id !== "number" ||
    !Number.isInteger(run.id)
  ) {
    return undefined;
  }
  const page = await fetchPublicPage(
    `https://github.com/${encodedPathSegments([route.owner, route.repo, "actions", "runs", String(run.id)])}`,
    responseCapBytes(env),
    env,
    "text/html",
    { signal, timeoutMs: Math.min(requestTimeoutMs(env), 5000) },
  );
  const parsed =
    page === undefined ? undefined : parseActionsRunHTML(page, route.owner, route.repo, run.id);
  if (parsed === undefined || (typeof run.event === "string" && run.event !== parsed.event)) {
    return undefined;
  }
  const complete = await completeActionsRunSHA(env, route, { ...run, ...parsed }, signal);
  if (
    complete === undefined ||
    (typeof run.head_sha === "string" &&
      (!isFullGitSHA(complete.head_sha) ||
        !complete.head_sha.toLowerCase().startsWith(run.head_sha.toLowerCase())))
  ) {
    return undefined;
  }
  return complete;
}

async function completeActionsRunSHA(
  env: GitHubEgressEnv,
  route: RouteInfo,
  run: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (isFullGitSHA(run.head_sha)) {
    return run;
  }
  if (
    route.owner === undefined ||
    route.repo === undefined ||
    typeof run.head_sha !== "string" ||
    !/^[0-9A-Fa-f]{7,39}$/.test(run.head_sha)
  ) {
    return undefined;
  }
  const patch = await fetchPublicPage(
    `https://github.com/${encodedPathSegments([route.owner, route.repo, "commit", `${run.head_sha}.patch`])}`,
    responseCapBytes(env),
    env,
    "text/plain",
    signal === undefined ? {} : { signal },
  );
  const sha = patch === undefined ? undefined : parseCommitPatchSHA(patch, run.head_sha);
  return sha === undefined ? undefined : { ...run, head_sha: sha };
}

function isFullGitSHA(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Fa-f]{40}$/.test(value);
}
