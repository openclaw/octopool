import { decodePathStrict, encodedPathSegments, scalarQuery, simplePageQuery } from "./github-path";
import { htmlWebRequest, publicJSONResponse } from "./github-public-utils";
import {
  defaultGitHubJSONAccept,
  hasConditionalRequestHeaders,
  transformedGitHubHeaders,
} from "./github-response";
import {
  parseIssueHTML,
  parseIssueListHTML,
  parseLabelListHTML,
  parsePullRequestHTML,
} from "./github-html-embedded";
import { parseReleaseMetadataHTML } from "./github-html-releases";
import { PUBLIC_SHAPES } from "./github-public-shapes";
import type { WebRequest } from "./github-web-types";
import type { RelayRequest, RouteInfo } from "./types";

export function summaryPageRequest(
  capBytes: number,
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
  if (
    route.kind === "pr_view" &&
    (shape === PUBLIC_SHAPES.pullRequestSummary || shape === PUBLIC_SHAPES.pullRequestSummaryV1)
  ) {
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
    parse = (html) =>
      parsePullRequestHTML(
        html,
        route.owner!,
        route.repo!,
        Number(number),
        shape === PUBLIC_SHAPES.pullRequestSummary ? "v2" : "v1",
      );
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
  } else {
    return undefined;
  }
  return htmlWebRequest(capBytes, url.toString(), (body, headers, status) => {
    const parsed = parse(new TextDecoder().decode(body));
    return parsed === undefined ? undefined : publicJSONResponse(headers, status, parsed);
  });
}

function issueListPageQuery(
  query: Record<string, string | string[]> | undefined,
  kind: "issue" | "pr",
): { perPage: number; search: string } | undefined {
  const allowed =
    kind === "issue"
      ? new Set(["per_page", "page", "state", "creator", "assignee", "labels"])
      : new Set(["per_page", "page", "state"]);
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

export function releaseMetadataPageRequest(
  capBytes: number,
  request: RelayRequest,
  route: RouteInfo,
): WebRequest | undefined {
  if (
    request.method !== "GET" ||
    route.owner === undefined ||
    route.repo === undefined ||
    request.headers?.["x-octopool-public-shape"] !== PUBLIC_SHAPES.releaseMetadata ||
    !defaultGitHubJSONAccept(request.headers?.accept) ||
    Object.keys(request.query ?? {}).length !== 0 ||
    hasConditionalRequestHeaders(request.headers)
  )
    return undefined;
  let tag: string | undefined;
  let suffix = "latest";
  if (route.kind === "release_view") {
    const encodedTag = /\/releases\/tags\/([^/?#]+)$/.exec(request.path)?.[1];
    tag = encodedTag === undefined ? undefined : decodePathStrict(encodedTag);
    if (tag === undefined || tag === "") return undefined;
    suffix = `tag/${encodeURIComponent(tag)}`;
  } else if (route.kind !== "release_latest") return undefined;
  const url = `https://github.com/${encodedPathSegments([route.owner, route.repo, "releases"])}/${suffix}`;
  return htmlWebRequest(capBytes, url, (body, headers, status, responseURL) => {
    const parsed = parseReleaseMetadataHTML(
      new TextDecoder().decode(body),
      route.owner!,
      route.repo!,
      responseURL,
      tag,
    );
    if (parsed === undefined) return undefined;
    const response = publicJSONResponse(headers, status, parsed);
    return { ...response, headers: transformedGitHubHeaders(response.headers) };
  });
}
