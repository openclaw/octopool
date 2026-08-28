import { decodeURIComponentSafe } from "./github-path";
import { decodeHTML, escapeRegex, htmlAttribute, textMatch } from "./github-html-utils";
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
  const totalMatch = /<strong>([0-9,]+) workflow runs?(?: results?)?<\/strong>/.exec(html);
  const total = totalMatch === null ? undefined : Number(totalMatch[1]!.replaceAll(",", ""));
  const cards = actionsDivRegions(html, (attributes) => {
    const classes = new Set(htmlAttribute(attributes, "class")?.split(/\s+/));
    return ["Box-row", "js-socket-channel", "js-updatable-content"].every((name) =>
      classes.has(name),
    );
  });
  if (cards === undefined) {
    return undefined;
  }
  const runs: Record<string, unknown>[] = [];
  const runPath = `/${escapeRegex(owner)}/${escapeRegex(repo)}/actions/runs/`;

  for (const card of cards) {
    const anchors = [...card.matchAll(/<a\b([^>]*)>/g)]
      .map((match) => ({
        href: htmlAttribute(match[1]!, "href"),
        label: htmlAttribute(match[1]!, "aria-label"),
      }))
      .filter(
        (anchor) =>
          anchor.label !== undefined &&
          /^\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+$/.test(anchor.href ?? ""),
      );
    const anchor = anchors[0];
    const idText = new RegExp(`^${runPath}([0-9]+)$`).exec(anchor?.href ?? "")?.[1];
    if (anchors.length !== 1 || anchor?.label === undefined || idText === undefined) {
      return undefined;
    }
    const state = runState(anchor.label);
    if (state === undefined) {
      return undefined;
    }
    const title = textMatch(card, /class="[^"]*markdown-title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const workflow = textMatch(
      card,
      /<span class="text-bold"[^>]*>([\s\S]*?)<\/span>\s*#([0-9]+):/,
    );
    const runNumber = /<span class="text-bold"[^>]*>[\s\S]*?<\/span>\s*#([0-9]+):/.exec(card)?.[1];
    const createdAt = /<relative-time[\s\S]*?datetime="([^"]+)"/.exec(card)?.[1];
    if (
      title === undefined ||
      workflow === undefined ||
      runNumber === undefined ||
      createdAt === undefined
    ) {
      return undefined;
    }
    const id = Number(idText);
    const commit = actionsCommitSHA(card, owner, repo);
    if (
      commit === undefined ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      runs.some((run) => run.id === id)
    ) {
      return undefined;
    }
    const branch = new RegExp(
      `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/tree/refs/heads/([^"]+)"`,
    ).exec(card)?.[1];
    const duration = /aria-label="Run duration"[\s\S]*?<\/svg>\s*<span>\s*([^<]+)</.exec(card)?.[1];
    runs.push({
      id,
      name: workflow,
      display_title: title,
      run_number: Number(runNumber),
      status: state.status,
      conclusion: state.conclusion,
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
      head_branch: branch === undefined ? null : decodeURIComponentSafe(branch),
      head_sha: commit.sha ?? null,
      event: runEvent(card),
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
  const runPath = `/${owner}/${repo}/actions/runs/${id}`;
  const summaries = actionsDivRegions(
    html,
    (attributes) => htmlAttribute(attributes, "aria-label") === "Workflow run summary",
  );
  const summary = summaries?.[0];
  const summaryAttributes =
    summary === undefined ? undefined : /^<div\b([^>]*)>/.exec(summary)?.[1];
  const runAttempt = actionsRunAttempt(html, runPath);
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    summaries?.length !== 1 ||
    summary === undefined ||
    summaryAttributes === undefined ||
    htmlAttribute(summaryAttributes, "data-url") !== `${runPath}/summary_partial` ||
    runAttempt === undefined ||
    (attempt !== undefined && attempt !== runAttempt)
  ) {
    return undefined;
  }
  const pageHeaders = [...html.matchAll(/<page-header\b[^>]*>([\s\S]*?)<\/page-header>/g)];
  const header = pageHeaders[0]?.[1];
  if (pageHeaders.length !== 1 || header === undefined) {
    return undefined;
  }
  const title = textMatch(
    header,
    /<h1[^>]*class="[^"]*PageHeader-title[^"]*"[\s\S]*?<span class="markdown-title"[^>]*>([\s\S]*?)<\/span>/,
  );
  const workflow = textMatch(header, /class="PageHeader-parentLink-label"[^>]*>([\s\S]*?)<\/span>/);
  const stateLabel =
    /class="[^"]*actions-workflow-runs-status[^"]*"[\s\S]*?aria-label="([^"]+)"/.exec(header)?.[1];
  const state = stateLabel === undefined ? undefined : runState(decodeHTML(stateLabel));
  const runNumber = new RegExp(
    `<span class="markdown-title"[\\s\\S]*?</span>\\s*<span[^>]*>\\s*#([0-9]+)`,
  ).exec(header)?.[1];
  const trigger = /Triggered via\s+([^<]+?)\s*<relative-time[^>]*datetime="([^"]+)"/.exec(summary);
  const sha = actionsCommitSHA(summary, owner, repo)?.sha;
  const branch = actionsRunBranch(summary, owner, repo);
  if (
    title === undefined ||
    workflow === undefined ||
    state === undefined ||
    runNumber === undefined ||
    trigger === null ||
    sha === undefined
  ) {
    return undefined;
  }
  const duration = /Total duration[\s\S]*?class="[^"]*color-fg-default[^"]*"[^>]*>\s*([^<]+)</.exec(
    summary,
  )?.[1];
  const createdAt = trigger[2]!;
  return {
    id,
    name: workflow,
    display_title: title,
    run_number: Number(runNumber),
    status: state.status,
    conclusion: state.conclusion,
    html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
    head_branch: branch ?? null,
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

// Match the closing div, not the next card: following regions do not own this run's SHA.
function actionsDivRegions(
  html: string,
  selected: (attributes: string) => boolean,
): string[] | undefined {
  const regions: string[] = [];
  let depth = 0;
  let start: number | undefined;
  for (const match of html.matchAll(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<\/?div\b[^>]*>/gi,
  )) {
    if (!/^<\/?div\b/i.test(match[0])) {
      continue;
    }
    if (match[0].startsWith("</")) {
      if (start !== undefined && --depth === 0) {
        regions.push(
          html
            .slice(start, match.index + match[0].length)
            .replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""),
        );
        start = undefined;
      }
    } else {
      if (selected(match[0].slice(4, -1))) {
        if (start !== undefined) return undefined;
        start = match.index;
      }
      if (start !== undefined) depth++;
    }
  }
  return start === undefined ? regions : undefined;
}

function actionsCommitSHA(
  html: string,
  owner: string,
  repo: string,
): { sha: string | undefined } | undefined {
  const prefix = `/${owner}/${repo}/commit/`;
  const shas = new Set<string>();
  for (const anchor of html.matchAll(/<a\b([^>]*)>/g)) {
    const href = htmlAttribute(anchor[1]!, "href");
    if (href !== undefined && /^\/[^/]+\/[^/]+\/commit\//.test(href)) {
      if (!href.startsWith(prefix)) return undefined;
      const sha = href.slice(prefix.length);
      if (!/^[0-9A-Fa-f]{7,40}$/.test(sha)) return undefined;
      shas.add(sha.toLowerCase());
    }
  }
  return shas.size > 1 ? undefined : { sha: [...shas][0] };
}

function actionsRunAttempt(html: string, runPath: string): number | undefined {
  const partials = [
    ...html.matchAll(/<react-partial\b([^>]*)>([\s\S]*?)<\/react-partial>/g),
  ].filter((match) => htmlAttribute(match[1]!, "partial-name") === "actions-run-jobs-list");
  if (partials.length !== 1) return undefined;
  const scripts = [...partials[0]![2]!.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
    (match) => htmlAttribute(match[1]!, "data-target") === "react-partial.embeddedData",
  );
  if (scripts.length !== 1) return undefined;
  try {
    const data: unknown = JSON.parse(scripts[0]![2]!);
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

function actionsRunBranch(html: string, owner: string, repo: string): string | undefined {
  const branch = new RegExp(
    `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/tree/refs/heads/([^"]+)"`,
  ).exec(html)?.[1];
  if (branch !== undefined) {
    return decodeURIComponentSafe(branch);
  }
  for (const match of html.matchAll(/<a\b([^>]*)>/g)) {
    const classes = htmlAttribute(match[1]!, "class")?.split(/\s+/);
    if (!classes?.includes("branch-name")) {
      continue;
    }
    const title = htmlAttribute(match[1]!, "title");
    if (title === undefined) {
      continue;
    }
    const separator = title.indexOf(":");
    return separator === -1 ? title : title.slice(separator + 1);
  }
  return undefined;
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
