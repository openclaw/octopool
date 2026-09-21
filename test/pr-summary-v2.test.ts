import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePullRequestHTML } from "../src/github-html-embedded";
import { summaryPageRequest } from "../src/github-public-pages";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";
import { githubCacheKey } from "../src/cache";
import { withGitHubEgress } from "../src/github-egress";

function fixture(name: string): string {
  return readFileSync(
    new NodeURL(`./fixtures/pr-summary-v2/${name}.html`, import.meta.url),
    "utf8",
  );
}

describe("PR summary v2", () => {
  it.each([
    ["open", "openclaw", "openclaw", 154432, false, false, "vincentkoc", "openclaw"],
    ["draft", "openclaw", "openclaw", 154396, false, true, "vincentkoc", "openclaw"],
    ["merged", "openclaw", "openclaw", 154425, true, false, "roboclaw-bot", "openclaw"],
    ["closed", "openclaw", "openclaw", 154429, false, undefined, "steipete", "openclaw"],
    ["closed-draft", "cli", "cli", 14333, false, undefined, "williammartin", "cli"],
    ["fork", "openclaw", "openclaw", 154443, false, false, "Marvinthebored", "Marvinthebored"],
    ["bot", "cli", "cli", 14447, true, false, "dependabot[bot]", "cli"],
    ["app", "openclaw", "openclaw", 154444, false, false, "openclaw-mantis[bot]", "openclaw"],
  ] as const)(
    "projects the live %s fixture",
    (name, owner, repo, number, merged, draft, author, headOwner) => {
      const body = parsePullRequestHTML(fixture(name), owner, repo, number, "v2");
      expect(body).toMatchObject({
        number,
        merged,
        user: { login: author },
        head: { user: { login: headOwner } },
      });
      expect(body?.user).toEqual({ login: author });
      expect(body?.head).not.toHaveProperty("repo");
      expect(body).not.toHaveProperty("merged_by");
      if (draft === undefined) {
        expect(body).not.toHaveProperty("draft");
      } else {
        expect(body?.draft).toBe(draft);
      }
      if (merged) {
        expect(body?.merge_commit_sha).toBe(
          name === "merged"
            ? "139592653071d9902543c85bc6f0712f513fb53a"
            : "35b55f8cb2a10f57b1fa38721041fbf97c74da83",
        );
      } else {
        expect(body).not.toHaveProperty("merge_commit_sha");
      }
    },
  );

  function withPR(changes: Record<string, unknown>): string {
    const html = fixture("merged");
    // The fixture carries exactly one embedded-data script; splice its JSON by
    // exact markers rather than pattern-matching HTML.
    const open = '<script type="application/json" data-target="react-app.embeddedData">';
    const start = html.indexOf(open);
    const end = start === -1 ? -1 : html.indexOf("</script>", start + open.length);
    if (start === -1 || end === -1) throw new Error("fixture lacks the embedded data script");
    const data = JSON.parse(html.slice(start + open.length, end));
    Object.assign(data.payload.pullRequestsLayoutRoute.pullRequest, changes);
    return html.slice(0, start + open.length) + JSON.stringify(data) + html.slice(end);
  }

  it.each([undefined, null, {}, { login: null }, { login: "" }, { login: " " }])(
    "omits an unproven author (%j) without losing other projections",
    (author) => {
      const body = parsePullRequestHTML(withPR({ author }), "openclaw", "openclaw", 154425, "v2");
      expect(body?.merged).toBe(true);
      expect(body).not.toHaveProperty("user");
    },
  );

  it.each([undefined, null, "", " "])(
    "omits an unproven head owner (%j)",
    (headRepositoryOwnerLogin) => {
      const body = parsePullRequestHTML(
        withPR({ headRepositoryOwnerLogin }),
        "openclaw",
        "openclaw",
        154425,
        "v2",
      );
      expect(body?.merged).toBe(true);
      expect(body?.head).not.toHaveProperty("user");
    },
  );

  it("retains the head owner of a deleted repository without inventing a repository", () => {
    const body = parsePullRequestHTML(fixture("deleted-head"), "cli", "cli", 5234, "v2");
    expect(body?.head).toMatchObject({ user: { login: "markphelps" } });
    expect(body?.head).not.toHaveProperty("repo");
  });

  it.each([undefined, null, "", "1234567", "g".repeat(40), "a".repeat(41)])(
    "rejects a merged PR without a full merge SHA (%j), preserving v1",
    (mergeCommitSha) => {
      const html = withPR({ mergeCommitSha });
      expect(parsePullRequestHTML(html, "openclaw", "openclaw", 154425, "v2")).toBeUndefined();
      expect(parsePullRequestHTML(html, "openclaw", "openclaw", 154425, "v1")?.state).toBe(
        "MERGED",
      );
    },
  );

  it.each([{ state: "UNKNOWN" }, { state: "OPEN" }, { mergedTime: null }, { number: 1 }])(
    "rejects inconsistent lifecycle or ownership (%j)",
    (changes) => {
      expect(
        parsePullRequestHTML(withPR(changes), "openclaw", "openclaw", 154425, "v2"),
      ).toBeUndefined();
    },
  );

  it("routes both versions to their parsers and isolates their cache keys", async () => {
    const keys = [];
    for (const shape of ["pr-summary-v1", "pr-summary-v2"]) {
      const request = validateRelayRequest({
        pool: "maintainers",
        method: "GET",
        path: "/repos/openclaw/openclaw/pulls/154425",
        headers: { "x-octopool-public-shape": shape },
      });
      const route = classifyRoute(request, defaultPolicy("openclaw"));
      const page = summaryPageRequest(
        withGitHubEgress({ REQUEST_TIMEOUT_MS: "15000" } as unknown as Env, []),
        request,
        route,
      );
      expect(page?.url).toBe("https://github.com/openclaw/openclaw/pull/154425");
      const response = await page?.payload(
        new TextEncoder().encode(fixture("merged")),
        new Headers(),
        200,
        page.url,
      );
      expect(response?.body).toMatchObject({ state: "MERGED" });
      if (shape === "pr-summary-v2") {
        expect(response?.body).toMatchObject({ merged: true, user: { login: "roboclaw-bot" } });
      } else {
        expect(response?.body).not.toHaveProperty("merged");
      }
      keys.push(await githubCacheKey(request.pool, request, route));
    }
    expect(keys[0]).not.toBe(keys[1]);
  });
});
