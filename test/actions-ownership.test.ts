import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../src/github-egress";
import {
  parseActionsRunHTML,
  parseActionsRunListHTML,
  parseCommitPatchSHA,
} from "../src/github-html-actions";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import {
  exactRun,
  historicalHead,
  mergePatch,
  runCard,
  runIDs,
  runPage,
  singlePatch,
  wrongPatchHead,
} from "./fixtures/actions-ownership";

afterEach(() => vi.unstubAllGlobals());

describe("Actions run ownership", () => {
  it.each([
    ["completed successfully", "completed", "success"],
    ["cancelled", "completed", "cancelled"],
    ["failed", "completed", "failure"],
    ["timed out", "completed", "timed_out"],
    ["action required", "completed", "action_required"],
    ["neutral", "completed", "neutral"],
    ["skipped", "completed", "skipped"],
    ["stale", "completed", "stale"],
    ["startup failure", "completed", "startup_failure"],
    ["in progress", "in_progress", null],
    ["queued", "queued", null],
    ["waiting", "waiting", null],
    ["pending", "pending", null],
  ])(
    "owns the %s prefix independently of title and workflow prose",
    async (state, status, conclusion) => {
      const upstream = vi.fn(
        async () =>
          new Response(
            `<strong>1 workflow run</strong>${runCard(runIDs[0]!, historicalHead, {
              state,
              title: "completed successfully: cancelled failed pushed",
              workflow: "in progress scheduled workflow dispatch",
              branch: "pending pushed pull request",
            })}`,
          ),
      );
      vi.stubGlobal("fetch", upstream);
      expect(await readList()).toMatchObject({
        backend: "web",
        body: {
          workflow_runs: [{ status, conclusion, event: "pull_request", head_sha: historicalHead }],
        },
      });
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["pull request", "pull_request"],
    ["schedule", "schedule"],
    ["scheduled", "schedule"],
    ["workflow dispatch", "workflow_dispatch"],
    [
      `Commit <a href="/openclaw/Peekaboo/commit/${historicalHead}">failed workflow dispatch</a> pushed`,
      "push",
    ],
  ])("owns the bounded trigger %s", async (trigger, event) => {
    const upstream = vi.fn(
      async () =>
        new Response(
          `<strong>1 workflow run</strong>${runCard(
            runIDs[0]!,
            event === "push" ? undefined : historicalHead,
            {
              state: " IN   PROGRESS ",
              title: "failed pushed scheduled",
              workflow: "pull request workflow dispatch",
              trigger,
            },
          )}`,
        ),
    );
    vi.stubGlobal("fetch", upstream);
    expect(await readList()).toMatchObject({
      backend: "web",
      body: { workflow_runs: [{ status: "in_progress", conclusion: null, event }] },
    });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing status delimiter", (html: string) => html.replace("failed: Run", "failed Run")],
    [
      "missing status label",
      (html: string) => html.replace('aria-label="failed:', 'aria-label=":'),
    ],
    ["missing trigger", (html: string) => html.replace("#651: pull request", "#651:")],
    [
      "conflicting trigger",
      (html: string) => html.replace("#651: pull request", "#651: pull request scheduled"),
    ],
    ["missing workflow", (html: string) => html.replace('<span class="text-bold">CI</span>', "")],
    [
      "different timestamp parent",
      (html: string) =>
        html
          .replace("<relative-time", "<span><relative-time")
          .replace("</relative-time>", "</relative-time></span>"),
    ],
    [
      "reversed interval",
      (html: string) =>
        html
          .replace('<span class="text-bold">CI</span>', "")
          .replace("</relative-time>", '</relative-time><span class="text-bold">CI</span>'),
    ],
    [
      "duplicate timestamp",
      (html: string) =>
        html.replace(
          "</relative-time>",
          '</relative-time><relative-time datetime="2026-08-28T11:29:48Z"></relative-time>',
        ),
    ],
    ["invalid run number", (html: string) => html.replace("#651:", "#0:")],
    ["unsafe run number", (html: string) => html.replace("#651:", "#99999999999999999999:")],
    [
      "branch in trigger",
      (html: string) =>
        html.replace(
          "#651: pull request",
          '#651: <a href="/openclaw/Peekaboo/tree/refs/heads/pull-request">pull request</a>',
        ),
    ],
    [
      "title in trigger",
      (html: string) => html.replace("#651: pull request", "#651: <span>pull request</span>"),
    ],
  ])("falls through to exact REST for %s", async (_name, transform) => {
    const body = { total_count: 1, workflow_runs: [exactRun(runIDs[0]!)] };
    const upstream = vi.fn(async (input: string) =>
      input.startsWith("https://github.com/")
        ? new Response(
            `<strong>1 workflow run</strong>${transform(runCard(runIDs[0]!, historicalHead))}`,
          )
        : Response.json(body),
    );
    vi.stubGlobal("fetch", upstream);
    expect(await readList()).toMatchObject({ backend: "github", body });
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([
      "https://github.com/openclaw/Peekaboo/actions",
      "https://api.github.com/repos/openclaw/Peekaboo/actions/runs?per_page=25",
    ]);
  });
  it.each(runIDs)("uses historical REST ownership for saved run %i", async (id) => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        fetched.push(input);
        if (input.endsWith(".patch")) return new Response(mergePatch);
        if (input.startsWith("https://github.com/")) return new Response(runPage(id));
        return Response.json(exactRun(id));
      }),
    );
    const response = await readRun(id);
    expect(response).toMatchObject({ backend: "github", body: exactRun(id) });
    expect(fetched).toContain(`https://api.github.com/repos/openclaw/Peekaboo/actions/runs/${id}`);
  });

  it("ignores unrelated links before and after the owned summary", () => {
    const decoy = `<aside><a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">unrelated</a></aside>`;
    const html = runPage(runIDs[0], historicalHead)
      .replace("<body>", `<body>${decoy}`)
      .replace("</body>", `${decoy}</body>`);
    expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toMatchObject({
      head_sha: historicalHead,
    });
  });

  it.each(runIDs)(
    "rejects the real merge patch even with an owned abbreviated link for %i",
    async (id) => {
      const fetched: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          fetched.push(input);
          if (input.endsWith(".patch")) return new Response(mergePatch);
          if (input.startsWith("https://github.com/")) return new Response(runPage(id, "224a80e"));
          return Response.json(exactRun(id));
        }),
      );
      expect(await readRun(id)).toMatchObject({ backend: "github", body: exactRun(id) });
      expect(fetched).toEqual([
        `https://github.com/openclaw/Peekaboo/actions/runs/${id}`,
        "https://github.com/openclaw/Peekaboo/commit/224a80e.patch",
        `https://api.github.com/repos/openclaw/Peekaboo/actions/runs/${id}`,
      ]);
    },
  );

  it("keeps safe single-commit expansion token-free", async () => {
    const fetchMock = vi.fn(
      async (input: string) =>
        new Response(input.endsWith(".patch") ? singlePatch() : runPage(runIDs[0], "224a80e")),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await readRun(runIDs[0]!)).toMatchObject({
      backend: "web",
      body: { head_sha: historicalHead },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat comments or script strings as summary commit links", () => {
    const decoy = `<a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">wrong</a>`;
    const html = runPage().replace(
      "</relative-time>",
      `</relative-time><!-- ${decoy} --><script>${JSON.stringify(decoy)}</script>`,
    );
    expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toBeUndefined();
  });

  const decoyLink = `<a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">wrong</a>`;
  const malformedMarkup = [
    ["script end-tag attributes", `<script>const value = '${decoyLink}';</script\t\n bar>`],
    ["uppercase script end-tag attributes", `<SCRIPT>${decoyLink}</SCRIPT data-extra>`],
    ["style end-tag attributes", `<style>${decoyLink}</STYLE data-extra>`],
    ["comment reconstruction", `<scr<!--x-->ipt>const value = '${decoyLink}';</scr<!--x-->ipt>`],
    ["nested comment reconstruction", `<!-- <!-- -->${decoyLink} -->`],
    [
      "duplicate href",
      `<a href="/openclaw/Peekaboo/commit/${historicalHead}" href="/other/repo/commit/${wrongPatchHead}">ambiguous</a>`,
    ],
    ["unclosed raw text", `<script>${decoyLink}`],
    ["misnested formatting", `<b><i>${decoyLink}</b></i>`],
  ];

  it.each(malformedMarkup)(
    "falls back to the historical REST head for %s",
    async (_name, markup) => {
      const html = runPage().replace("</relative-time>", `</relative-time>${markup}`);
      expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toBeUndefined();
      const fetchMock = vi.fn(async (input: string) =>
        input.startsWith("https://github.com/")
          ? new Response(html)
          : Response.json(exactRun(runIDs[0]!)),
      );
      vi.stubGlobal("fetch", fetchMock);
      expect(await readRun(runIDs[0]!)).toMatchObject({
        backend: "github",
        body: exactRun(runIDs[0]!),
      });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `https://github.com/openclaw/Peekaboo/actions/runs/${runIDs[0]}`,
        `https://api.github.com/repos/openclaw/Peekaboo/actions/runs/${runIDs[0]}`,
      ]);
    },
  );

  it.each(malformedMarkup)("rejects malformed list ownership: %s", (_name, markup) => {
    const card = runCard(runIDs[0]!).replace("</relative-time>", `</relative-time>${markup}`);
    expect(
      parseActionsRunListHTML(`<strong>1 workflow run</strong>${card}`, "openclaw", "Peekaboo"),
    ).toBeUndefined();
  });

  const inertMarkup = [
    ["script", `<script>${JSON.stringify(decoyLink)}</script>`],
    [
      "script containing fake div boundaries",
      `<script>const markup = '</div><div>${decoyLink}</div>';</script>`,
    ],
    ["mixed-case script", `<ScRiPt>${JSON.stringify(decoyLink)}</sCrIpT>`],
    ["style", `<style>${decoyLink}</STYLE>`],
    ["template", `<template>${decoyLink}</template>`],
    ["comment", `<!-- ${decoyLink} -->`],
    ["textarea", `<textarea>${decoyLink}</TEXTAREA>`],
    ["title", `<title>${decoyLink}</TITLE>`],
    ["iframe", `<iframe>${decoyLink}</IFRAME>`],
    ["xmp", `<xmp>${decoyLink}</XMP>`],
    ["noembed", `<noembed>${decoyLink}</NOEMBED>`],
    ["noframes", `<noframes>${decoyLink}</NOFRAMES>`],
    ["noscript", `<noscript>${decoyLink}</noscript>`],
    ["foreign content", `<svg><foreignObject>${decoyLink}</foreignObject></svg>`],
    ["escaped text", `&lt;a href="/openclaw/Peekaboo/commit/${wrongPatchHead}"&gt;wrong&lt;/a&gt;`],
  ];

  it.each(inertMarkup)(
    "ignores fake commit links in %s without losing a safe owned head",
    (_name, markup) => {
      for (const head of [undefined, historicalHead]) {
        const html = runPage(runIDs[0], head).replace(
          "</relative-time>",
          `</relative-time>${markup}`,
        );
        expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)?.head_sha).toBe(head);
        const card = runCard(runIDs[0]!, head).replace(
          "</relative-time>",
          `</relative-time>${markup}`,
        );
        expect(
          parseActionsRunListHTML(`<strong>1 workflow run</strong>${card}`, "openclaw", "Peekaboo")
            ?.workflow_runs[0]?.head_sha,
        ).toBe(head ?? null);
      }
    },
  );

  it("parses uppercase elements and attributes, including embedded job JSON", async () => {
    const html = runPage(runIDs[0], historicalHead)
      .replace(
        /(<\/?)([a-z][a-z-]*)/g,
        (_match, prefix: string, tag: string) => prefix + tag.toUpperCase(),
      )
      .replace(
        /(class|href|aria-label|data-url|datetime|partial-name|data-target)=/g,
        (attribute) => attribute.toUpperCase(),
      );
    const fetchMock = vi.fn(async () => new Response(html));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readRun(runIDs[0]!)).toMatchObject({
      backend: "web",
      body: { head_sha: historicalHead },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not decode DOM text or attributes twice", () => {
    const html = runPage(runIDs[0], historicalHead)
      .replace(
        '<span class="markdown-title">fixture</span>',
        '<span class="markdown-title">&amp;lt;fixture&amp;gt; &amp; &#x1f980;</span>',
      )
      .replace("refs/heads/fixture-branch", "refs/heads/feature&amp;amp;branch");
    expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toMatchObject({
      display_title: "&lt;fixture&gt; & 🦀",
      head_branch: "feature&amp;branch",
    });
  });

  it("accepts document mode and a bare fragment, but rejects a missing document doctype", () => {
    const html = runPage(runIDs[0], historicalHead);
    const fragment = html.slice(html.indexOf("<page-header>"), html.indexOf("</body>"));
    expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)?.head_sha).toBe(
      historicalHead,
    );
    expect(parseActionsRunHTML(fragment, "openclaw", "Peekaboo", runIDs[0]!)?.head_sha).toBe(
      historicalHead,
    );
    expect(
      parseActionsRunHTML(html.replace("<!DOCTYPE html>", ""), "openclaw", "Peekaboo", runIDs[0]!),
    ).toBeUndefined();
  });

  it("ignores fake list cards and totals inside inert DOM content", () => {
    for (const tag of ["script", "style", "template", "textarea"]) {
      const decoy = `<${tag}><strong>0 workflow runs</strong>${runCard(runIDs[1]!, wrongPatchHead)}</${tag}>`;
      expect(parseActionsRunListHTML(decoy, "openclaw", "Peekaboo")).toBeUndefined();
      expect(
        parseActionsRunListHTML(
          `${decoy}<strong>1 workflow run</strong>${runCard(runIDs[0]!, historicalHead)}`,
          "openclaw",
          "Peekaboo",
        )?.workflow_runs,
      ).toMatchObject([{ id: runIDs[0], head_sha: historicalHead }]);
    }
  });

  it("parses uppercase list elements and attributes", () => {
    const html = `<strong>1 workflow run</strong>${runCard(runIDs[0]!, historicalHead)}`
      .replace(
        /(<\/?)([a-z][a-z-]*)/g,
        (_match, prefix: string, tag: string) => prefix + tag.toUpperCase(),
      )
      .replace(/(class|href|aria-label|datetime)=/g, (attribute) => attribute.toUpperCase());
    expect(parseActionsRunListHTML(html, "openclaw", "Peekaboo")?.workflow_runs).toMatchObject([
      { id: runIDs[0], head_sha: historicalHead },
    ]);
  });

  it("rejects unusual ancestor names around otherwise complete ownership regions", () => {
    const html = runPage(runIDs[0], historicalHead)
      .replace("<body>", "<body><scr<!--x-->ipt>")
      .replace("</body>", "</scr<!--x-->ipt></body>");
    expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toBeUndefined();
  });

  it("rejects duplicate commit links even when their SHAs agree", () => {
    for (const page of [runPage(runIDs[0], historicalHead), runCard(runIDs[0]!, historicalHead)]) {
      const html = page.replace(
        `</relative-time>`,
        `</relative-time><a href="/openclaw/Peekaboo/commit/${historicalHead}">duplicate</a>`,
      );
      expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toBeUndefined();
      expect(parseActionsRunListHTML(html, "openclaw", "Peekaboo")).toBeUndefined();
    }
  });

  it.each(["script", "style", "template", "textarea"])(
    "does not take a page header or job navigation from %s",
    (tag) => {
      for (const region of [
        /<page-header>[\s\S]*?<\/page-header>/,
        /<react-partial[\s\S]*?<\/react-partial>/,
      ]) {
        const html = runPage(runIDs[0], historicalHead).replace(
          region,
          (markup) => `<${tag}>${markup}</${tag}>`,
        );
        expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toBeUndefined();
      }
    },
  );

  it.each([
    [
      "duplicate summary attribute",
      (html: string) =>
        html.replace(
          "data-url=",
          'DATA-URL="/other/repo/actions/runs/1/summary_partial" data-url=',
        ),
    ],
    ["unclosed summary", (html: string) => html.replace("</div>\n  </body>", "\n  </body>")],
    [
      "nested summary",
      (html: string) =>
        html.replace(
          "<div><span>Triggered",
          '<div aria-label="Workflow run summary"><span>Triggered',
        ),
    ],
    [
      "duplicate navigation",
      (html: string) => html.replace(/(<react-partial[\s\S]*?<\/react-partial>)/, "$1$1"),
    ],
    [
      "duplicate embedded JSON",
      (html: string) =>
        html.replace(
          "</script>",
          '</script><script data-target="react-partial.embeddedData">{}</script>',
        ),
    ],
    [
      "duplicate page header",
      (html: string) => html.replace(/(<page-header>[\s\S]*?<\/page-header>)/, "$1$1"),
    ],
    [
      "foreign commit identity",
      (html: string) =>
        html.replace(`/Peekaboo/commit/${historicalHead}`, `/other/commit/${historicalHead}`),
    ],
  ])("rejects ambiguous DOM ownership: %s", (_name, transform) => {
    expect(
      parseActionsRunHTML(
        transform(runPage(runIDs[0], historicalHead)),
        "openclaw",
        "Peekaboo",
        runIDs[0]!,
      ),
    ).toBeUndefined();
  });

  it("rejects nested list cards and unlabeled conflicting run links", () => {
    for (const markup of [
      runCard(runIDs[1]!, wrongPatchHead),
      `<a href="/other/repo/actions/runs/1">wrong run</a>`,
    ]) {
      const card = runCard(runIDs[0]!, historicalHead).replace(
        "</relative-time>",
        `</relative-time>${markup}`,
      );
      expect(
        parseActionsRunListHTML(`<strong>1 workflow run</strong>${card}`, "openclaw", "Peekaboo"),
      ).toBeUndefined();
    }
  });

  it.each([
    ["wrong run", runPage(runIDs[1], historicalHead)],
    [
      "wrong repo",
      runPage(runIDs[0], historicalHead).replaceAll("openclaw/Peekaboo", "other/Peekaboo"),
    ],
    [
      "missing identity",
      runPage(runIDs[0], historicalHead).replace(/<react-partial[\s\S]*?<\/react-partial>/, ""),
    ],
    [
      "conflicting identity",
      runPage(runIDs[0], historicalHead)
        .replace(`job_groups_batch?attempt=1`, `job_groups_batch?attempt=2`)
        .replace(
          `"summaryHref":"/openclaw/Peekaboo/actions/runs/${runIDs[0]}"`,
          `"summaryHref":"/openclaw/Peekaboo/actions/runs/${runIDs[1]}"`,
        ),
    ],
    ["ambiguous summary", runPage(runIDs[0], historicalHead) + runPage(runIDs[0], wrongPatchHead)],
    ["missing owned head", runPage()],
    [
      "conflicting heads",
      runPage(runIDs[0], historicalHead).replace(
        "</relative-time>",
        `</relative-time><a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">wrong</a>`,
      ),
    ],
    ["invalid head length", runPage(runIDs[0], "a".repeat(41))],
    [
      "wrong summary identity",
      runPage(runIDs[0], historicalHead).replace(
        `${runIDs[0]}/summary_partial`,
        `${runIDs[1]}/summary_partial`,
      ),
    ],
    [
      "invalid embedded JSON",
      runPage(runIDs[0], historicalHead).replace('{"props":', '{"props":invalid'),
    ],
    [
      "wrong job navigation identity",
      runPage(runIDs[0], historicalHead).replace(
        `${runIDs[0]}/job_groups_batch`,
        `${runIDs[1]}/job_groups_batch`,
      ),
    ],
    ["zero attempt", runPage(runIDs[0], historicalHead, 0)],
  ])("refuses %s", (_name, html) => {
    expect(parseActionsRunHTML(html, "openclaw", "Peekaboo", runIDs[0]!)).toBeUndefined();
  });

  it("refuses a different attempt and accepts the owned attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.startsWith("https://github.com/")
          ? new Response(runPage(runIDs[0], historicalHead, 2))
          : Response.json(exactRun(runIDs[0]!)),
      ),
    );
    expect(await readRun(runIDs[0]!, 1)).toMatchObject({ backend: "github" });
    expect(await readRun(runIDs[0]!, 2)).toMatchObject({
      backend: "web",
      body: { run_attempt: 2, head_sha: historicalHead },
    });
  });

  it("does not borrow a following region's SHA for a list card", () => {
    const html = `<strong>2 workflow runs</strong>${runCard(runIDs[0]!)}<aside><a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">wrong</a></aside>${runCard(runIDs[1]!, historicalHead)}`;
    expect(
      parseActionsRunListHTML(html, "openclaw", "Peekaboo")?.workflow_runs.map(
        (run) => run.head_sha,
      ),
    ).toEqual([null, historicalHead]);
  });

  it.each([
    [
      "last card's neighbor",
      `${runCard(runIDs[0]!)}<aside><a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">wrong</a></aside>`,
      [null],
    ],
    [
      "conflicting card heads",
      runCard(runIDs[0]!, historicalHead).replace(
        "</relative-time>",
        `</relative-time><a href="/openclaw/Peekaboo/commit/${wrongPatchHead}">wrong</a>`,
      ),
      undefined,
    ],
    ["unclosed card", runCard(runIDs[0]!, historicalHead).replace(/<\/div>\s*$/, ""), undefined],
    ["duplicate run", runCard(runIDs[0]!, historicalHead).repeat(2), undefined],
    [
      "conflicting repository identity",
      runCard(runIDs[0]!, historicalHead).replace(
        "</relative-time>",
        '</relative-time><a href="/other/repo/actions/runs/1" aria-label="failed: ">other run</a>',
      ),
      undefined,
    ],
  ])("refuses borrowed or ambiguous list ownership: %s", (_name, cards, expected) => {
    expect(
      parseActionsRunListHTML(
        `<strong>1 workflow run</strong>${cards}`,
        "openclaw",
        "Peekaboo",
      )?.workflow_runs.map((run) => run.head_sha),
    ).toEqual(expected);
  });

  it("rejects a list abbreviation conflicting with its owned run page", async () => {
    const exact = { total_count: 1, workflow_runs: [exactRun(runIDs[0]!)] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.startsWith("https://api.github.com/")) return Response.json(exact);
        return new Response(
          input.endsWith("/actions")
            ? `<strong>1 workflow run</strong>${runCard(runIDs[0]!, "f46c055")}`
            : runPage(runIDs[0], historicalHead),
        );
      }),
    );
    const request = validateRelayRequest({
      pool: "maintainers",
      method: "GET",
      path: "/repos/openclaw/Peekaboo/actions/runs",
      headers: { "x-octopool-public-shape": "actions-summary-v1" },
    });
    expect(
      await callGitHubWeb(
        withGitHubEgress({} as Env, []),
        request,
        classifyRoute(request, defaultPolicy("openclaw")),
      ),
    ).toMatchObject({ backend: "github", body: exact });
  });

  it.each(["actions/runs", "actions/workflows/ci.yml/runs"])(
    "falls back for unsafe %s enrichment",
    async (suffix) => {
      const exact = { total_count: 2, workflow_runs: runIDs.map(exactRun) };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input.startsWith("https://api.github.com/")) return Response.json(exact);
          if (input.endsWith(".patch")) return new Response(mergePatch);
          const id = /\/actions\/runs\/([0-9]+)$/.exec(input)?.[1];
          return new Response(
            id
              ? runPage(Number(id), "224a80e")
              : `<strong>2 workflow runs</strong>${runIDs.map((id) => runCard(id)).join("")}`,
          );
        }),
      );
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: `/repos/openclaw/Peekaboo/${suffix}`,
        headers: { "x-octopool-public-shape": "actions-summary-v1" },
      });
      expect(
        await callGitHubWeb(
          withGitHubEgress({} as Env, []),
          request,
          classifyRoute(request, defaultPolicy("openclaw")),
        ),
      ).toMatchObject({ backend: "github", body: exact });
    },
  );
});

async function readList() {
  const request = validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: "/repos/openclaw/Peekaboo/actions/runs",
    query: { per_page: "25" },
    headers: { "x-octopool-public-shape": "actions-summary-v1" },
  });
  return callGitHubWeb(
    withGitHubEgress({} as Env, []),
    request,
    classifyRoute(request, defaultPolicy("openclaw")),
  );
}

describe("commit patch ownership", () => {
  it("expands a single matching commit", () => {
    expect(parseCommitPatchSHA(singlePatch(), "224a80e")).toBe(historicalHead);
  });
  it.each([
    ["real merge series", mergePatch],
    ["matching first of multiple commits", singlePatch() + singlePatch(wrongPatchHead)],
    ["mismatching commit", singlePatch(wrongPatchHead)],
    ["invalid length", singlePatch("a".repeat(41))],
    ["64-character GitHub SHA", singlePatch("a".repeat(64))],
    ["duplicate author", singlePatch().replace("Date:", "From: Other <other@example.com>\nDate:")],
    ["duplicate subject", singlePatch().replace("Subject:", "Subject: ambiguity\nSubject:")],
    ["missing envelope", `Subject: [PATCH] fixture\n${historicalHead}`],
    ["incomplete headers", `From ${historicalHead} Mon Sep 17 00:00:00 2001\n`],
    ["partial series", singlePatch().replace("[PATCH]", "[PATCH 1/3]")],
  ])("rejects %s", (_name, patch) => {
    expect(parseCommitPatchSHA(patch, "224a80e")).toBeUndefined();
  });
  it.each(["", "224a80", historicalHead, "a".repeat(41), "a".repeat(64), "224a80g"])(
    "rejects invalid abbreviation %s",
    (abbreviation) => {
      expect(parseCommitPatchSHA(singlePatch(), abbreviation)).toBeUndefined();
    },
  );
});

async function readRun(id: number, attempt?: number) {
  const request = validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: `/repos/openclaw/Peekaboo/actions/runs/${id}${attempt === undefined ? "" : `/attempts/${attempt}`}`,
    headers: { "x-octopool-public-shape": "actions-summary-v1" },
  });
  return callGitHubWeb(
    withGitHubEgress({} as Env, []),
    request,
    classifyRoute(request, defaultPolicy("openclaw")),
  );
}
