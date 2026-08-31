import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { poolCoordinatorStub } from "../../src/pool-coordinator";
import { bearer, jsonResponse, POOL, relay, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

const PATH = "/repos/openclaw/octopool/pulls/42";
const OPTIONS = { headers: { accept: "application/vnd.github.diff" } };

describe("Worker end-to-end cache-fill outcomes", () => {
  it("wakes shared followers for one cache reread without duplicate upstream work", async () => {
    const { responses, upstream } = await concurrentFill("small shared body", true);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(upstream.calls()).toBe(1);
    expect(upstream.maxConcurrent()).toBe(1);
    expect(await responses[1]!.json()).toMatchObject({ relay: { cache: "hit" } });
  });

  it("serves an edge-only completion in the same colo", async () => {
    const { responses, upstream } = await concurrentFill("x".repeat(300_000), true);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(upstream.calls()).toBe(1);
    expect(await responses[1]!.json()).toMatchObject({ relay: { cache: "hit" } });
  });

  it("serializes one takeover after an edge-only remote-colo miss", async () => {
    const { responses, upstream } = await concurrentFill("x".repeat(300_000), false);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(upstream.calls()).toBe(2);
    expect(upstream.maxConcurrent()).toBe(1);
    expect(await responses[1]!.json()).toMatchObject({ relay: { cache: "miss" } });
  });

  it("wakes a follower promptly when the leader throws", async () => {
    await seedPool();
    const cache = edgeCache(true);
    vi.stubGlobal("caches", { default: cache.default });
    const upstream = gatedDiffUpstream("recovered", { failFirst: true });
    vi.stubGlobal("fetch", upstream.fetch);

    const leader = relay(PATH, undefined, OPTIONS);
    const requests = [leader];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await upstream.started;
      const follower = relay(PATH, undefined, OPTIONS);
      requests.push(follower);
      await waitForFollower(follower);
      upstream.release();
      const followerResponse = await Promise.race([
        follower,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("follower stayed blocked")), 2_000);
        }),
      ]);
      await leader.catch(() => undefined);

      expect(followerResponse.status).toBe(200);
      expect(upstream.calls()).toBe(2);
    } finally {
      clearTimeout(timeout);
      upstream.release();
      await Promise.allSettled(requests);
    }
  });

  it("keeps upstream work beyond the old eight-second lease exclusively owned", async () => {
    await seedPool();
    const cache = edgeCache(true);
    vi.stubGlobal("caches", { default: cache.default });
    const upstream = gatedDiffUpstream("renewed shared body");
    vi.stubGlobal("fetch", upstream.fetch);

    const leader = relay(PATH, undefined, OPTIONS);
    const requests = [leader];
    try {
      await upstream.started;
      const follower = relay(PATH, undefined, OPTIONS);
      requests.push(follower);
      await waitForFollower(follower);
      await new Promise((resolve) => setTimeout(resolve, 8_500));

      expect(upstream.calls()).toBe(1);
      expect(upstream.maxConcurrent()).toBe(1);
      upstream.release();
      const responses = await Promise.all([leader, follower]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      expect(upstream.calls()).toBe(1);
    } finally {
      upstream.release();
      await Promise.allSettled(requests);
    }
  }, 15_000);
});

async function concurrentFill(body: string, githubEntriesVisible: boolean) {
  await seedPool();
  const cache = edgeCache(githubEntriesVisible);
  vi.stubGlobal("caches", { default: cache.default });
  const upstream = gatedDiffUpstream(body);
  vi.stubGlobal("fetch", upstream.fetch);

  const leader = relay(PATH, undefined, OPTIONS);
  const requests = [leader];
  try {
    await upstream.started;
    const follower = relay(PATH, undefined, OPTIONS);
    requests.push(follower);
    await waitForFollower(follower);
    upstream.release();
    return { responses: await Promise.all(requests), upstream };
  } finally {
    upstream.release();
    await Promise.allSettled(requests);
  }
}

async function waitForFollower(follower: Promise<Response>): Promise<void> {
  await Promise.race([
    // Cache reads precede identity-key acquisition; they do not prove a waiter exists.
    vi.waitFor(
      async () => {
        const waiting = await runInDurableObject(
          poolCoordinatorStub(env, POOL),
          (instance) =>
            (instance as unknown as { publicationWaiters: Map<string, unknown> }).publicationWaiters
              .size,
        );
        expect(waiting).toBe(1);
      },
      { timeout: 5_000 },
    ),
    follower.then(() => {
      throw new Error("Follower completed before coordinator waiting");
    }),
  ]);
}

function gatedDiffUpstream(body: string, options: { failFirst?: boolean } = {}) {
  let active = 0;
  let maximum = 0;
  let count = 0;
  let markStarted!: () => void;
  const { promise: gate, release } = ownedWork.gate();
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (bearer(request) === "test-org-token") {
      return jsonResponse({ private: false });
    }
    if (bearer(request) !== "test-primary-token") {
      return new Response("unavailable", { status: 503 });
    }
    count++;
    active++;
    maximum = Math.max(maximum, active);
    if (count === 1) {
      markStarted();
      await gate;
      if (options.failFirst === true) {
        active--;
        throw new Error("leader failed");
      }
    }
    active--;
    return new Response(body, { headers: { "content-type": "text/plain" } });
  });
  return {
    fetch: fetchMock,
    started,
    release,
    calls: () => count,
    maxConcurrent: () => maximum,
  };
}

function edgeCache(githubEntriesVisible: boolean) {
  const entries = new Map<string, Response>();
  return {
    default: {
      match: vi.fn(async (request: Request) => {
        if (!githubEntriesVisible && request.url.includes("/github-publication-v1/")) {
          return undefined;
        }
        return entries.get(request.url)?.clone();
      }),
      put: vi.fn(async (request: Request, response: Response) => {
        entries.set(request.url, response.clone());
      }),
      delete: vi.fn(async (request: Request) => entries.delete(request.url)),
    },
  };
}
