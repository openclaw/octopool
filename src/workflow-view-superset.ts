import { defaultGitHubJSONAccept } from "./github-response";
import { isRecord } from "./object";
import type { CachedGitHubResponse } from "./cache";
import type { RelayRequest, RouteInfo } from "./types";

type WorkflowListLookup = {
  request: RelayRequest;
  selector: string;
  filename: boolean;
  expectedURL: string;
};

export function workflowViewListLookup(
  request: RelayRequest,
  route: RouteInfo,
): WorkflowListLookup | undefined {
  if (
    route.kind !== "workflow_view" ||
    Object.keys(request.query ?? {}).length !== 0 ||
    request.headers?.["x-octopool-public-shape"] !== undefined ||
    !defaultGitHubJSONAccept(request.headers?.accept)
  )
    return undefined;
  const match = /^(.*\/actions\/workflows)\/([1-9][0-9]*|[A-Za-z0-9_.-]+\.ya?ml)$/.exec(
    request.path,
  );
  if (match === null) return undefined;
  const selector = match[2]!;
  const filename = selector.endsWith(".yml") || selector.endsWith(".yaml");
  if (!filename && !Number.isSafeInteger(Number(selector))) return undefined;
  return {
    request: { ...request, path: match[1]!, query: { page: "1", per_page: "100" } },
    selector,
    filename,
    expectedURL: `https://api.github.com${request.path}`,
  };
}

export function workflowListItem(
  cached: CachedGitHubResponse,
  { request, selector, filename, expectedURL }: WorkflowListLookup,
): Record<string, unknown> | undefined {
  if (
    cached.status !== 200 ||
    cached.body_encoding !== "json" ||
    !isRecord(cached.body) ||
    !Array.isArray(cached.body.workflows)
  )
    return undefined;
  // Numeric IDs are unique within a partial page; filenames need the complete
  // catalogue to rule out an older workflow with the same path on another page.
  if (
    filename &&
    (cached.body.total_count !== cached.body.workflows.length ||
      Object.keys(cached.headers).some((key) => key.toLowerCase() === "link"))
  )
    return undefined;
  const expectedPath = `.github/workflows/${selector}`;
  const matches = cached.body.workflows.filter(
    (item) =>
      isRecord(item) &&
      (filename
        ? item.path === expectedPath
        : String(item.id) === selector || item.url === expectedURL),
  );
  const item = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(item) ||
    !Number.isSafeInteger(item.id) ||
    Number(item.id) <= 0 ||
    (filename ? item.state !== "active" : item.id !== Number(selector)) ||
    item.url !== `https://api.github.com${request.path}/${item.id}`
  )
    return undefined;
  return item;
}
