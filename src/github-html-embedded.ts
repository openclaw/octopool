import { base64ToBytesSafe } from "./encoding";
import { plainHTML } from "./github-html-utils";
import { isRecord } from "./object";

export function parseIssueHTML(
  html: string,
  owner: string,
  repo: string,
  number: number,
): Record<string, unknown> | undefined {
  const issue = preloadedRepositoryValue(html, "IssueViewerViewQuery", "issue");
  if (
    issue === undefined ||
    issue.__typename === "PullRequest" ||
    issue.number !== number ||
    issue.url !== `https://github.com/${owner}/${repo}/issues/${number}`
  ) {
    return undefined;
  }
  const author = actorJSON(issue.author);
  const labels = labelConnectionJSON(issue.labels);
  const assignees = actorConnectionJSON(issue.assignedActors);
  if (
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    typeof issue.state !== "string" ||
    typeof issue.createdAt !== "string" ||
    typeof issue.updatedAt !== "string" ||
    author === undefined ||
    labels === undefined ||
    assignees === undefined
  ) {
    return undefined;
  }
  return {
    number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: issue.url,
    user: author,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    labels,
    assignees,
    milestone: issue.milestone ?? null,
  };
}

export function parseIssueListHTML(
  html: string,
  owner: string,
  repo: string,
  kind: "issue" | "pr",
): Record<string, unknown>[] | undefined {
  const repository = preloadedRepository(html, "IssueIndexPageQuery");
  const search = repository === undefined ? undefined : recordValue(repository.search);
  const pageInfo = search === undefined ? undefined : recordValue(search.pageInfo);
  const edges = search === undefined ? undefined : arrayValue(search.edges);
  if (
    search === undefined ||
    pageInfo === undefined ||
    edges === undefined ||
    pageInfo.hasNextPage !== false ||
    (typeof search.issueCount === "number" && search.issueCount !== edges.length)
  ) {
    return undefined;
  }
  const items: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const node = recordValue(recordValue(edge)?.node);
    if (node === undefined) {
      return undefined;
    }
    const expectedType = kind === "pr" ? "PullRequest" : "Issue";
    if (node.__typename !== expectedType || !Number.isInteger(node.number)) {
      return undefined;
    }
    const author = actorJSON(node.author);
    const labels = labelConnectionJSON(node.labels);
    const titleHTML =
      typeof node.titleHTML === "string"
        ? node.titleHTML
        : typeof node.titleHtml === "string"
          ? node.titleHtml
          : undefined;
    if (
      author === undefined ||
      labels === undefined ||
      titleHTML === undefined ||
      typeof node.createdAt !== "string" ||
      typeof node.updatedAt !== "string"
    ) {
      return undefined;
    }
    const number = node.number as number;
    if (kind === "pr") {
      if (
        typeof node.pullRequestState !== "string" ||
        typeof node.isDraft !== "boolean" ||
        (typeof node.closedAt !== "string" && node.closedAt !== null)
      ) {
        return undefined;
      }
      items.push({
        number,
        title: plainHTML(titleHTML),
        state: node.pullRequestState,
        html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
        user: author,
        created_at: node.createdAt,
        updated_at: node.updatedAt,
        closed_at: node.closedAt,
        merged_at: node.pullRequestState === "MERGED" ? node.closedAt : null,
        draft: node.isDraft,
        labels,
      });
      continue;
    }
    const assignees = actorConnectionJSON(node.assignedActors);
    if (
      typeof node.state !== "string" ||
      (typeof node.closedAt !== "string" && node.closedAt !== null) ||
      assignees === undefined
    ) {
      return undefined;
    }
    items.push({
      number,
      title: plainHTML(titleHTML),
      state: node.state,
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      user: author,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      closed_at: node.closedAt,
      labels,
      assignees,
      milestone: node.milestone ?? null,
    });
  }
  return items;
}

export function parsePullRequestHTML(
  html: string,
  owner: string,
  repo: string,
  number: number,
): Record<string, unknown> | undefined {
  const embedded = embeddedAppJSON(html);
  const payload = embedded === undefined ? undefined : recordValue(embedded.payload);
  const layout = payload === undefined ? undefined : recordValue(payload.pullRequestsLayoutRoute);
  const pullRequest = layout === undefined ? undefined : recordValue(layout.pullRequest);
  const repository = layout === undefined ? undefined : recordValue(layout.repository);
  if (
    pullRequest === undefined ||
    repository === undefined ||
    repository.ownerLogin !== owner ||
    repository.name !== repo ||
    pullRequest.number !== number ||
    typeof pullRequest.relayId !== "string" ||
    typeof pullRequest.title !== "string" ||
    typeof pullRequest.state !== "string" ||
    typeof pullRequest.createdTime !== "string" ||
    (typeof pullRequest.closedTime !== "string" && pullRequest.closedTime !== null) ||
    (typeof pullRequest.mergedTime !== "string" && pullRequest.mergedTime !== null) ||
    typeof pullRequest.headBranch !== "string" ||
    typeof pullRequest.headSha !== "string" ||
    typeof pullRequest.baseBranch !== "string"
  ) {
    return undefined;
  }
  return {
    number,
    node_id: pullRequest.relayId,
    title: pullRequest.title,
    state: pullRequest.state,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    created_at: pullRequest.createdTime,
    closed_at: pullRequest.closedTime,
    merged_at: pullRequest.mergedTime,
    head: { ref: pullRequest.headBranch, sha: pullRequest.headSha },
    base: { ref: pullRequest.baseBranch },
  };
}

export function parseRepositoryNodeIDHTML(html: string): string | undefined {
  const id = preloadedRepository(html, "IssueIndexPageQuery")?.id;
  return typeof id === "string" ? id : undefined;
}

export function parseLabelListHTML(
  html: string,
  owner: string,
  repo: string,
): Record<string, unknown>[] | undefined {
  const repository = preloadedRepository(html, "RepositoryLabelIndexPageQuery");
  const labels = repository === undefined ? undefined : recordValue(repository.labels);
  const pageInfo = labels === undefined ? undefined : recordValue(labels.pageInfo);
  const edges = labels === undefined ? undefined : arrayValue(labels.edges);
  if (
    labels === undefined ||
    pageInfo?.hasNextPage !== false ||
    edges === undefined ||
    typeof labels.totalCount !== "number" ||
    labels.totalCount !== edges.length
  ) {
    return undefined;
  }
  const items: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const label = recordValue(recordValue(edge)?.node);
    if (
      label === undefined ||
      typeof label.id !== "string" ||
      typeof label.name !== "string" ||
      typeof label.color !== "string" ||
      (typeof label.description !== "string" && label.description !== null)
    ) {
      return undefined;
    }
    items.push({
      id: label.id,
      name: label.name,
      description: label.description,
      color: label.color,
      url: `https://github.com/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`,
    });
  }
  return sortByNodeID(items);
}

function preloadedRepository(html: string, queryName: string): Record<string, unknown> | undefined {
  const embedded = embeddedAppJSON(html);
  const payload = embedded === undefined ? undefined : recordValue(embedded.payload);
  const queries = payload === undefined ? undefined : arrayValue(payload.preloadedQueries);
  if (queries === undefined) {
    return undefined;
  }
  for (const raw of queries) {
    const query = recordValue(raw);
    if (query?.queryName !== queryName) {
      continue;
    }
    const result = recordValue(query.result);
    const data = result === undefined ? undefined : recordValue(result.data);
    return data === undefined ? undefined : recordValue(data.repository);
  }
  return undefined;
}

function preloadedRepositoryValue(
  html: string,
  queryName: string,
  key: string,
): Record<string, unknown> | undefined {
  return recordValue(preloadedRepository(html, queryName)?.[key]);
}

function embeddedAppJSON(html: string): Record<string, unknown> | undefined {
  const raw =
    /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
  if (raw === undefined) {
    return undefined;
  }
  try {
    return recordValue(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function actorJSON(value: unknown): Record<string, unknown> | undefined {
  const actor = recordValue(value);
  if (actor === undefined || typeof actor.id !== "string" || typeof actor.login !== "string") {
    return undefined;
  }
  return {
    id: actor.id,
    login: actor.login,
    name: typeof actor.name === "string" ? actor.name : "",
    is_bot: actor.__typename === "Bot",
  };
}

function actorConnectionJSON(value: unknown): Record<string, unknown>[] | undefined {
  const nodes = connectionNodes(value);
  if (nodes === undefined) {
    return undefined;
  }
  const actors = nodes.map(actorJSON);
  return actors.some((actor) => actor === undefined)
    ? undefined
    : (actors as Record<string, unknown>[]);
}

function labelConnectionJSON(value: unknown): Record<string, unknown>[] | undefined {
  const nodes = connectionNodes(value);
  if (nodes === undefined) {
    return undefined;
  }
  const labels: Record<string, unknown>[] = [];
  for (const raw of nodes) {
    const label = recordValue(raw);
    if (
      label === undefined ||
      typeof label.id !== "string" ||
      typeof label.name !== "string" ||
      typeof label.color !== "string" ||
      (typeof label.description !== "string" && label.description !== null)
    ) {
      return undefined;
    }
    labels.push({
      id: label.id,
      name: label.name,
      description: label.description,
      color: label.color,
    });
  }
  return sortByNodeID(labels);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function sortByNodeID(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const decoded = items.map((item) => ({
    item,
    bytes: typeof item.id === "string" ? decodedNodeID(item.id) : undefined,
  }));
  if (decoded.some((entry) => entry.bytes === undefined)) {
    return items;
  }
  // GitHub's REST/gh label order follows creation order encoded in GraphQL node IDs.
  decoded.sort((left, right) => compareBytes(left.bytes!, right.bytes!));
  return decoded.map((entry) => entry.item);
}

function connectionNodes(value: unknown): unknown[] | undefined {
  const connection = recordValue(value);
  if (connection === undefined) {
    return undefined;
  }
  const pageInfo = recordValue(connection.pageInfo);
  if (pageInfo?.hasNextPage !== false) {
    return undefined;
  }
  const nodes = arrayValue(connection.nodes);
  if (nodes !== undefined) {
    return nodes;
  }
  const edges = arrayValue(connection.edges);
  if (edges === undefined) {
    return undefined;
  }
  const out = edges.map((edge) => recordValue(edge)?.node);
  return out.some((node) => node === undefined) ? undefined : out;
}

function decodedNodeID(value: string): Uint8Array | undefined {
  const encoded = value.includes("_") ? value.slice(value.indexOf("_") + 1) : value;
  return base64ToBytesSafe(encoded);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      return left[index]! - right[index]!;
    }
  }
  return left.length - right.length;
}
