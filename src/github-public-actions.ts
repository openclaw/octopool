import { responseCapBytes } from "./github-limits";
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
  parseActionsJobGroupsJSON,
  parseActionsJobHTML,
  parseActionsRunHTML,
  parseActionsRunListHTML,
  parseCommitPatchSHA,
} from "./github-html";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { fetchPublicPage } from "./github-web-transport";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

const MAX_PUBLIC_JOB_PAGES = 25;

export function actionsPageRequest(
  env: Env,
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
  env: Env,
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
  return htmlWebRequest(env, url.toString(), async (body, headers, status) => {
    const parsed = parseActionsRunListHTML(
      new TextDecoder().decode(body),
      route.owner!,
      route.repo!,
    );
    if (parsed === undefined) {
      return undefined;
    }
    if (parsed.workflow_runs.length < Math.min(parsed.total_count, query.perPage)) {
      return undefined;
    }
    parsed.workflow_runs = parsed.workflow_runs.slice(0, query.perPage);
    const runs = await Promise.all(
      parsed.workflow_runs.map((run) =>
        isFullGitSHA(run.head_sha) ? run : enrichActionsRun(env, route, run),
      ),
    );
    if (runs.some((run) => run === undefined)) {
      return undefined;
    }
    parsed.workflow_runs = runs as Record<string, unknown>[];
    return publicJSONResponse(headers, status, parsed);
  });
}

function actionsRunRequest(
  env: Env,
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
      );
      const complete =
        parsed === undefined ? undefined : await completeActionsRunSHA(env, route, parsed);
      return complete === undefined ? undefined : publicJSONResponse(headers, status, complete);
    },
  );
}

function actionsRunJobsRequest(
  env: Env,
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
  return {
    url: `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "actions", "runs", id, "job_groups_batch"])}?attempt=${attempt}`,
    headers: {
      accept: "application/json",
      referer: `https://github.com/${encodedPathSegments([route.owner!, route.repo!, "actions", "runs", id])}`,
      "user-agent": "octopool",
      "x-requested-with": "XMLHttpRequest",
    },
    capBytes: responseCapBytes(env),
    usesApiQuota: false,
    payload: async (body, headers, status) => {
      const parsed = parseJSONBytes(body);
      const summaries = parseActionsJobGroupsJSON(parsed, route.owner!, route.repo!, runID);
      if (summaries === undefined || summaries.length > MAX_PUBLIC_JOB_PAGES) {
        return undefined;
      }
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
      return jobs.some((job) => job === undefined)
        ? undefined
        : publicJSONResponse(headers, status, { total_count: summaries.length, jobs });
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
  env: Env,
  route: RouteInfo,
  run: Record<string, unknown>,
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
  );
  const parsed =
    page === undefined ? undefined : parseActionsRunHTML(page, route.owner, route.repo, run.id);
  return parsed === undefined
    ? undefined
    : completeActionsRunSHA(env, route, { ...run, ...parsed });
}

async function completeActionsRunSHA(
  env: Env,
  route: RouteInfo,
  run: Record<string, unknown>,
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
  );
  const sha = patch === undefined ? undefined : parseCommitPatchSHA(patch);
  return sha === undefined ? undefined : { ...run, head_sha: sha };
}

function isFullGitSHA(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Fa-f]{40,64}$/.test(value);
}
