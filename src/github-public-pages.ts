import { responseCapBytes } from "./github-limits";
import { encodedPathSegments } from "./github-path";
import {
  boundedPageSize,
  decodePathStrict,
  firstPageQuery,
  htmlWebRequest,
  publicJSONResponse,
  scalarQuery,
  validScalarQuery,
} from "./github-public-utils";
import { defaultGitHubJSONAccept } from "./github-response";
import {
  parseIssueHTML,
  parseIssueListHTML,
  parseLabelListHTML,
  parsePullRequestHTML,
  parseReleaseHTML,
  parseWorkflowListHTML,
  parseWorkflowPageCount,
} from "./github-html";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import { fetchPublicPage } from "./github-web-transport";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

const MAX_PUBLIC_WORKFLOW_PAGES = 10;

export function summaryPageRequest(
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
  let url: URL;
  let parse: (html: string) => unknown | undefined;
  if (route.kind === "pr_view" && shape === PUBLIC_SHAPES.pullRequestSummary) {
    if (Object.keys(request.query ?? {}).length !== 0) {
      return undefined;
    }
    const number = /\/pulls\/([0-9]+)$/.exec(request.path)?.[1];
    if (number === undefined) {
      return undefined;
    }
    url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "pull", number])}`,
    );
    parse = (html) => parsePullRequestHTML(html, route.owner!, route.repo!, Number(number));
  } else if (route.kind === "issue_view" && shape === PUBLIC_SHAPES.issueSummary) {
    if (Object.keys(request.query ?? {}).length !== 0) {
      return undefined;
    }
    const number = /\/issues\/([0-9]+)$/.exec(request.path)?.[1];
    if (number === undefined) {
      return undefined;
    }
    url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "issues", number])}`,
    );
    parse = (html) => parseIssueHTML(html, route.owner!, route.repo!, Number(number));
  } else if (
    (route.kind === "issue_list" && shape === PUBLIC_SHAPES.issueList) ||
    (route.kind === "pr_list" && shape === PUBLIC_SHAPES.pullRequestList)
  ) {
    const kind = route.kind === "pr_list" ? "pr" : "issue";
    const query = issueListPageQuery(request.query, kind);
    if (query === undefined) {
      return undefined;
    }
    url = new URL(`https://github.com/${encodedPathSegments([route.owner, route.repo, "issues"])}`);
    url.searchParams.set("q", query.search);
    parse = (html) => {
      const items = parseIssueListHTML(html, route.owner!, route.repo!, kind);
      return items === undefined ? undefined : items.slice(0, query.perPage);
    };
  } else if (route.kind === "label_list" && shape === PUBLIC_SHAPES.labelList) {
    const query = simplePageQuery(request.query);
    if (query === undefined) {
      return undefined;
    }
    url = new URL(`https://github.com/${encodedPathSegments([route.owner, route.repo, "labels"])}`);
    parse = (html) => {
      const items = parseLabelListHTML(html, route.owner!, route.repo!);
      return items === undefined ? undefined : items.slice(0, query.perPage);
    };
  } else if (
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
    url = new URL(
      `https://github.com/${encodedPathSegments([route.owner, route.repo, "actions"])}`,
    );
    return htmlWebRequest(env, url.toString(), async (body, headers, status) => {
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
  } else {
    return undefined;
  }
  return htmlWebRequest(env, url.toString(), (body, headers, status) => {
    const parsed = parse(new TextDecoder().decode(body));
    return parsed === undefined ? undefined : publicJSONResponse(headers, status, parsed);
  });
}

async function completeWorkflowList(
  env: Env,
  route: RouteInfo,
  html: string,
): Promise<Record<string, unknown>[] | undefined> {
  const pageCount = parseWorkflowPageCount(html);
  const first = parseWorkflowListHTML(html, route.owner!, route.repo!);
  // Missing pagination metadata cannot prove the first page is complete.
  if (pageCount === undefined || pageCount > MAX_PUBLIC_WORKFLOW_PAGES || first === undefined) {
    return undefined;
  }
  const workflows = [...first];
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
  const unique = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  if (unique.size !== workflows.length) {
    return undefined;
  }
  return [...unique.values()].sort((left, right) =>
    compareStrings(String(left.path), String(right.path)),
  );
}

function issueListPageQuery(
  query: Record<string, string | string[]> | undefined,
  kind: "issue" | "pr",
): { perPage: number; search: string } | undefined {
  const allowed =
    kind === "issue"
      ? new Set(["per_page", "page", "state", "creator", "assignee", "labels"])
      : new Set(["per_page", "page", "state"]);
  if (!validScalarQuery(query, allowed)) {
    return undefined;
  }
  const pageQuery = simplePageQuery(query, allowed);
  if (pageQuery === undefined) {
    return undefined;
  }
  const state = scalarQuery(query, "state") ?? "open";
  if (!["open", "closed", "all"].includes(state)) {
    return undefined;
  }
  const qualifiers = [`is:${kind}`];
  if (state !== "all") {
    qualifiers.push(`state:${state}`);
  }
  for (const key of ["creator", "assignee"] as const) {
    const value = scalarQuery(query, key);
    if (value === undefined) {
      continue;
    }
    const encoded = searchQualifier(key === "creator" ? "author" : key, value);
    if (encoded === undefined) {
      return undefined;
    }
    qualifiers.push(encoded);
  }
  const labels = scalarQuery(query, "labels");
  if (labels !== undefined) {
    for (const label of labels.split(",")) {
      const encoded = searchQualifier("label", label);
      if (encoded === undefined) {
        return undefined;
      }
      qualifiers.push(encoded);
    }
  }
  return { perPage: pageQuery.perPage, search: qualifiers.join(" ") };
}

function simplePageQuery(
  query: Record<string, string | string[]> | undefined,
  allowed = new Set(["per_page", "page"]),
): { perPage: number } | undefined {
  if (!validScalarQuery(query, allowed) || !firstPageQuery(query)) {
    return undefined;
  }
  const perPage = boundedPageSize(query?.per_page, { defaultValue: 30 });
  return perPage === undefined ? undefined : { perPage };
}

function searchQualifier(key: string, value: string): string | undefined {
  if (
    value === "" ||
    value.length > 200 ||
    value.includes("\0") ||
    value.includes('"') ||
    value.includes("\\")
  ) {
    return undefined;
  }
  return `${key}:"${value}"`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function releasePageRequest(
  env: Env,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    request.headers?.["x-octopool-public-shape"] !== PUBLIC_SHAPES.releaseSummary ||
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    Object.keys(request.query ?? {}).length !== 0
  ) {
    return undefined;
  }
  let url: string;
  if (route.kind === "release_latest") {
    url = `https://github.com/${encodedPathSegments([route.owner, route.repo, "releases", "latest"])}`;
  } else if (route.kind === "release_view") {
    const encodedTag = /\/releases\/tags\/([^/?#]+)$/.exec(request.path)?.[1];
    if (encodedTag === undefined) {
      return undefined;
    }
    const tag = decodePathStrict(encodedTag);
    if (tag === undefined) {
      return undefined;
    }
    url = `https://github.com/${encodedPathSegments([route.owner, route.repo, "releases", "tag"])}/${encodeURIComponent(tag)}`;
  } else {
    return undefined;
  }
  return htmlWebRequest(env, url, (body, headers, status, responseURL) => {
    const parsed = parseReleaseHTML(
      new TextDecoder().decode(body),
      route.owner!,
      route.repo!,
      responseURL,
    );
    return parsed === undefined ? undefined : publicJSONResponse(headers, status, parsed);
  });
}
