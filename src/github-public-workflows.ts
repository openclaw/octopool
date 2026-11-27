import { responseCapBytes } from "./github-limits";
import { decodePathStrict, encodedPathSegments, simplePageQuery } from "./github-path";
import { parseWorkflowListHTML, parseWorkflowPageHTML } from "./github-html-workflows";
import { htmlWebRequest, publicJSONResponse } from "./github-public-utils";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { defaultGitHubJSONAccept } from "./github-response";
import { fetchPublicPage } from "./github-web-transport";
import type { GitHubEgressEnv } from "./github-egress";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

const MAX_PUBLIC_WORKFLOW_PAGES = 10;

export function workflowPageRequest(
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
    (route.kind === "workflow_list" && shape === PUBLIC_SHAPES.workflowList) ||
    (route.kind === "workflow_view" && shape === PUBLIC_SHAPES.workflowView)
  ) {
    const query =
      route.kind === "workflow_list"
        ? simplePageQuery(request.query)
        : Object.keys(request.query ?? {}).length === 0
          ? { perPage: 100 }
          : undefined;
    if (query === undefined) {
      return undefined;
    }
    const workflowRef =
      route.kind === "workflow_view"
        ? decodePathStrict(/\/actions\/workflows\/([^/?#]+)$/.exec(request.path)?.[1] ?? "")
        : undefined;
    if (route.kind === "workflow_view" && workflowRef === undefined) {
      return undefined;
    }
    const url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "actions"])}`,
    );
    return htmlWebRequest(responseCapBytes(env), url.toString(), async (body, headers, status) => {
      const html = new TextDecoder().decode(body);
      const workflows = await completeWorkflowList(env, route, html);
      if (workflows === undefined) {
        return undefined;
      }
      const bodyValue =
        route.kind === "workflow_view"
          ? workflows.find(
              (workflow) =>
                String(workflow.id) === workflowRef ||
                workflow.path === `.github/workflows/${workflowRef}`,
            )
          : {
              total_count: workflows.length,
              workflows: workflows.slice(0, query.perPage),
            };
      if (bodyValue === undefined) {
        return undefined;
      }
      return publicJSONResponse(headers, status, bodyValue);
    });
  }
  return undefined;
}

async function completeWorkflowList(
  env: GitHubEgressEnv,
  route: RouteInfo,
  html: string,
): Promise<Record<string, unknown>[] | undefined> {
  const first = parseWorkflowPageHTML(html, route.owner!, route.repo!);
  if (first === undefined) return undefined;
  const { workflows } = first;
  const pageCount = first.kind === "complete" ? 1 : first.pageCount;
  if (pageCount > MAX_PUBLIC_WORKFLOW_PAGES) return undefined;
  for (let page = 2; page <= pageCount; page++) {
    const next = await fetchPublicPage(
      `https://github.com/${encodedPathSegments([
        route.owner!,
        route.repo!,
        "actions",
        "workflows_partial",
      ])}?query=&page=${page}`,
      responseCapBytes(env),
      env,
    );
    const parsed =
      next === undefined ? undefined : parseWorkflowListHTML(next, route.owner!, route.repo!);
    if (parsed === undefined) {
      return undefined;
    }
    workflows.push(...parsed);
  }
  const unique = new Set(workflows.map((workflow) => workflow.id));
  if (unique.size !== workflows.length) {
    return undefined;
  }
  return workflows.sort((left, right) => compareStrings(String(left.path), String(right.path)));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
