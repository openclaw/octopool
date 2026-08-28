import { afterEach, describe, expect, it, vi } from "vitest";
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
    const html = decoy + runPage(runIDs[0], historicalHead) + decoy;
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
      await callGitHubWeb({} as Env, request, classifyRoute(request, defaultPolicy("openclaw"))),
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
        await callGitHubWeb({} as Env, request, classifyRoute(request, defaultPolicy("openclaw"))),
      ).toMatchObject({ backend: "github", body: exact });
    },
  );
});

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
  return callGitHubWeb({} as Env, request, classifyRoute(request, defaultPolicy("openclaw")));
}
