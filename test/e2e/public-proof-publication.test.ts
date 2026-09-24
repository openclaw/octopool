import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { withGitHubEgress } from "../../src/github-egress";
import { CACHE_PUBLICATION_EPOCH, proofPublicationResource } from "../../src/cache-publication";
import { publicProofCoordinatorStub, poolCoordinatorStub } from "../../src/pool-coordinator";
import {
  ensurePublicGitHubRepo,
  observeAnonymousPublicRepo,
  storePublicRepoProof,
  PUBLIC_PROOF_EDGE_NAMESPACE,
} from "../../src/public-repos";
import { deleteEdgeJSON, readEdgeJSON, writeEdgeJSON } from "../../src/edge-cache";
import { classifyRoute, defaultPolicy } from "../../src/policy";
import { sqliteTimestamp } from "../../src/sqlite-time";
import { queries } from "../../src/generated/sql";
import { ownedWork } from "./owned-work";
import { observePublicationD1 } from "./publication-d1-observer";

const request = { pool: "a", method: "GET" as const, path: "/repos/OpenClaw/Octopool" };
const route = classifyRoute(request, defaultPolicy("openclaw"));
const resource = proofPublicationResource("OpenClaw", "Octopool");
const egress = () => withGitHubEgress(env, []);
const proof = () =>
  env.DB.prepare(queries.readPublicRepoProof)
    .bind(CACHE_PUBLICATION_EPOCH, "openclaw", "octopool")
    .first<{ is_public: number; checked_at: string; expires_at: string; publication_id: number }>();
const owners = () =>
  env.DB.prepare("SELECT count(*) AS n FROM cache_publication_owners").first<number>("n");
const clearEdge = () => deleteEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool");
const positive = () => ({ status: 200, headers: {}, body: { private: false } });

describe("native public proof publication", () => {
  it("uses the verifier, persists immutable default TTLs and releases completed ownership", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const req = new Request(input, init);
      expect(req.headers.get("authorization")).toBe("Bearer test-org-token");
      expect(req.headers.get("user-agent")).toBe("octopool");
      expect(await owners()).toBe(1);
      return Response.json({ private: false });
    });
    vi.stubGlobal("fetch", fetcher);
    await ensurePublicGitHubRepo(
      withGitHubEgress({ ...env, PUBLIC_REPO_TTL_SECONDS: undefined } as unknown as Env, []),
      route,
    );
    const row = await proof();
    expect(Date.parse(row!.expires_at + "Z") - Date.parse(row!.checked_at + "Z")).toBe(30_000);
    expect(row?.is_public).toBe(1);
    expect(await owners()).toBe(0);
    await ensurePublicGitHubRepo(egress(), route);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 503])("retries verifier %s anonymously", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("retry", { status, headers: { "x-ratelimit-remaining": "0" } }),
      )
      .mockResolvedValueOnce(Response.json({ private: false }));
    vi.stubGlobal("fetch", fetcher);
    await ensurePublicGitHubRepo(egress(), route);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fetcher.mock.calls[1]!;
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect((await proof())?.is_public).toBe(1);
  });

  it.each(["private", "404", "page404", "pageFalse", "fallbackPageFalse"])(
    "stores a successful shared denial for %s",
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        if (kind === "fallbackPageFalse" && String(input).startsWith("https://api."))
          return new Response("limited", { status: 429 });
        if (kind.endsWith("False"))
          return new Response(
            '<meta name="octolytics-dimension-repository_public" content="false" />',
          );
        return kind === "private"
          ? Response.json({ private: true })
          : new Response("missing", { status: 404 });
      });
      vi.stubGlobal("fetch", fetcher);
      await expect(
        ensurePublicGitHubRepo(egress(), { ...route, tokenFreeOnly: kind.startsWith("page") }),
      ).rejects.toMatchObject({ status: 403, code: "repo_not_public" });
      const row = await proof();
      expect(row?.is_public).toBe(0);
      expect(Date.parse(row!.expires_at + "Z") - Date.parse(row!.checked_at + "Z")).toBe(3_600_000);
      expect(await owners()).toBe(0);
      fetcher.mockClear();
      await expect(
        ensurePublicGitHubRepo(egress(), route, sqliteTimestamp(Date.now())),
      ).rejects.toMatchObject({ status: 403 });
      expect(fetcher).not.toHaveBeenCalled();
      await clearEdge();
      await expect(ensurePublicGitHubRepo(egress(), route)).rejects.toMatchObject({
        status: 403,
        code: "repo_not_public",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([403, 429, 503])(
    "does not persist inconclusive %s or markerless pages",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) =>
          String(input).startsWith("https://api.")
            ? new Response("inconclusive", { status, headers: { "x-ratelimit-remaining": "0" } })
            : new Response("<html>no marker</html>"),
        ),
      );
      await expect(ensurePublicGitHubRepo(egress(), route)).rejects.toMatchObject({
        status: 502,
        code: "repo_public_check_failed",
      });
      await expect(
        ensurePublicGitHubRepo(egress(), { ...route, tokenFreeOnly: true }),
      ).rejects.toMatchObject({ status: 502, code: "repo_public_check_failed" });
      expect(await proof()).toBeNull();
      expect(await owners()).toBe(0);
    },
  );

  it("recognizes a streamed public page marker after exhausted APIs", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '<meta name="octolytics-dimension-repository_public" content="tr',
          ),
        );
        controller.enqueue(new TextEncoder().encode('ue" />'));
        controller.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(stream));
    vi.stubGlobal("fetch", fetcher);
    await ensurePublicGitHubRepo(egress(), route);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [input, init] = fetcher.mock.calls[2]!;
    const page = new Request(input, init);
    expect(page.url).toBe("https://github.com/openclaw/octopool");
    expect(page.headers.has("authorization")).toBe(false);
    expect((await proof())?.is_public).toBe(1);
  });

  it("serves covering edge proof with no added D1/DO calls, then refreshes an expired denial", async () => {
    await observeAnonymousPublicRepo(env, route, async () => positive());
    const row = await proof();
    const inaccessible = new Proxy(egress(), {
      get(target, key) {
        if (key === "DB" || key === "POOL_COORDINATOR")
          throw new Error("Hot proof added authority call");
        return Reflect.get(target, key);
      },
    });
    await ensurePublicGitHubRepo(inaccessible, route, row!.checked_at);
    await clearEdge();
    await env.DB.prepare(
      "UPDATE github_public_repo_proofs SET is_public = 0, expires_at = datetime('now', '-1 second')",
    ).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    await ensurePublicGitHubRepo(egress(), route);
    expect((await proof())?.is_public).toBe(1);
  });

  it.each([true, false])(
    "fences delayed verdict %s across two pool coordinators before replacement publishes",
    async (oldVerdict) => {
      const a = await poolCoordinatorStub(env, "pool-a").tryAcquirePublication(resource);
      expect(a).toBeDefined();
      await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
      const b = await poolCoordinatorStub(env, "pool-b").tryAcquirePublication(resource);
      expect(b!.id).toBeGreaterThan(a!.id);
      expect(
        await storePublicRepoProof(
          env,
          "openclaw",
          "octopool",
          oldVerdict,
          sqliteTimestamp(Date.now()),
          a!,
        ),
      ).toBe("rejected");
      expect(await proof()).toBeNull();
      expect(
        await storePublicRepoProof(
          env,
          "openclaw",
          "octopool",
          !oldVerdict,
          sqliteTimestamp(Date.now()),
          b!,
        ),
      ).toBe("shared");
      await publicProofCoordinatorStub(env).completePublication(b!, "shared");
      expect(
        await storePublicRepoProof(
          env,
          "openclaw",
          "octopool",
          oldVerdict,
          sqliteTimestamp(Date.now()),
          a!,
        ),
      ).toBe("rejected");
      expect((await proof())?.is_public).toBe(oldVerdict ? 0 : 1);
    },
  );

  it("makes one pre-observation try, fetches normally on busy, never adopts evidence later, and releases 304", async () => {
    const coordinator = publicProofCoordinatorStub(env);
    const a = await coordinator.tryAcquirePublication(resource);
    const before = await env.DB.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
    ).first("seq");
    let observations = 0;
    await observeAnonymousPublicRepo(env, route, async () => {
      observations++;
      await coordinator.completePublication(a!, "failed");
      return positive();
    });
    expect(observations).toBe(1);
    expect(await proof()).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'cache_publication_owners'",
      ).first("seq"),
    ).toBe(before);
    await observeAnonymousPublicRepo(env, route, async () => {
      expect(await owners()).toBe(1);
      return { status: 304, headers: {}, body: null };
    });
    expect(await owners()).toBe(0);
    expect(await proof()).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: false })),
    );
    await ensurePublicGitHubRepo(egress(), route);
    expect((await proof())?.is_public).toBe(1);
  });

  it.each([false, true])(
    "uses shared public=%s completion for waiting followers despite an older positive edge",
    async (isPublic) => {
      const gate = ownedWork.gate();
      let entered = false;
      let probes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          entered = true;
          probes++;
          await gate.promise;
          return Response.json({ private: !isPublic });
        }),
      );
      const leader = ownedWork.track(
        ensurePublicGitHubRepo(egress(), route).then(
          () => "allowed",
          (e: unknown) => (e as { code: string }).code,
        ),
      );
      let follower: Promise<string> | undefined;
      try {
        await expect.poll(() => entered).toBe(true);
        follower = ownedWork.track(
          ensurePublicGitHubRepo(egress(), route).then(
            () => "allowed",
            (e: unknown) => (e as { code: string }).code,
          ),
        );
        await expect
          .poll(() =>
            runInDurableObject(
              publicProofCoordinatorStub(env),
              (instance) =>
                (instance as unknown as { publicationWaiters: Map<string, unknown> })
                  .publicationWaiters.size,
            ),
          )
          .toBe(1);
        const stalePositive = {
          protocol_epoch: CACHE_PUBLICATION_EPOCH,
          checked_at: sqliteTimestamp(Date.now()),
          expires_at: sqliteTimestamp(Date.now() + 60_000),
          is_public: true,
          publication_id: 0,
          publication_token: "old",
        };
        const actual = caches.default;
        // Keep an older positive in this colo while the denial goes to D1.
        await writeEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool", stalePositive, 60);
        const realPut = actual.put.bind(actual);
        vi.stubGlobal("caches", {
          default: {
            match: actual.match.bind(actual),
            delete: actual.delete.bind(actual),
            put: async (key: Request, value: Response) => {
              const data = await value.clone().json<{ is_public?: boolean }>();
              if (data.is_public === false) throw new Error("synthetic edge failure");
              return realPut(key, value);
            },
          },
        });
        gate.release();
        expect(await leader).toBe(isPublic ? "allowed" : "repo_not_public");
        expect(await follower).toBe(isPublic ? "allowed" : "repo_not_public");
        expect(probes).toBe(1);
        expect(
          (
            await readEdgeJSON<{ is_public: boolean }>(
              PUBLIC_PROOF_EDGE_NAMESPACE,
              "openclaw/octopool",
            )
          )?.is_public,
        ).toBe(true);
        expect((await proof())?.is_public).toBe(Number(isPublic));
      } finally {
        gate.release();
        await Promise.allSettled([leader, ...(follower ? [follower] : [])]);
      }
    },
  );

  it.each([false, true])(
    "reuses a proof between lookup and owner recheck without forgetting a prior denial=%s",
    async (priorDenial) => {
      const now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const lookupEntered = ownedWork.gate();
      const releaseLookup = ownedWork.gate();
      const recheckEntered = ownedWork.gate();
      const releaseRecheck = ownedWork.gate();
      const lostEntered = ownedWork.gate();
      const releaseLost = ownedWork.gate();
      let publishedId = 0;
      let observedId = 0;
      let probes = 0;
      const db = observePublicationD1(env.DB, {
        after: async (sql, _values, result) => {
          if (sql === queries.coveringPublicRepoProof) {
            expect(result.results).toEqual([]);
            lookupEntered.release();
            await releaseLookup.promise;
          }
          if (sql === queries.readPublicRepoProof) {
            expect(result.results[0]).toMatchObject({ publication_id: publishedId, is_public: 1 });
            recheckEntered.release();
            await releaseRecheck.promise;
          }
        },
      });
      let heldLostRead = false;
      const followerDB = observePublicationD1(env.DB, {
        after: async (sql, _values, result) => {
          if (!priorDenial || heldLostRead || sql !== queries.readPublicRepoProof) return;
          heldLostRead = true;
          expect(result.results[0]).toMatchObject({ publication_id: publishedId, is_public: 1 });
          lostEntered.release();
          await releaseLost.promise;
        },
      });
      const fetcher = vi.fn(async () => {
        probes++;
        if (priorDenial && probes === 1) {
          const owner = await env.DB.prepare(queries.readPublicationOwner)
            .bind(CACHE_PUBLICATION_EPOCH, resource)
            .first<{ id: number }>();
          observedId = owner!.id;
          expect(observedId).toBeGreaterThan(publishedId);
          await env.DB.prepare(
            "UPDATE cache_publication_owners SET lease_until_ms = 0 WHERE id = ?",
          )
            .bind(observedId)
            .run();
        }
        return Response.json({ private: priorDenial });
      });
      vi.stubGlobal("fetch", fetcher);
      const leader = ownedWork.track(
        ensurePublicGitHubRepo(
          withGitHubEgress({ ...env, DB: db }, []),
          route,
          sqliteTimestamp(now),
        ),
      );
      const startFollower = () =>
        ownedWork.track(
          ensurePublicGitHubRepo(withGitHubEgress({ ...env, DB: followerDB }, []), route).then(
            () => "allowed",
            (error: unknown) => error,
          ),
        );
      let follower: ReturnType<typeof startFollower> | undefined;
      try {
        await Promise.race([
          lookupEntered.promise,
          leader.then(() => {
            throw new Error("Leader did not reach the initial proof lookup");
          }),
        ]);
        await observeAnonymousPublicRepo(env, route, async () => positive());
        const published = await proof();
        publishedId = published!.publication_id;
        if (priorDenial) {
          follower = startFollower();
          await Promise.race([
            lostEntered.promise,
            follower.then(() => {
              throw new Error("Follower did not reach its lost-proof reread");
            }),
          ]);
        }
        releaseLookup.release();
        await Promise.race([
          recheckEntered.promise,
          leader.then(() => {
            throw new Error("Leader did not reach the authoritative recheck");
          }),
        ]);
        if (priorDenial) releaseLost.release();
        else follower = startFollower();
        await expect
          .poll(
            () =>
              runInDurableObject(
                publicProofCoordinatorStub(env),
                (instance) =>
                  (instance as unknown as { publicationWaiters: Map<string, unknown> })
                    .publicationWaiters.size,
              ),
            { timeout: 5_000 },
          )
          .toBe(1);
        releaseRecheck.release();
        await leader;
        const result = await follower;
        if (priorDenial) {
          expect(result).toMatchObject({ status: 403, code: "repo_not_public" });
          expect(probes).toBe(2);
          expect((await proof())?.is_public).toBe(0);
          expect((await proof())!.publication_id).toBeGreaterThan(observedId);
        } else {
          expect(result).toBe("allowed");
          expect(fetcher).not.toHaveBeenCalled();
          expect(await proof()).toEqual(published);
        }
        expect(await owners()).toBe(0);
      } finally {
        releaseLookup.release();
        releaseRecheck.release();
        releaseLost.release();
        try {
          await Promise.allSettled([leader, ...(follower ? [follower] : [])]);
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it.each([true, false])(
    "uses only positive historical evidence arriving during failed checks (public=%s)",
    async (isPublic) => {
      const checkedAt = sqliteTimestamp(Date.now());
      let stored: Awaited<ReturnType<typeof proof>>;
      let checks = 0;
      const fetcher = vi.fn<typeof fetch>(async () => {
        checks++;
        if (checks === 1) {
          expect(await owners()).toBe(1);
          await env.DB.prepare("UPDATE cache_publication_owners SET lease_until_ms = 0").run();
          const coordinator = publicProofCoordinatorStub(env);
          const b = (await coordinator.tryAcquirePublication(resource))!;
          expect(
            await storePublicRepoProof(env, "openclaw", "octopool", isPublic, checkedAt, b),
          ).toBe("shared");
          expect(await coordinator.completePublication(b, "shared")).toBe(true);
          stored = await proof();
          await clearEdge();
        }
        return new Response("unavailable", {
          status: [403, 429, 503][checks - 1]!,
          headers: { "x-ratelimit-remaining": "0" },
        });
      });
      vi.stubGlobal("fetch", fetcher);
      const result = ensurePublicGitHubRepo(egress(), route, checkedAt);
      if (isPublic) await expect(result).resolves.toBeUndefined();
      else
        await expect(result).rejects.toMatchObject({
          status: 502,
          code: "repo_public_check_failed",
        });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(await proof()).toEqual(stored!);
      expect(await owners()).toBe(0);
    },
  );

  it("ignores an expired embedded negative that is still physically readable at the edge", async () => {
    const expired = {
      protocol_epoch: CACHE_PUBLICATION_EPOCH,
      checked_at: sqliteTimestamp(Date.now() - 60_000),
      expires_at: sqliteTimestamp(Date.now() - 1_000),
      is_public: false,
      publication_id: 1,
      publication_token: "expired-fixture",
    };
    await writeEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool", expired, 60);
    expect(await readEdgeJSON(PUBLIC_PROOF_EDGE_NAMESPACE, "openclaw/octopool")).toEqual(expired);
    const fetcher = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetcher);
    await ensurePublicGitHubRepo(egress(), route);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await proof())?.is_public).toBe(1);
  });

  it("cleans an acquired owner after a real primary reread ack fails, then allows the next request", async () => {
    let failedOwner = 0;
    const failure = new Error("Primary proof read acknowledgment lost");
    const db = observePublicationD1(env.DB, {
      after: async (sql, _values, result) => {
        if (sql !== queries.readPublicRepoProof) return;
        expect(result.results).toEqual([]);
        const owner = await env.DB.prepare(queries.readPublicationOwner)
          .bind(CACHE_PUBLICATION_EPOCH, resource)
          .first<{ id: number }>();
        expect(owner).not.toBeNull();
        failedOwner = owner!.id;
        throw failure;
      },
    });
    const fetcher = vi.fn(async () => Response.json({ private: false }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      ensurePublicGitHubRepo(
        withGitHubEgress({ ...env, DB: db }, []),
        route,
        sqliteTimestamp(Date.now()),
      ),
    ).rejects.toBe(failure);
    expect(failedOwner).toBeGreaterThan(0);
    expect(await owners()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    await ensurePublicGitHubRepo(egress(), route);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await proof())!.publication_id).toBeGreaterThan(failedOwner);
    expect(await owners()).toBe(0);
  });

  it("refuses legacy proof SQL and envelopes, including old implicit-positive data", async () => {
    await env.DB.prepare(
      "INSERT INTO github_public_repos (owner, repo, expires_at) VALUES ('openclaw', 'octopool', datetime('now', '+1 hour'))",
    ).run();
    await writeEdgeJSON(
      "public-repo-v1",
      "openclaw/octopool",
      { checked_at: sqliteTimestamp(Date.now()), expires_at: sqliteTimestamp(Date.now() + 60_000) },
      60,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ private: true })),
    );
    await expect(
      ensurePublicGitHubRepo(egress(), route, sqliteTimestamp(Date.now())),
    ).rejects.toMatchObject({ status: 403 });
    expect((await proof())?.is_public).toBe(0);
  });
});
