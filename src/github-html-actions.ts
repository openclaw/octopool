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
  const cards = actionsRunCards(html);
  const runs: Record<string, unknown>[] = [];
  const runPath = `/${escapeRegex(owner)}/${escapeRegex(repo)}/actions/runs/`;

  for (const card of cards) {
    const anchor = new RegExp(`href="${runPath}([0-9]+)"[^>]*aria-label="([^"]+)"`).exec(card);
    if (anchor === null) {
      continue;
    }
    const state = runState(decodeHTML(anchor[2]!));
    if (state === undefined) {
      continue;
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
      continue;
    }
    const id = Number(anchor[1]);
    const sha = new RegExp(
      `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/commit/([0-9A-Fa-f]{7,64})"`,
    ).exec(card)?.[1];
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
      head_sha: sha ?? null,
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
): Record<string, unknown> | undefined {
  const title = textMatch(
    html,
    /<h1[^>]*class="[^"]*PageHeader-title[^"]*"[\s\S]*?<span class="markdown-title"[^>]*>([\s\S]*?)<\/span>/,
  );
  const workflow = textMatch(html, /class="PageHeader-parentLink-label"[^>]*>([\s\S]*?)<\/span>/);
  const stateLabel =
    /class="[^"]*actions-workflow-runs-status[^"]*"[\s\S]*?aria-label="([^"]+)"/.exec(html)?.[1];
  const state = stateLabel === undefined ? undefined : runState(decodeHTML(stateLabel));
  const runNumber = new RegExp(
    `<span class="markdown-title"[\\s\\S]*?</span>\\s*<span[^>]*>\\s*#([0-9]+)`,
  ).exec(html)?.[1];
  const trigger = /Triggered via\s+([^<]+?)\s*<relative-time[^>]*datetime="([^"]+)"/.exec(html);
  const sha =
    new RegExp(
      `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/commit/([0-9A-Fa-f]{7,64})"`,
    ).exec(html)?.[1] ??
    new RegExp(
      `(?:\\u00b7|&#183;)\\s*${escapeRegex(owner)}/${escapeRegex(repo)}@([0-9A-Fa-f]{7,64})`,
    ).exec(html)?.[1];
  const branch = actionsRunBranch(html, owner, repo);
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
    html,
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
  };
}

export function parseCommitPatchSHA(patch: string): string | undefined {
  return /^From ([0-9A-Fa-f]{40,64})\s/m.exec(patch)?.[1];
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

function actionsRunCards(html: string): string[] {
  const starts: number[] = [];
  for (const match of html.matchAll(/<div\b[^>]*class="([^"]*)"[^>]*>/g)) {
    if (match.index === undefined) {
      continue;
    }
    const classes = new Set(match[1]!.split(/\s+/));
    if (
      classes.has("Box-row") &&
      classes.has("js-socket-channel") &&
      classes.has("js-updatable-content")
    ) {
      starts.push(match.index);
    }
  }
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
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
