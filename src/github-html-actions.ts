import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { decodeURIComponentSafe } from "./github-path";
import { escapeRegex } from "./github-html-utils";
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
): { total_count: number; capped: boolean; workflow_runs: Record<string, unknown>[] } | undefined {
  const document = actionsDocument(html);
  if (document === undefined) return undefined;
  const elements = actionsElements(document);
  const totalElements = elements.filter(
    (element) => element.tagName === "strong" && /workflow runs?/.test(actionsText(element)),
  );
  if (totalElements.some((element) => ownedElements(element) === undefined)) return undefined;
  const totalElement = responsiveElement(totalElements, ["d-lg-none", "d-lg-block"], actionsText);
  const count = /^([0-9,]+)(\+)? workflow runs?(?: results?)?$/.exec(actionsText(totalElement));
  const total = Number(count?.[1]?.replaceAll(",", ""));
  if (
    totalElement === undefined ||
    ownedElements(totalElement) === undefined ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    return undefined;
  const capped =
    count?.[2] === "+" ||
    elements.some((element) => attribute(element, "count_is_capped") === "true");
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
      contents.filter(
        (element) =>
          element.tagName === "span" &&
          hasClass(element, "text-bold") &&
          !hasClass(element, "markdown-title"),
      ),
    );
    const timestamp = responsiveElement(
      contents.filter((element) => element.tagName === "relative-time"),
      ["d-md-none", "d-md-block"],
      (element) => attribute(element, "datetime"),
    );
    const trigger = actionsListTrigger(workflow, timestamp, owner, repo);
    const createdAt = attribute(timestamp, "datetime");
    if (
      title === undefined ||
      workflow === undefined ||
      trigger === undefined ||
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
    const durationIcons = contents.filter(
      (element) => attribute(element, "aria-label") === "Run duration",
    );
    const durationIcon = responsiveElement(durationIcons, ["d-md-none", "d-md-block"], (element) =>
      actionsText(adjacentNode(element, 1)),
    );
    if (durationIcons.length > 0 && durationIcon === undefined) return undefined;
    const duration = actionsText(adjacentNode(durationIcon, 1));
    runs.push({
      id,
      name: actionsText(workflow),
      display_title: actionsText(title),
      run_number: trigger.runNumber,
      status: state.status,
      conclusion: state.conclusion,
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
      head_branch: branch.name ?? null,
      head_sha: commit.sha ?? null,
      event: trigger.event,
      created_at: createdAt,
      updated_at: addDuration(createdAt, duration) ?? createdAt,
    });
  }

  if (runs.length === 0 && total !== 0) {
    return undefined;
  }
  if (!capped && runs.length > total) return undefined;
  return { total_count: total, capped, workflow_runs: runs };
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
  // Navigation dialogs repeat the title and contain repaired error placeholders.
  // Header controls are not metadata; validate the retained header subtree only.
  const headerContents = ownedElements(header, (element) => {
    const parent = element.parentNode;
    return (
      (hasClass(element, "PageHeader-navigation") && parent === header) ||
      (hasClass(element, "PageHeader-actions") &&
        parent !== null &&
        "tagName" in parent &&
        hasClass(parent, "PageHeader-titleBar") &&
        parent.parentNode === header)
    );
  });
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
    responsiveElement(
      actionsElements(statusContainer).filter(
        (element) => attribute(element, "aria-label") !== undefined,
      ),
      ["hide-sm", "hide-lg"],
      (element) => attribute(element, "aria-label"),
    ),
    "aria-label",
  );
  const state = stateLabel === undefined ? undefined : runState(stateLabel);
  const runNumber = /^#([0-9]+)$/.exec(actionsText(adjacentNode(title, 1)))?.[1];
  const timestamp = onlyElement(
    contents.filter(
      (element) =>
        element.tagName === "relative-time" &&
        /^(?:Triggered via\s+.+|Manually triggered)$/.test(actionsText(adjacentNode(element, -1))),
    ),
  );
  const triggerText = actionsText(adjacentNode(timestamp, -1));
  const trigger = /^Triggered via\s+(.+)$/.exec(triggerText);
  const event = actionsRunEvent(elements, runPath, [summary, header, navigation], trigger?.[1]);
  const createdAt = attribute(timestamp, "datetime");
  const sha = actionsCommitSHA(contents, owner, repo)?.sha;
  const branch = actionsRunBranch(contents, owner, repo, true);
  if (
    title === undefined ||
    workflow === undefined ||
    state === undefined ||
    runNumber === undefined ||
    event === undefined ||
    (triggerText === "Manually triggered" && event !== "workflow_dispatch") ||
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
    event,
    created_at: createdAt,
    updated_at: addDuration(createdAt, duration) ?? createdAt,
    run_attempt: runAttempt,
  };
}

// Canonical event names documented by GitHub; unknown graph values fall back to REST.
const ACTIONS_EVENTS = new Set([
  "branch_protection_rule",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "fork",
  "gollum",
  "image_version",
  "issue_comment",
  "issues",
  "label",
  "merge_group",
  "milestone",
  "page_build",
  "public",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
  "push",
  "registry_package",
  "release",
  "repository_dispatch",
  "schedule",
  "status",
  "watch",
  "workflow_call",
  "workflow_dispatch",
  "workflow_run",
]);

const ACTIONS_TRIGGER_PROSE = new Map([
  ["push", "push"],
  ["pull request", "pull_request"],
]);

function actionsRunEvent(
  elements: ActionsElement[],
  runPath: string,
  regions: ActionsElement[],
  prose: string | undefined,
): string | undefined {
  const proseEvent = ACTIONS_TRIGGER_PROSE.get(prose?.trim().toLowerCase() ?? "");
  const graphs = elements.filter(
    (element) =>
      element.tagName === "div" && attribute(element, "aria-label") === "Workflow run graph",
  );
  if (graphs.length === 0) return proseEvent;
  const graph = onlyElement(graphs);
  if (
    graph === undefined ||
    attribute(graph, "data-url") !== `${runPath}/graph_partial` ||
    !disjointRegions([...regions, graph])
  )
    return undefined;
  const contents = ownedElements(graph);
  if (contents === undefined) return undefined;
  const workflow = onlyElement(
    contents.filter(
      (element) => isHTMLAnchor(element) && attribute(element, "href") === `${runPath}/workflow`,
    ),
  );
  const heading = workflow?.parentNode;
  if (
    heading === null ||
    heading === undefined ||
    !("tagName" in heading) ||
    heading.tagName !== "h2"
  )
    return undefined;
  const label = adjacentNode(heading, 1);
  if (
    label === undefined ||
    !("tagName" in label) ||
    label.tagName !== "div" ||
    !hasClass(label, "text-small") ||
    !hasClass(label, "color-fg-muted")
  )
    return undefined;
  const siblings = heading.parentNode?.childNodes.filter(
    (node) => node.nodeName !== "#comment" && !("value" in node && node.value.trim() === ""),
  );
  if (
    siblings?.length !== 2 ||
    siblings[0] !== heading ||
    siblings[1] !== label ||
    label.childNodes.some((node) => node.nodeName !== "#text")
  )
    return undefined;
  // This run-owned graph label is exact; summary prose such as "issue" is not.
  const event = /^on: ([a-z_]+)$/.exec(actionsText(label))?.[1];
  return event !== undefined &&
    ACTIONS_EVENTS.has(event) &&
    (proseEvent === undefined || proseEvent === event)
    ? event
    : undefined;
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
  const page = parseActionsJobGroupsPageJSON(value, owner, repo, runID);
  return page !== undefined && !page.hasMore && page.groupCount === page.totalCount
    ? page.jobs
    : undefined;
}

export function parseActionsJobGroupsPageJSON(
  value: unknown,
  owner: string,
  repo: string,
  runID: number,
):
  | { jobs: ActionsJobSummary[]; groupCount: number; totalCount: number; hasMore: boolean }
  | undefined {
  if (
    !isRecord(value) ||
    typeof value.hasMore !== "boolean" ||
    typeof value.totalCount !== "number" ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < 0 ||
    !Array.isArray(value.jobGroups) ||
    value.jobGroups.length > value.totalCount
  )
    return undefined;
  const expectedPath = `/${owner}/${repo}/actions/runs/${runID}/job/`;
  const jobs = new Map<number, ActionsJobSummary>();
  for (const group of value.jobGroups) {
    const before = jobs.size;
    if (!collectJobSummaries(group, expectedPath, jobs) || jobs.size === before) return undefined;
  }
  if (value.hasMore && (value.jobGroups.length === 0 || value.jobGroups.length >= value.totalCount))
    return undefined;
  return {
    jobs: [...jobs.values()],
    groupCount: value.jobGroups.length,
    totalCount: value.totalCount,
    hasMore: value.hasMore,
  };
}

export function parseActionsJobHTML(
  html: string,
  summary: ActionsJobSummary,
  owner: string,
  repo: string,
): Record<string, unknown> | undefined {
  const document = actionsDocument(html);
  if (document === undefined) return undefined;
  const pageElements = actionsElements(document);
  const navigation = onlyElement(
    pageElements.filter(
      (element) =>
        element.tagName === "react-partial" &&
        attribute(element, "partial-name") === "actions-run-jobs-list",
    ),
  );
  const props = navigation === undefined ? undefined : actionsNavigationProps(navigation);
  const region = onlyElement(
    pageElements.filter(
      (element) =>
        element.tagName === "section" &&
        attribute(element, "aria-label") === "Check run summary" &&
        hasClass(element, "js-selected-check-run"),
    ),
  );
  const elements = region === undefined ? undefined : ownedElements(region);
  if (
    props === undefined ||
    props.summarySelected !== false ||
    props.selectedJobId !== summary.id ||
    typeof props.summaryHref !== "string" ||
    !new RegExp(`^/${escapeRegex(owner)}/${escapeRegex(repo)}/actions/runs/[1-9][0-9]*$`).test(
      props.summaryHref,
    ) ||
    summary.href !== `${props.summaryHref}/job/${summary.id}` ||
    elements === undefined ||
    navigation === undefined ||
    region === undefined ||
    !disjointRegions([navigation, region])
  )
    return undefined;
  if (summary.status === "completed" && summary.conclusion === "skipped") {
    if (
      [region, ...elements].some(
        (element) =>
          ["check-step", "check-steps", "relative-time"].includes(element.tagName) ||
          attribute(element, "datetime") !== undefined ||
          attribute(element, "data-started-at") !== undefined ||
          attribute(element, "data-completed-at") !== undefined ||
          /\/runs\/[0-9]+\/header/.test(attribute(element, "data-url") ?? ""),
      ) ||
      onlyElement(
        elements.filter(
          (element) => element.tagName === "h4" && actionsText(element) === "This job was skipped",
        ),
      ) === undefined
    )
      return undefined;
    return {
      id: summary.id,
      name: summary.name,
      status: "completed",
      conclusion: "skipped",
      started_at: null,
      completed_at: null,
      html_url: `https://github.com${summary.href}`,
      steps: [],
    };
  }
  if (
    elements.some(
      (element) => element.tagName === "h4" && actionsText(element) === "This job was skipped",
    )
  )
    return undefined;
  const stepRegions = elements.filter((element) => element.tagName === "check-steps");
  if (stepRegions.length > 1) return undefined;
  const stepRegion = onlyElement(stepRegions);
  const stepContents = stepRegion === undefined ? undefined : ownedElements(stepRegion);
  // No steps region does not prove queued: hydration may have crossed into a
  // terminal blank slate after the group response was fetched.
  if (
    stepRegion === undefined ||
    stepContents === undefined ||
    attribute(stepRegion, "data-job-status") !== summary.status
  )
    return undefined;
  const steps: Record<string, unknown>[] = [];
  for (const element of (stepContents ?? []).filter(
    (element) => element.tagName === "check-step",
  )) {
    const name = attribute(element, "data-name");
    const number = Number(attribute(element, "data-number"));
    const startedAt = attribute(element, "data-started-at") || undefined;
    const completedAt = attribute(element, "data-completed-at") || undefined;
    const rawConclusion = attribute(element, "data-conclusion");
    const conclusion = rawConclusion === "null" ? undefined : rawConclusion || undefined;
    if (
      name === undefined ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      steps.some((step) => step.number === number) ||
      [startedAt, completedAt].some(
        (value) => value !== undefined && !Number.isFinite(Date.parse(value)),
      ) ||
      (startedAt !== undefined &&
        completedAt !== undefined &&
        Date.parse(completedAt) < Date.parse(startedAt)) ||
      ((completedAt !== undefined || conclusion !== undefined) &&
        (startedAt === undefined || completedAt === undefined || conclusion === undefined))
    ) {
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
  let startedAt = firstTimestamp(steps, "started_at");
  const headers = elements.filter((element) =>
    /\/runs\/[0-9]+\/header/.test(attribute(element, "data-url") ?? ""),
  );
  if (
    headers.length > 1 ||
    headers.some(
      (element) => attribute(element, "data-url") !== `/${owner}/${repo}/runs/${summary.id}/header`,
    )
  )
    return undefined;
  const header = onlyElement(
    elements.filter(
      (element) => attribute(element, "data-url") === `/${owner}/${repo}/runs/${summary.id}/header`,
    ),
  );
  const headerContents = header === undefined ? undefined : ownedElements(header);
  const headerTimes = (headerContents ?? []).filter(
    (element) => element.tagName === "relative-time",
  );
  if (headerTimes.length > 1) return undefined;
  const headerTime = onlyElement(headerTimes);
  const headerAt = attribute(headerTime, "datetime");
  if (header !== undefined && (headerTimes.length !== 1 || headerAt === undefined))
    return undefined;
  const label = actionsText(adjacentNode(headerTime, -1)).toLowerCase();
  let completedAt: string | undefined;
  if (headerAt !== undefined) {
    if (!Number.isFinite(Date.parse(headerAt))) return undefined;
    if (summary.status === "completed") {
      const conclusion =
        label === "succeeded"
          ? "success"
          : label === "failed"
            ? "failure"
            : label.replaceAll(" ", "_");
      if (conclusion !== summary.conclusion) return undefined;
      completedAt = headerAt;
    } else if (summary.status === "in_progress" && label === "started") {
      startedAt = headerAt;
    } else return undefined;
  }
  if (
    (header !== undefined && headerContents === undefined) ||
    (completedAt !== undefined && !Number.isFinite(Date.parse(completedAt))) ||
    elements.filter((element) => element.tagName === "check-step").length !== steps.length ||
    (summary.status === "completed" && completedAt === undefined) ||
    (summary.status !== "completed" && summary.conclusion !== null) ||
    (summary.status === "queued" && steps.some((step) => step.status !== "queued")) ||
    (summary.status === "completed" &&
      (startedAt === null || steps.some((step) => step.status !== "completed"))) ||
    (summary.status !== "queued" && steps.length === 0) ||
    steps.some((step) =>
      [step.started_at, step.completed_at].some(
        (time) =>
          typeof time === "string" &&
          ((startedAt !== null && Date.parse(time) < Date.parse(startedAt)) ||
            (completedAt !== undefined && Date.parse(time) > Date.parse(completedAt))),
      ),
    )
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
const ambiguousAttributes = new WeakSet<ActionsElement>();
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
  const duplicateOffsets: number[] = [];
  const document = parse(html, {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === "missing-doctype") missingDoctype = true;
      // GitHub emits duplicate attributes in unrelated dialog controls. Reject
      // duplicates on retained evidence below, not the entire document.
      else if (error.code === "duplicate-attribute") duplicateOffsets.push(error.startOffset);
      else invalid = true;
    },
  });
  const elements = actionsElements(document);
  for (const element of elements) {
    const tag = element.sourceCodeLocation?.startTag;
    if (
      tag !== undefined &&
      duplicateOffsets.some((offset) => offset >= tag.startOffset && offset < tag.endOffset)
    )
      ambiguousAttributes.add(element);
  }
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

function actionsElements(
  root: ActionsNode | undefined,
  exclude?: (element: ActionsElement) => boolean,
): ActionsElement[] {
  const elements: ActionsElement[] = [];
  const pending = root !== undefined && "childNodes" in root ? [...root.childNodes].reverse() : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!("tagName" in node)) continue;
    if (exclude?.(node)) continue;
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

function responsiveElement(
  elements: ActionsElement[],
  classes: [string, string],
  value: (element: ActionsElement) => string | undefined,
): ActionsElement | undefined {
  if (elements.length === 1) return elements[0];
  if (
    elements.length !== 2 ||
    value(elements[0]!) === undefined ||
    value(elements[0]!) !== value(elements[1]!)
  )
    return undefined;
  const inLayout = (element: ActionsElement, name: string) => {
    let parent = element.parentNode;
    while (parent !== null && "tagName" in parent) {
      if (hasClass(parent, name)) return true;
      parent = parent.parentNode;
    }
    return false;
  };
  const first = elements.filter(
    (element) => inLayout(element, classes[0]) && !inLayout(element, classes[1]),
  );
  const second = elements.filter(
    (element) => inLayout(element, classes[1]) && !inLayout(element, classes[0]),
  );
  return first.length === 1 && second.length === 1 ? first[0] : undefined;
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
      !ambiguousAttributes.has(region) &&
      location?.endTag !== undefined &&
      (index === 0 || ordered[index - 1]!.sourceCodeLocation!.endOffset <= location.startOffset)
    );
  });
}

function ownedElements(
  region: ActionsElement,
  exclude?: (element: ActionsElement) => boolean,
): ActionsElement[] | undefined {
  if (!disjointRegions([region])) return undefined;
  const elements = actionsElements(region, exclude);
  // parse5 can repair nesting without emitting an error. Do not use inferred closures
  // or reparented nodes inside an ownership region as evidence.
  for (const element of elements) {
    const location = element.sourceCodeLocation;
    const parent = element.parentNode;
    const parentLocation =
      parent !== null && "tagName" in parent ? parent.sourceCodeLocation : undefined;
    if (
      ambiguousAttributes.has(element) ||
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
  const props = actionsNavigationProps(navigation);
  if (
    props === undefined ||
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
}

function actionsNavigationProps(navigation: ActionsElement): Record<string, unknown> | undefined {
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
    return data.props;
  } catch {
    return undefined;
  }
}

function collectJobSummaries(
  value: unknown,
  expectedPath: string,
  out: Map<number, ActionsJobSummary>,
): boolean {
  if (Array.isArray(value)) {
    return value.every((item) => collectJobSummaries(item, expectedPath, out));
  }
  if (!isRecord(value)) {
    return false;
  }
  if ("id" in value || "href" in value) {
    if (
      !(
        typeof value.id === "number" &&
        Number.isSafeInteger(value.id) &&
        value.id > 0 &&
        !out.has(value.id) &&
        typeof value.displayName === "string" &&
        typeof value.status === "string" &&
        (typeof value.conclusion === "string" || value.conclusion === null) &&
        typeof value.href === "string" &&
        value.href === `${expectedPath}${value.id}`
      )
    )
      return false;
    out.set(value.id, {
      id: value.id,
      name: value.displayName,
      status: value.status,
      conclusion: value.conclusion,
      href: value.href,
    });
    return true;
  }
  for (const child of Object.values(value)) {
    if ((isRecord(child) || Array.isArray(child)) && !collectJobSummaries(child, expectedPath, out))
      return false;
  }
  return true;
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
  // The suffix contains arbitrary workflow/title prose, not status evidence.
  const normalized = /^([^:]+):/.exec(label)?.[1]?.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "completed successfully") {
    return { status: "completed", conclusion: "success" };
  }
  if (normalized === "currently running") return { status: "in_progress", conclusion: null };
  if (normalized === "waiting for another serialized run to finish")
    return { status: "pending", conclusion: null };
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
    if (normalized === needle) {
      return { status: "completed", conclusion };
    }
  }
  for (const status of ["in progress", "queued", "waiting", "pending"] as const) {
    if (normalized === status) {
      return { status: status.replace(" ", "_"), conclusion: null };
    }
  }
  return undefined;
}

function actionsListTrigger(
  workflow: ActionsElement | undefined,
  timestamp: ActionsElement | undefined,
  owner: string,
  repo: string,
): { runNumber: number; event: string | null } | undefined {
  const siblings = workflow?.parentNode?.childNodes;
  if (workflow !== undefined && workflow.parentNode !== timestamp?.parentNode) {
    return currentActionsListTrigger(workflow, owner, repo);
  }
  if (
    workflow === undefined ||
    timestamp === undefined ||
    siblings === undefined ||
    workflow.parentNode !== timestamp.parentNode
  )
    return undefined;
  const start = siblings.indexOf(workflow);
  const end = siblings.indexOf(timestamp);
  if (end <= start) return undefined;
  // Only the retained workflow-to-time interval owns the trigger. Other markup
  // costs a REST fallback rather than letting branch/title/link prose supply it.
  const interval = siblings.slice(start + 1, end).filter((node) => node.nodeName !== "#comment");
  const elements = interval.filter((node): node is ActionsElement => "tagName" in node);
  if (interval.some((node) => !("value" in node) && !("tagName" in node))) return undefined;
  let match: RegExpExecArray | null;
  let event: string;
  if (elements.length === 0) {
    match = /^#([1-9][0-9]*):\s*(pull request|schedule|scheduled|workflow dispatch)$/i.exec(
      interval
        .map((node) => actionsText(node))
        .join(" ")
        .trim(),
    );
    const trigger = match?.[2]?.toLowerCase();
    if (trigger === undefined) return undefined;
    event = trigger === "scheduled" ? "schedule" : trigger.replace(" ", "_");
  } else {
    const commit = onlyElement(elements);
    if (
      commit === undefined ||
      !isHTMLAnchor(commit) ||
      actionsCommitSHA([commit], owner, repo)?.sha === undefined
    )
      return undefined;
    const index = interval.indexOf(commit);
    match = /^#([1-9][0-9]*):\s*Commit$/i.exec(
      interval
        .slice(0, index)
        .map((node) => actionsText(node))
        .join(" ")
        .trim(),
    );
    if (
      !/^pushed$/i.test(
        interval
          .slice(index + 1)
          .map((node) => actionsText(node))
          .join(" ")
          .trim(),
      )
    ) {
      return undefined;
    }
    event = "push";
  }
  const runNumber = Number(match?.[1]);
  return Number.isSafeInteger(runNumber) && runNumber > 0 ? { runNumber, event } : undefined;
}

function currentActionsListTrigger(
  workflow: ActionsElement,
  owner: string,
  repo: string,
): { runNumber: number; event: string | null } | undefined {
  const parent = workflow.parentNode;
  if (
    parent === null ||
    !("tagName" in parent) ||
    parent.tagName !== "span" ||
    !hasClass(parent, "d-block") ||
    !hasClass(parent, "text-small")
  )
    return undefined;
  const children = parent.childNodes.filter(
    (node) => node.nodeName !== "#comment" && !("value" in node && node.value.trim() === ""),
  );
  const [first, number, prose] = children;
  if (
    children.length !== 3 ||
    first !== workflow ||
    number === undefined ||
    !("value" in number) ||
    prose === undefined ||
    !("tagName" in prose) ||
    prose.tagName !== "span" ||
    !hasClass(prose, "color-fg-muted")
  )
    return undefined;
  const runNumber = Number(/^#([1-9][0-9]*):$/.exec(number.value.trim())?.[1]);
  if (!Number.isSafeInteger(runNumber) || runNumber <= 0) return undefined;
  const nodes = prose.childNodes.filter(
    (node) => node.nodeName !== "#comment" && !("value" in node && node.value.trim() === ""),
  );
  const prefix = nodes[0];
  if (prefix === undefined || !("value" in prefix)) return undefined;
  const text = prefix.value.replace(/\s+/g, " ").trim();
  let event: string | null = null;
  if (text === "Manually run by") event = "workflow_dispatch";
  else if (text === "Commit") {
    const commit = nodes[1];
    const suffix = nodes[2];
    if (
      commit === undefined ||
      !("tagName" in commit) ||
      !isHTMLAnchor(commit) ||
      actionsCommitSHA([commit], owner, repo)?.sha === undefined ||
      suffix === undefined ||
      !("value" in suffix) ||
      suffix.value.replace(/\s+/g, " ").trim() !== "pushed by"
    )
      return undefined;
    event = "push";
  }
  // Other current cards expose action prose (e.g. "completed by"), not an
  // unambiguous event. The transport hydrates these from the owned run summary.
  return { runNumber, event };
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
