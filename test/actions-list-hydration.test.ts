import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../src/github-egress";
import { parseActionsRunHTML, parseActionsRunListHTML } from "../src/github-html-actions";
import { callGitHubWeb } from "../src/github-web";
import { classifyRoute, defaultPolicy, validateRelayRequest } from "../src/policy";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/actions-list-hydration/${name}.html.txt`, import.meta.url),
    "utf8",
  );
const manualID = 35575007986;
const manual = fixture("manual-queued");
const parsedManualSHA = /\/commit\/([a-f0-9]{40})/.exec(manual)![1]!;
const runPage = (id: number) => manual.replaceAll(String(manualID), String(id));
const listPage = (count: number, complete = 0) =>
  `<strong>${count} workflow runs</strong>` +
  Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return `<div class="Box-row js-socket-channel js-updatable-content">
      <a href="/openclaw/openclaw/actions/runs/${id}" aria-label="queued: CI">
        <span class="markdown-title">CI</span>
      </a>
      <span class="text-bold">CI</span> #${id}: workflow dispatch
      <relative-time datetime="2026-09-21T07:52:36Z"></relative-time>
      ${index < complete ? `<a href="/openclaw/openclaw/commit/${parsedManualSHA}">commit</a>` : ""}
    </div>`;
  }).join("");

async function readList(
  options: {
    workflow?: boolean;
    limit?: number;
    timeout?: number;
    api?: boolean;
    rules?: { pattern: string; replacement: string }[];
  } = {},
) {
  const request = validateRelayRequest({
    pool: "maintainers",
    method: "GET",
    path: `/repos/openclaw/openclaw/actions/${options.workflow ? "workflows/ci.yml/runs" : "runs"}`,
    query: { per_page: String(options.limit ?? 25) },
    headers: { "x-octopool-public-shape": "actions-summary-v1" },
  });
  return callGitHubWeb(
    withGitHubEgress(
      { REQUEST_TIMEOUT_MS: String(options.timeout ?? 30000) } as Env,
      options.rules ?? [],
    ),
    request,
    classifyRoute(request, defaultPolicy("openclaw")),
    { skipAnonymousAPI: !options.api },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Actions list hydration", () => {
  it.each([
    ["manual-queued", manualID, "queued"],
    ["manual-active", 35575038033, "in_progress"],
    ["push-pending", 35575012764, "pending"],
  ] as const)("parses owned metadata in the live %s page", (name, id, status) => {
    expect(parseActionsRunHTML(fixture(name), "openclaw", "openclaw", id)).toMatchObject({
      id,
      status,
      conclusion: null,
      event: name === "push-pending" ? "push" : "workflow_dispatch",
      head_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  });

  it.each(["pr-queued", "pr-target"])("still rejects %s without an owned commit SHA", (name) => {
    const id = name === "pr-queued" ? 35574986404 : 35575041909;
    const html = fixture(name);
    expect(html).not.toMatch(/\/commit\/[a-f0-9]{40}/);
    expect(parseActionsRunHTML(html, "openclaw", "openclaw", id)).toBeUndefined();
    expect(
      parseActionsRunHTML(
        `${html}<a href="/openclaw/openclaw/commit/${parsedManualSHA}">unowned</a>`,
        "openclaw",
        "openclaw",
        id,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "absent graph",
      (html: string) =>
        html.slice(0, html.indexOf('<div role="region" aria-label="Workflow run graph"')),
    ],
    ["foreign graph", (html: string) => html.replace("/graph_partial", "/foreign_graph_partial")],
    ["wrong event", (html: string) => html.replace("on: workflow_dispatch", "on: push")],
    [
      "missing time",
      (html: string) => html.replace(/<relative-time\b[\s\S]*?<\/relative-time>/, ""),
    ],
    [
      "duplicate time",
      (html: string) =>
        html.replace(/<relative-time\b[\s\S]*?<\/relative-time>/, "$& Manually triggered $&"),
    ],
  ] as const)("rejects manual trigger with %s", (_name, transform) => {
    expect(
      parseActionsRunHTML(transform(manual), "openclaw", "openclaw", manualID),
    ).toBeUndefined();
  });

  it.each([
    ["list", false, 25],
    ["workflow", true, 22],
  ] as const)(
    "rejects captured %s before any hydration, even for limit 1",
    async (name, workflow, count) => {
      const html = fixture(name);
      const parsed = parseActionsRunListHTML(html, "openclaw", "openclaw")!;
      expect(parsed.workflow_runs).toHaveLength(25);
      expect(parsed.workflow_runs.filter((run) => !run.head_sha || !run.event)).toHaveLength(count);
      const upstream = vi.fn(async () => new Response(html));
      vi.stubGlobal("fetch", upstream);
      expect(await readList({ workflow, limit: 1 })).toBeUndefined();
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it.each([8, 9])("bounds hydration at eight cards: %i", async (count) => {
    const upstream = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("/actions") ? listPage(count) : runPage(Number(url.split("/").at(-1))),
        ),
    );
    vi.stubGlobal("fetch", upstream);
    const result = await readList();
    if (count === 8) {
      expect(result?.body).toMatchObject({
        total_count: 8,
        workflow_runs: Array.from({ length: 8 }, (_, i) => ({
          id: i + 1,
          event: "workflow_dispatch",
          head_sha: parsedManualSHA,
        })),
      });
      expect(upstream).toHaveBeenCalledTimes(9);
    } else {
      expect(result).toBeUndefined();
      expect(upstream).toHaveBeenCalledOnce();
    }
  });

  it("counts only incomplete cards, preserving a full 25-run result", async () => {
    const upstream = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("/actions") ? listPage(25, 17) : runPage(Number(url.split("/").at(-1))),
        ),
    );
    vi.stubGlobal("fetch", upstream);
    const result = await readList();
    expect(result?.body).toHaveProperty("workflow_runs.length", 25);
    expect(upstream).toHaveBeenCalledTimes(9);
  });

  it("aborts siblings on the first failed hydration and falls back without a partial list", async () => {
    const aborted = vi.fn();
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.github.com")) return Response.json({ exact: true });
      if (url.endsWith("/actions")) return new Response(listPage(3));
      if (url.endsWith("/1")) return new Response(runPage(1));
      if (url.endsWith("/2")) return new Response("missing metadata");
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => {
            aborted();
            reject(init.signal!.reason);
          },
          { once: true },
        ),
      );
    });
    vi.stubGlobal("fetch", upstream);
    expect(await readList({ api: true })).toMatchObject({
      backend: "github",
      body: { exact: true },
    });
    expect(aborted).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledTimes(5);
  });

  it("propagates string protection failures while aborting hydration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(listPage(1))),
    );
    await expect(
      readList({ rules: [{ pattern: "/actions/runs/1", replacement: "blocked" }] }),
    ).rejects.toMatchObject({ code: "string_rewrite_denied" });
  });

  it("rejects conflicting exact events instead of overwriting the list evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            url.endsWith("/actions")
              ? listPage(1).replace("workflow dispatch", "pull request")
              : runPage(1),
          ),
      ),
    );
    expect(await readList()).toBeUndefined();
  });

  it.each(["list headers", "list body", "run headers", "run body", "patch body", "redirect"])(
    "bounds stalled %s by the shared one-second deadline",
    async (stage) => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return controller.signal;
      });
      const cancelled = vi.fn();
      const pendingBody = () => new Response(new ReadableStream({ cancel: cancelled }));
      const upstream = vi.fn(async (url: string, init: RequestInit) => {
        const pendingFetch = () =>
          new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener(
              "abort",
              () => {
                cancelled();
                reject(init.signal!.reason);
              },
              { once: true },
            ),
          );
        if (url.endsWith("/actions")) {
          if (stage === "list headers") return pendingFetch();
          if (stage === "list body") return pendingBody();
          return new Response(listPage(1));
        }
        if (url.endsWith(".patch")) return pendingBody();
        if (url.endsWith("/redirected")) return pendingFetch();
        if (stage === "redirect")
          return new Response(null, { status: 302, headers: { location: "/redirected" } });
        if (stage === "run headers") return pendingFetch();
        if (stage === "run body") return pendingBody();
        return new Response(runPage(1).replaceAll(parsedManualSHA, parsedManualSHA.slice(0, 7)));
      });
      vi.stubGlobal("fetch", upstream);
      let settled = false;
      const result = readList().then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeUndefined();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(AbortSignal.timeout).toHaveBeenCalledWith(1000);
      if (stage.startsWith("run") || stage === "redirect")
        expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
    },
  );

  it("honors a shorter configured timeout", async () => {
    const upstream = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        ),
    );
    vi.stubGlobal("fetch", upstream);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(await readList({ timeout: 20 })).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(20);
  });
});
