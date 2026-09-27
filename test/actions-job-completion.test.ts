import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { actionsJobHTMLProvesCompleted } from "../src/github-html-actions";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/actions-job-completion/${name}`, import.meta.url), "utf8");
const completed = fixture("completed-check-run.html.txt");
const active = fixture("active-check-run.html.txt");
const canonical = readFileSync(
  new URL("./fixtures/actions-current/completed-job.html.txt", import.meta.url),
  "utf8",
);
const jobID = "106220362714";
const proves = (html: string, id = jobID, owner = "openclaw", repo = "openclaw") =>
  actionsJobHTMLProvesCompleted(html, owner, repo, id);
const headerURL = `/openclaw/openclaw/runs/${jobID}/header`;
const header = /<span\b[^>]*data-url="[^"]*\/header"[^>]*>[\s\S]*?<\/span>/;
const failedFull = fixture("failed-full-check-run.html.txt");
const failedID = "108555666497";
const annotation = /<job-annotations>[\s\S]*?<\/job-annotations>/;

describe("terminal job HTML completion evidence", () => {
  it.each([
    ["failed", failedID],
    ["succeeded", "108011889949"],
    ["cancelled", "108557756681"],
  ])("proves the captured %s page with an implicit annotation table body", (state, id) => {
    expect(proves(fixture(`${state}-full-check-run.html.txt`), id)).toBe(true);
  });

  it("proves a realistic 600 KB page with thousands of unrelated elements", () => {
    const chrome = `<aside>${"<div>Unrelated page content</div>".repeat(20_000)}</aside>`;
    const html = failedFull.replace("<main>", `${chrome}<main>`);
    expect(Buffer.byteLength(html)).toBeGreaterThan(600_000);
    expect(proves(html, failedID)).toBe(true);
    expect(proves(html, jobID)).toBe(false);
  });

  it("rejects the newly captured running and skipped pages", () => {
    expect(proves(fixture("active-full-check-run.html.txt"), "108557771957")).toBe(false);
    expect(proves(fixture("skipped-full-check-run.html.txt"), "108557811653")).toBe(false);
  });

  it.each(["in_progress", "queued"])(
    "rejects a %s page despite completed annotation or sidebar evidence",
    (status) => {
      const activePage = failedFull.replace(
        'data-job-status="completed"',
        `data-job-status="${status}"`,
      );
      expect(proves(activePage, failedID)).toBe(false);
      expect(
        proves(activePage.replace("<job-annotations>", `<job-annotations>${completed}`), failedID),
      ).toBe(false);
      const sidebar = completed.replace("js-selected-check-run", "sidebar-job");
      expect(proves(activePage.replace("<main>", `<main>${sidebar}`), failedID)).toBe(false);
    },
  );

  it("does not borrow a header or steps from annotations", () => {
    const jobHeader = failedFull.match(header)![0];
    const jobSteps = '<check-steps data-job-status="completed"></check-steps>';
    const withoutHeader = failedFull.replace(header, "");
    expect(
      proves(withoutHeader.replace("<job-annotations>", `<job-annotations>${jobHeader}`), failedID),
    ).toBe(false);
    const withoutSteps = failedFull.replace(/<check-steps\b[\s\S]*?<\/check-steps>/, "");
    expect(
      proves(withoutSteps.replace("<job-annotations>", `<job-annotations>${jobSteps}`), failedID),
    ).toBe(false);
  });

  it.each([
    ["missing annotation close", (html: string) => html.replace("</job-annotations>", "")],
    [
      "duplicate annotation attributes",
      (html: string) => html.replace("<job-annotations>", '<job-annotations class="a" class="b">'),
    ],
    [
      "unowned table outside annotations",
      (html: string) => html.replace(annotation, "<table><tr><td>Unowned</td></tr></table>"),
    ],
    [
      "conflicting job marker",
      (html: string) => html.replace(`check_run_${failedID}`, "check_run_123"),
    ],
    [
      "foreign header",
      (html: string) => html.replace(`/runs/${failedID}/header`, "/runs/123/header"),
    ],
    [
      "duplicate steps",
      (html: string) =>
        html.replace(
          "</check-steps>",
          '</check-steps><check-steps data-job-status="completed"></check-steps>',
        ),
    ],
  ])("keeps the full-page ownership check for %s", (_name, mutate) => {
    expect(proves(mutate(failedFull), failedID)).toBe(false);
  });

  it("proves a completed job from the live check-run page without navigation JSON", () => {
    expect(proves(completed)).toBe(true);
  });

  it("also proves the existing canonical Actions job page", () => {
    expect(proves(canonical)).toBe(true);
  });

  it("does not prove the live in-progress job", () => {
    expect(proves(active, "108534563744")).toBe(false);
  });

  it.each(["in_progress", "queued"])("rejects a %s job despite a terminal header", (status) => {
    expect(
      proves(completed.replace('data-job-status="completed"', `data-job-status="${status}"`)),
    ).toBe(false);
  });

  it.each([
    ["other job", "106220362715", "openclaw", "openclaw"],
    ["other owner", jobID, "another-owner", "openclaw"],
    ["other repository", jobID, "openclaw", "another-repo"],
  ])("rejects evidence scoped to %s", (_name, id, owner, repo) => {
    expect(proves(completed, id, owner, repo)).toBe(false);
  });

  it.each([
    "succeeded",
    "failed",
    "cancelled",
    "timed out",
    "neutral",
    "action required",
    "skipped",
    "stale",
    "startup failure",
  ])("recognizes the terminal header label %s", (label) => {
    expect(proves(completed.replace("succeeded", label))).toBe(true);
  });

  it.each(["Started", "Queued", "Waiting", "unknown result", "failed: maybe still running"])(
    "does not treat the header label %s as completion",
    (label) => {
      expect(proves(completed.replace("succeeded", label))).toBe(false);
    },
  );

  it.each([
    ["missing status", (html: string) => html.replace('data-job-status="completed"', "")],
    ["missing header", (html: string) => html.replace(header, "")],
    ["missing header URL", (html: string) => html.replace(`data-url="${headerURL}"`, "")],
    [
      "missing timestamp",
      (html: string) => html.replace(/<relative-time\b[\s\S]*?<\/relative-time>/, ""),
    ],
    [
      "invalid timestamp",
      (html: string) => html.replace('datetime="2026-09-21T05:16:35Z"', 'datetime="invalid"'),
    ],
    ["missing section close", (html: string) => html.replace("</section>", "")],
    [
      "wrong selected section",
      (html: string) => html.replace("js-selected-check-run", "js-zen-blankslate"),
    ],
    [
      "wrong section label",
      (html: string) => html.replace('aria-label="Check run summary"', 'aria-label="Another job"'),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(proves(mutate(completed))).toBe(false);
  });

  it.each([
    ["selected sections", (html: string) => html + html],
    [
      "status regions",
      (html: string) =>
        html.replace(
          "</check-steps>",
          '</check-steps><check-steps data-job-status="completed"></check-steps>',
        ),
    ],
    ["job headers", (html: string) => html.replace(header, (match) => match + match)],
    [
      "foreign job header",
      (html: string) =>
        html.replace(
          header,
          (match) => match + match.replace(headerURL, "/openclaw/openclaw/runs/123/header"),
        ),
    ],
    [
      "status attributes",
      (html: string) =>
        html.replace(
          'data-job-status="completed"',
          'data-job-status="completed" data-job-status="in_progress"',
        ),
    ],
    [
      "header URL attributes",
      (html: string) =>
        html.replace(
          `data-url="${headerURL}"`,
          `data-url="${headerURL}" data-url="/other/repo/runs/123/header"`,
        ),
    ],
    [
      "selected section classes",
      (html: string) =>
        html.replace(
          'class="js-selected-check-run',
          'class="conflicting" class="js-selected-check-run',
        ),
    ],
  ])("rejects ambiguous duplicate %s", (_name, mutate) => {
    expect(proves(mutate(completed))).toBe(false);
  });

  it("rejects a different selected job ID in optional Actions navigation", () => {
    expect(proves(canonical.replace('"selectedJobId": 106220362714', '"selectedJobId": 123'))).toBe(
      false,
    );
  });

  it.each(["another-owner/openclaw", "openclaw/another-repo"])(
    "rejects optional navigation belonging to %s",
    (repository) => {
      expect(
        proves(
          canonical.replace(
            '"summaryHref": "/openclaw/openclaw/actions/runs/',
            `"summaryHref": "/${repository}/actions/runs/`,
          ),
        ),
      ).toBe(false);
    },
  );

  it("rejects a conflicting check-run identity marker", () => {
    expect(proves(completed.replace(`id="check_run_${jobID}"`, 'id="check_run_123"'))).toBe(false);
  });

  it.each(["script", "template"])("does not use completion markup inside an inert %s", (tag) => {
    expect(proves(`<${tag}>${completed}</${tag}>`)).toBe(false);
    expect(proves(active + `<${tag}>${completed}</${tag}>`, "108534563744")).toBe(false);
  });
});
