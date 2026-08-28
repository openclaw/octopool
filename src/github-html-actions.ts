import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { decodeURIComponentSafe } from "./github-path";
import { escapeRegex, htmlAttribute } from "./github-html-utils";
import { isRecord } from "./object";

type RunState = {
  status: string;
  conclusion: string | null;
};

export type ActionsJobSummary = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  href: string;
};

export function parseActionsRunListHTML(
  html: string,
  owner: string,
  repo: string,
): { total_count: number; workflow_runs: Record<string, unknown>[] } | undefined {
  const document = actionsDocument(html);
  if (document === undefined) return undefined;
  const elements = actionsElements(document);
  const totals = elements
    .filter((element) => element.tagName === "strong")
    .map((element) => /^([0-9,]+) workflow runs?(?: results?)?$/.exec(actionsText(element)))
    .filter((match) => match !== null);
  if (totals.length > 1) return undefined;
  const total = totals[0] === undefined ? undefined : Number(totals[0][1]!.replaceAll(",", ""));
  const cards = elements.filter(isRunCard);
  if (!disjointRegions(cards)) return undefined;
  const runs: Record<string, unknown>[] = [];
  const runPath = `/${escapeRegex(owner)}/${escapeRegex(repo)}/actions/runs/`;

  for (const card of cards) {
    const contents = ownedElements(card);
    if (contents === undefined) return undefined;
    const anchor = onlyElement(
      contents.filter(
        (element) =>
          isHTMLAnchor(element) &&
          /^\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+$/.test(attribute(element, "href") ?? ""),
      ),
    );
    const idText = new RegExp(`^${runPath}([0-9]+)$`).exec(attribute(anchor, "href") ?? "")?.[1];
    const label = attribute(anchor, "aria-label");
    if (label === undefined || idText === undefined) return undefined;
    const state = runState(label);
    if (state === undefined) {
      return undefined;
    }
    const title = onlyElement(contents.filter((element) => hasClass(element, "markdown-title")));
    const workflow = onlyElement(
      contents.filter((element) => element.tagName === "span" && hasClass(element, "text-bold")),
    );
    const runNumber = /^#([0-9]+):/.exec(actionsText(adjacentNode(workflow, 1)))?.[1];
    const createdAt = attribute(
      onlyElement(contents.filter((element) => element.tagName === "relative-time")),
      "datetime",
    );
    if (
      title === undefined ||
      workflow === undefined ||
      runNumber === undefined ||
      createdAt === undefined
    ) {
      return undefined;
    }
    const id = Number(idText);
    const commit = actionsCommitSHA(contents, owner, repo);
    if (
      commit === undefined ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      runs.some((run) => run.id === id)
    ) {
      return undefined;
    }
    const branch = actionsRunBranch(contents, owner, repo, false);
    if (branch === undefined) return undefined;
    const durationIcon = onlyElement(
      contents.filter((element) => attribute(element, "aria-label") === "Run duration"),
    );
    const duration = actionsText(adjacentNode(durationIcon, 1));
    runs.push({
      id,
      name: actionsText(workflow),
      display_title: actionsText(title),
      run_number: Number(runNumber),
      status: state.status,
      conclusion: state.conclusion,
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
      head_branch: branch.name ?? null,
      head_sha: commit.sha ?? null,
      event: runEvent(actionsText(card)),
      created_at: createdAt,
      updated_at: addDuration(createdAt, duration) ?? createdAt,
    });
  }

  if (runs.length === 0 && total !== 0) {
    return undefined;
  }
  return { total_count: total ?? runs.length, workflow_runs: runs };
}

export function parseActionsRunHTML(
  html: string,
  owner: string,
  repo: string,
  id: number,
  attempt?: number,
): Record<string, unknown> | undefined {
  const document = actionsDocument(html);
  if (document === undefined) return undefined;
  const elements = actionsElements(document);
  const runPath = `/${owner}/${repo}/actions/runs/${id}`;
  const summary = onlyElement(
    elements.filter(
      (element) =>
        element.tagName === "div" && attribute(element, "aria-label") === "Workflow run summary",
    ),
  );
  const header = onlyElement(elements.filter((element) => element.tagName === "page-header"));
  const navigation = onlyElement(
    elements.filter(
      (element) =>
        element.tagName === "react-partial" &&
        attribute(element, "partial-name") === "actions-run-jobs-list",
    ),
  );
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    summary === undefined ||
    header === undefined ||
    navigation === undefined ||
    !disjointRegions([summary, header, navigation]) ||
    attribute(summary, "data-url") !== `${runPath}/summary_partial`
  ) {
    return undefined;
  }
  const contents = ownedElements(summary);
  const headerContents = ownedElements(header);
  const runAttempt = actionsRunAttempt(navigation, runPath);
  if (
    contents === undefined ||
    headerContents === undefined ||
    runAttempt === undefined ||
    (attempt !== undefined && attempt !== runAttempt)
  ) {
    return undefined;
  }
  const heading = onlyElement(
    headerContents.filter(
      (element) => element.tagName === "h1" && hasClass(element, "PageHeader-title"),
    ),
  );
  const title = onlyElement(
    actionsElements(heading).filter((element) => hasClass(element, "markdown-title")),
  );
  const workflow = onlyElement(
    headerContents.filter((element) => hasClass(element, "PageHeader-parentLink-label")),
  );
  const statusContainer = onlyElement(
    headerContents.filter((element) => hasClass(element, "actions-workflow-runs-status")),
  );
  const stateLabel = attribute(
    onlyElement(
      actionsElements(statusContainer).filter(
        (element) => attribute(element, "aria-label") !== undefined,
      ),
    ),
    "aria-label",
  );
  const state = stateLabel === undefined ? undefined : runState(stateLabel);
  const runNumber = /^#([0-9]+)$/.exec(actionsText(adjacentNode(title, 1)))?.[1];
  const timestamp = onlyElement(
    contents.filter(
      (element) =>
        element.tagName === "relative-time" &&
        /^Triggered via\s+/.test(actionsText(adjacentNode(element, -1))),
    ),
  );
  const trigger = /^Triggered via\s+(.+)$/.exec(actionsText(adjacentNode(timestamp, -1)));
  const createdAt = attribute(timestamp, "datetime");
  const sha = actionsCommitSHA(contents, owner, repo)?.sha;
  const branch = actionsRunBranch(contents, owner, repo, true);
  if (
    title === undefined ||
    workflow === undefined ||
    state === undefined ||
    runNumber === undefined ||
    trigger === null ||
    createdAt === undefined ||
    sha === undefined ||
    branch === undefined
  ) {
    return undefined;
  }
  const durationLabel = onlyElement(
    contents.filter(
      (element) => element.tagName === "span" && actionsText(element) === "Total duration",
    ),
  );
  const duration = actionsText(adjacentNode(durationLabel, 1));
  return {
    id,
    name: actionsText(workflow),
    display_title: actionsText(title),
    run_number: Number(runNumber),
    status: state.status,
    conclusion: state.conclusion,
    html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
    head_branch: branch.name ?? null,
    head_sha: sha,
    event: trigger[1]!
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
    created_at: createdAt,
    updated_at: addDuration(createdAt, duration) ?? createdAt,
    run_attempt: runAttempt,
  };
}

export function parseCommitPatchSHA(patch: string, abbreviation: string): string | undefined {
  const normalized = patch.replaceAll("\r\n", "\n");
  const envelope = /^From ([0-9A-Fa-f]{40}) Mon Sep 17 00:00:00 2001\n/.exec(normalized);
  const sha = envelope?.[1]?.toLowerCase();
  if (
    !/^[0-9A-Fa-f]{7,39}$/.test(abbreviation) ||
    sha === undefined ||
    !sha.startsWith(abbreviation.toLowerCase()) ||
    [...normalized.matchAll(/^From /gm)].length !== 1
  ) {
    return undefined;
  }
  const headerEnd = normalized.indexOf("\n\n");
  const headers = normalized.slice(envelope![0].length, headerEnd);
  const subjects = [...headers.matchAll(/^Subject: (.+(?:\n[ \t].+)*)$/gm)];
  if (
    headerEnd === -1 ||
    subjects.length !== 1 ||
    /\b[0-9]+\/[0-9]+\b/.test(subjects[0]![1]!) ||
    [...headers.matchAll(/^From: .+$/gm)].length !== 1 ||
    [...headers.matchAll(/^Date: .+$/gm)].length !== 1 ||
    !/^diff --git /m.test(normalized.slice(headerEnd + 2))
  ) {
    return undefined;
  }
  return sha;
}

export function parseActionsJobGroupsJSON(
  value: unknown,
  owner: string,
  repo: string,
  runID: number,
): ActionsJobSummary[] | undefined {
  if (!isRecord(value) || value.hasMore !== false || !Number.isInteger(value.totalCount)) {
    return undefined;
  }
  const expectedPath = `/${owner}/${repo}/actions/runs/${runID}/job/`;
  const jobs = new Map<number, ActionsJobSummary>();
  collectJobSummaries(value.jobGroups, expectedPath, jobs);
  if (jobs.size !== value.totalCount || jobs.size === 0) {
    return undefined;
  }
  return [...jobs.values()];
}

export function parseActionsJobHTML(
  html: string,
  summary: ActionsJobSummary,
  owner: string,
  repo: string,
): Record<string, unknown> | undefined {
  const steps: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<check-step\b([\s\S]*?)>/g)) {
    const attributes = match[1]!;
    const name = htmlAttribute(attributes, "data-name");
    const number = Number(htmlAttribute(attributes, "data-number"));
    const startedAt = htmlAttribute(attributes, "data-started-at");
    const completedAt = htmlAttribute(attributes, "data-completed-at");
    const conclusion = htmlAttribute(attributes, "data-conclusion");
    if (name === undefined || !Number.isInteger(number)) {
      return undefined;
    }
    steps.push({
      name,
      number,
      status:
        completedAt !== undefined
          ? "completed"
          : startedAt !== undefined
            ? "in_progress"
            : "queued",
      conclusion: conclusion ?? null,
      started_at: startedAt ?? null,
      completed_at: completedAt ?? null,
    });
  }
  const startedAt = firstTimestamp(steps, "started_at");
  const completedAt = new RegExp(
    `data-url="/${escapeRegex(owner)}/${escapeRegex(repo)}/runs/${summary.id}/header"[\\s\\S]{0,1000}?<relative-time[^>]*datetime="([^"]+)"`,
  ).exec(html)?.[1];
  if (
    (summary.status === "completed" && completedAt === undefined) ||
    (summary.status !== "queued" && steps.length === 0)
  ) {
    return undefined;
  }
  return {
    id: summary.id,
    name: summary.name,
    status: summary.status,
    conclusion: summary.conclusion,
    started_at: startedAt,
    completed_at: completedAt ?? null,
    html_url: `https://github.com${summary.href}`,
    steps,
  };
}

type ActionsElement = DefaultTreeAdapterTypes.Element;
type ActionsNode = DefaultTreeAdapterTypes.Node;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const INERT_ELEMENTS = new Set([
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

function actionsDocument(html: string): DefaultTreeAdapterTypes.Document | undefined {
  let invalid = false;
  let missingDoctype = false;
  const document = parse(html, {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === "missing-doctype") missingDoctype = true;
      else invalid = true;
    },
  });
  const elements = actionsElements(document);
  // Fragments have an implicit document scaffold; full documents must declare their mode.
  if (
    missingDoctype &&
    elements.some(
      (element) =>
        ["html", "head", "body"].includes(element.tagName) &&
        element.sourceCodeLocation !== null &&
        element.sourceCodeLocation !== undefined,
    )
  )
    invalid = true;
  // HTML accepts names such as `scr<!--x--` without a parse error. They are not
  // GitHub elements and cannot provide an ownership boundary, even as ancestors.
  if (
    elements.some(
      (element) =>
        element.namespaceURI === HTML_NAMESPACE && !/^[a-z][a-z0-9-]*$/.test(element.tagName),
    )
  )
    invalid = true;
  return invalid ? undefined : document;
}

function actionsElements(root: ActionsNode | undefined): ActionsElement[] {
  const elements: ActionsElement[] = [];
  const pending = root !== undefined && "childNodes" in root ? [...root.childNodes].reverse() : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!("tagName" in node)) continue;
    elements.push(node);
    // Keep SVG status icons, but never traverse foreign or inert content for ownership.
    if (node.namespaceURI === HTML_NAMESPACE && !INERT_ELEMENTS.has(node.tagName)) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!);
    }
  }
  return elements;
}

function actionsText(root: ActionsNode | undefined): string {
  const parts: string[] = [];
  const pending = root === undefined ? [] : [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ("value" in node) parts.push(node.value);
    else if (
      "childNodes" in node &&
      !(
        "tagName" in node &&
        (node.namespaceURI !== HTML_NAMESPACE || INERT_ELEMENTS.has(node.tagName))
      )
    ) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!);
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function attribute(element: ActionsElement | undefined, name: string): string | undefined {
  return element?.attrs.find(
    (attribute) => attribute.name === name && attribute.namespace === undefined,
  )?.value;
}

function hasClass(element: ActionsElement, name: string): boolean {
  return (
    attribute(element, "class")
      ?.split(/[\t\n\f\r ]+/)
      .includes(name) ?? false
  );
}

function onlyElement(elements: ActionsElement[]): ActionsElement | undefined {
  return elements.length === 1 ? elements[0] : undefined;
}

function adjacentNode(
  element: ActionsElement | undefined,
  direction: 1 | -1,
): ActionsNode | undefined {
  const siblings = element?.parentNode?.childNodes;
  if (element === undefined || siblings === undefined) return undefined;
  for (
    let index = siblings.indexOf(element) + direction;
    index >= 0 && index < siblings.length;
    index += direction
  ) {
    const node = siblings[index]!;
    if (node.nodeName !== "#comment" && !("value" in node && node.value.trim() === "")) return node;
  }
  return undefined;
}

function disjointRegions(regions: ActionsElement[]): boolean {
  const ordered = [...regions].sort(
    (left, right) =>
      (left.sourceCodeLocation?.startOffset ?? 0) - (right.sourceCodeLocation?.startOffset ?? 0),
  );
  return ordered.every((region, index) => {
    const location = region.sourceCodeLocation;
    return (
      region.namespaceURI === HTML_NAMESPACE &&
      location?.endTag !== undefined &&
      (index === 0 || ordered[index - 1]!.sourceCodeLocation!.endOffset <= location.startOffset)
    );
  });
}

function ownedElements(region: ActionsElement): ActionsElement[] | undefined {
  if (!disjointRegions([region])) return undefined;
  const elements = actionsElements(region);
  // parse5 can repair nesting without emitting an error. Do not use inferred closures
  // or reparented nodes inside an ownership region as evidence.
  for (const element of elements) {
    const location = element.sourceCodeLocation;
    const parent = element.parentNode;
    const parentLocation =
      parent !== null && "tagName" in parent ? parent.sourceCodeLocation : undefined;
    if (
      location === undefined ||
      location === null ||
      parentLocation?.startTag === undefined ||
      location.startOffset < parentLocation.startTag.endOffset ||
      location.endOffset > (parentLocation.endTag?.startOffset ?? parentLocation.endOffset) ||
      (element.childNodes.length > 0 &&
        element.namespaceURI === HTML_NAMESPACE &&
        location.endTag === undefined)
    )
      return undefined;
  }
  return elements;
}

function isHTMLAnchor(element: ActionsElement): boolean {
  return element.namespaceURI === HTML_NAMESPACE && element.tagName === "a";
}

function isRunCard(element: ActionsElement): boolean {
  return (
    element.tagName === "div" &&
    ["Box-row", "js-socket-channel", "js-updatable-content"].every((name) =>
      hasClass(element, name),
    )
  );
}

function actionsCommitSHA(
  elements: ActionsElement[],
  owner: string,
  repo: string,
): { sha: string | undefined } | undefined {
  const prefix = `/${owner}/${repo}/commit/`;
  let ownedSHA: string | undefined;
  for (const anchor of elements.filter(isHTMLAnchor)) {
    const href = attribute(anchor, "href");
    if (href !== undefined && /^\/[^/]+\/[^/]+\/commit\//.test(href)) {
      if (
        !href.startsWith(prefix) ||
        ownedSHA !== undefined ||
        anchor.sourceCodeLocation?.endTag === undefined
      )
        return undefined;
      const sha = href.slice(prefix.length);
      if (!/^[0-9A-Fa-f]{7,40}$/.test(sha)) return undefined;
      ownedSHA = sha.toLowerCase();
    }
  }
  return { sha: ownedSHA };
}

function actionsRunAttempt(navigation: ActionsElement, runPath: string): number | undefined {
  const elements = ownedElements(navigation);
  if (elements === undefined) return undefined;
  const script = onlyElement(
    elements.filter(
      (element) =>
        element.namespaceURI === HTML_NAMESPACE &&
        element.tagName === "script" &&
        attribute(element, "data-target") === "react-partial.embeddedData",
    ),
  );
  if (
    script?.sourceCodeLocation?.endTag === undefined ||
    script.childNodes.some((node) => !("value" in node))
  )
    return undefined;
  try {
    // Script text is JSON, never HTML and never entity-decoded.
    const data: unknown = JSON.parse(
      script.childNodes.map((node) => ("value" in node ? node.value : "")).join(""),
    );
    if (!isRecord(data) || !isRecord(data.props)) return undefined;
    const props = data.props;
    if (
      props.summaryHref !== runPath ||
      props.summarySelected !== true ||
      typeof props.jobGroupsFetchUrl !== "string"
    )
      return undefined;
    const match = new RegExp(
      `^${escapeRegex(runPath)}/job_groups_batch\\?attempt=([1-9][0-9]*)$`,
    ).exec(props.jobGroupsFetchUrl);
    const attempt = Number(match?.[1]);
    return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
  } catch {
    return undefined;
  }
}

function collectJobSummaries(
  value: unknown,
  expectedPath: string,
  out: Map<number, ActionsJobSummary>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJobSummaries(item, expectedPath, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (
    Number.isInteger(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.status === "string" &&
    (typeof value.conclusion === "string" || value.conclusion === null) &&
    typeof value.href === "string" &&
    value.href === `${expectedPath}${value.id}`
  ) {
    out.set(value.id as number, {
      id: value.id as number,
      name: value.displayName,
      status: value.status,
      conclusion: value.conclusion,
      href: value.href,
    });
  }
  for (const child of Object.values(value)) {
    collectJobSummaries(child, expectedPath, out);
  }
}

function actionsRunBranch(
  elements: ActionsElement[],
  owner: string,
  repo: string,
  allowTitle: boolean,
): { name: string | undefined } | undefined {
  const prefix = `/${owner}/${repo}/tree/refs/heads/`;
  const names = new Set<string>();
  for (const anchor of elements.filter(isHTMLAnchor)) {
    const href = attribute(anchor, "href");
    if (href?.startsWith(prefix)) {
      names.add(decodeURIComponentSafe(href.slice(prefix.length)));
    }
  }
  if (allowTitle && names.size === 0) {
    for (const anchor of elements.filter(isHTMLAnchor)) {
      const title = attribute(anchor, "title");
      if (hasClass(anchor, "branch-name") && title !== undefined) {
        const separator = title.indexOf(":");
        names.add(separator === -1 ? title : title.slice(separator + 1));
      }
    }
  }
  return names.size > 1 ? undefined : { name: [...names][0] };
}

function firstTimestamp(items: Record<string, unknown>[], field: string): string | null {
  const values = items
    .map((item) => item[field])
    .filter((value): value is string => typeof value === "string")
    .sort();
  return values[0] ?? null;
}

function runState(label: string): RunState | undefined {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes("completed successfully")) {
    return { status: "completed", conclusion: "success" };
  }
  for (const [needle, conclusion] of [
    ["cancelled", "cancelled"],
    ["failed", "failure"],
    ["timed out", "timed_out"],
    ["action required", "action_required"],
    ["neutral", "neutral"],
    ["skipped", "skipped"],
    ["stale", "stale"],
    ["startup failure", "startup_failure"],
  ] as const) {
    if (normalized.includes(needle)) {
      return { status: "completed", conclusion };
    }
  }
  for (const status of ["in progress", "queued", "waiting", "pending"] as const) {
    if (normalized.includes(status)) {
      return { status: status.replace(" ", "_"), conclusion: null };
    }
  }
  return undefined;
}

function runEvent(card: string): string | null {
  if (/\bpushed\b/i.test(card)) {
    return "push";
  }
  if (/\bpull request\b/i.test(card)) {
    return "pull_request";
  }
  if (/\bschedule(?:d)?\b/i.test(card)) {
    return "schedule";
  }
  if (/\bworkflow dispatch\b/i.test(card)) {
    return "workflow_dispatch";
  }
  return null;
}

function addDuration(date: string, duration: string | undefined): string | undefined {
  if (duration === undefined) {
    return undefined;
  }
  let seconds = 0;
  let matched = false;
  for (const match of duration.matchAll(/([0-9]+)\s*([hms])/gi)) {
    matched = true;
    const value = Number(match[1]);
    seconds +=
      match[2]!.toLowerCase() === "h"
        ? value * 3600
        : match[2]!.toLowerCase() === "m"
          ? value * 60
          : value;
  }
  const timestamp = Date.parse(date);
  return matched && Number.isFinite(timestamp)
    ? new Date(timestamp + seconds * 1000).toISOString().replace(".000Z", "Z")
    : undefined;
}
