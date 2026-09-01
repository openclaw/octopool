export const historicalHead = "224a80eeebec678db6646ef888f5bbc89caf63c4";
export const wrongPatchHead = "f46c055901c4fbc034cc89120cca36c87075b6bd";
export const movingPRHead = "9999999999999999999999999999999999999999";
export const runIDs = [33167365292, 33167365221];

// Sanitized structure from the two saved run pages. Neither summary contains a commit link.
export function runPage(id = runIDs[0]!, sha?: string, attempt = 1): string {
  const path = `/openclaw/Peekaboo/actions/runs/${id}`;
  return `<!DOCTYPE html><html><head><title>fixture · openclaw/Peekaboo@224a80e · GitHub</title></head><body>
    <page-header>
      <span class="PageHeader-parentLink-label">${id === runIDs[0] ? "CI" : "CodeQL"}</span>
      <span class="actions-workflow-runs-status"><svg aria-label="failed: "></svg></span>
      <h1 class="PageHeader-title"><span class="markdown-title">fixture</span><span>#651</span></h1>
    </page-header>
    <react-partial partial-name="actions-run-jobs-list">
      <script type="application/json" data-target="react-partial.embeddedData">${JSON.stringify({
        props: {
          summaryHref: path,
          summarySelected: true,
          jobGroupsFetchUrl: `${path}/job_groups_batch?attempt=${attempt}`,
        },
      })}</script>
    </react-partial>
    <div role="region" aria-label="Workflow run summary" data-url="${path}/summary_partial">
      <div><span>Triggered via pull request <relative-time datetime="2026-08-28T11:29:48Z"></relative-time></span>
      <a class="branch-name" href="/openclaw/Peekaboo/tree/refs/heads/fixture-branch">fixture-branch</a>
      ${sha === undefined ? "" : `<a href="/openclaw/Peekaboo/commit/${sha}">${sha}</a>`}
      <span>Total duration</span><a class="h4 color-fg-default">29m 23s</a></div>
    </div>
  </body></html>`;
}

export function exactRun(id: number) {
  return {
    id,
    head_sha: historicalHead,
    head_branch: "fixture-branch",
    event: "pull_request",
    name: id === runIDs[0] ? "CI" : "CodeQL",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    html_url: `https://github.com/openclaw/Peekaboo/actions/runs/${id}`,
    pull_requests: [{ number: 651, head: { sha: movingPRHead } }],
  };
}

export function singlePatch(sha = historicalHead): string {
  return `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: Fixture <fixture@example.com>\nDate: Fri, 28 Aug 2026 11:29:48 +0000\nSubject: [PATCH] fixture\n\ndiff --git a/example b/example\n--- a/example\n+++ b/example\n@@ -1 +1 @@\n-old\n+new\n`;
}

// Exact envelope SHAs and subjects from /commit/224a80e.patch; no scraped bodies.
export const mergePatch = [
  [wrongPatchHead, "fix(cli): honor verify unknown exit status (#649)"],
  ["415610c7a236a7e9c86aa4b89703720e49fdb100", "fix(cli): keep learn on injected runtime (#653)"],
  [
    "cb25788d6b4599e1bf1e59d7c79ffa3f9ad1828b",
    "fix(bridge): preserve exact-window focus proof (#656)",
  ],
]
  .map(([sha, subject], index) =>
    singlePatch(sha).replace("[PATCH] fixture", `[PATCH ${index + 1}/3] ${subject}`),
  )
  .join("\n");

export function runCard(
  id: number,
  sha?: string,
  metadata: {
    state?: string;
    title?: string;
    workflow?: string;
    trigger?: string;
    branch?: string;
  } = {},
): string {
  const {
    state = "failed",
    title = "fixture",
    workflow = "CI",
    trigger = "pull request",
    branch,
  } = metadata;
  return `<div class="Box-row js-socket-channel js-updatable-content">
    <a href="/openclaw/Peekaboo/actions/runs/${id}" aria-label="${state}: Run 651 of ${workflow}. ${title}"><span class="h4 markdown-title">${title}</span></a>
    <div><span class="text-bold">${workflow}</span> #651: ${trigger}
    <relative-time datetime="2026-08-28T11:29:48Z"></relative-time>
    ${branch === undefined ? "" : `<a class="branch-name" href="/openclaw/Peekaboo/tree/refs/heads/${branch}">${branch}</a>`}
    ${sha === undefined ? "" : `<a href="/openclaw/Peekaboo/commit/${sha}">${sha}</a>`}</div>
  </div>`;
}
