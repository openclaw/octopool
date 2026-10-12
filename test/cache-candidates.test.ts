import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubCacheCandidateReader,
  readGitHubCache,
  readStaleGitHubCache,
  readStaleGitHubCacheCandidates,
  type CachedGitHubResponse,
  type CacheMissReason,
} from "../src/cache";
import { CACHE_PUBLICATION_EPOCH } from "../src/cache-publication";
import { queries } from "../src/generated/sql";
import { classifyRoute, defaultPolicy } from "../src/policy";
import { sqliteTimestamp } from "../src/sqlite-time";

const now = Date.parse("2026-10-10T12:00:00Z");
const route = classifyRoute(
  { pool: "maintainers", method: "GET", path: "/repos/openclaw/octopool" },
  defaultPolicy("openclaw"),
);
const row = (id: string, overrides = {}) => ({
  status: 200,
  response_headers_json: JSON.stringify({ etag: `"${id}"`, "x-ratelimit-resource": "core" }),
  body_json: JSON.stringify({ id }),
  body_encoding: "json",
  identity_id: id,
  identity_kind: "pat",
  publication_epoch: CACHE_PUBLICATION_EPOCH,
  created_at: sqliteTimestamp(now - 30_000),
  expires_at: sqliteTimestamp(now + 30_000),
  stale_expires_at: sqliteTimestamp(now + 86_400_000),
  ...overrides,
});
const edgeBody = (id: string, overrides = {}) => ({
  status: 200,
  headers: {},
  body: { id },
  body_encoding: "json",
  identity: { id, kind: "pat" },
  protocol_epoch: CACHE_PUBLICATION_EPOCH,
  created_at: sqliteTimestamp(now - 30_000),
  expires_at: sqliteTimestamp(now + 30_000),
  ...overrides,
});

function fixture(
  rows: Record<string, ReturnType<typeof row>> = {},
  edges: Record<string, unknown> = {},
) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const match = vi.fn(async (request: Request) => {
    const key = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
    return edges[key] === undefined ? undefined : Response.json(edges[key]);
  });
  vi.stubGlobal("caches", { default: { match } });
  const first = vi.fn();
  const lookup = (sql: string, key: string) => {
    const stored = rows[key];
    if (
      sql === queries.readGitHubCacheAny &&
      stored !== undefined &&
      (stored.publication_epoch !== CACHE_PUBLICATION_EPOCH ||
        stored.stale_expires_at <= sqliteTimestamp(Date.now()))
    )
      return null;
    return stored ?? null;
  };
  const batch = vi.fn(async (statements: { sql: string; key: string }[]) =>
    statements.map(({ sql, key }) => {
      const stored = lookup(sql, key);
      return { results: stored === null ? [] : [stored] };
    }),
  );
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (key: string) => ({
          sql,
          key,
          first: async () => {
            first(sql, key);
            return lookup(sql, key);
          },
        }),
      }),
      batch,
    },
  } as unknown as Env;
  return { env, first, batch, match, rows, edges };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function choose(
  keys: string[],
  read: (key: string) => Promise<CachedGitHubResponse | undefined>,
) {
  for (const key of keys) {
    const cached = await read(key);
    if (cached !== undefined) return { key, cached };
  }
  return undefined;
}

describe("candidate cache reads", () => {
  it.each([
    { name: "miss", rows: {}, edges: {} },
    {
      name: "earlier D1 beats later edge",
      rows: { primary: row("primary") },
      edges: { secondary: edgeBody("secondary") },
    },
    {
      name: "first edge needs no D1",
      rows: { secondary: row("secondary") },
      edges: { primary: edgeBody("primary") },
    },
    {
      name: "expired primary",
      rows: {
        primary: row("primary", { expires_at: sqliteTimestamp(now) }),
        secondary: row("secondary"),
      },
      edges: {},
    },
    {
      name: "caller age",
      rows: {
        primary: row("primary"),
        secondary: row("secondary", { created_at: sqliteTimestamp(now) }),
      },
      edges: {},
      maxAge: 10,
    },
    {
      name: "wrong epoch",
      rows: { primary: row("primary", { publication_epoch: "old" }), secondary: row("secondary") },
      edges: {},
    },
    {
      name: "bad JSON",
      rows: { primary: row("primary", { body_json: "{" }), secondary: row("secondary") },
      edges: {},
    },
    {
      name: "unvisited rejection",
      rows: { primary: row("primary") },
      edges: { secondary: edgeBody("secondary", { protocol_epoch: "old" }) },
    },
    {
      name: "edge rejection then D1 hit",
      rows: { primary: row("primary") },
      edges: { primary: edgeBody("primary", { expires_at: sqliteTimestamp(now) }) },
    },
    {
      name: "forced fresh",
      rows: { primary: row("primary") },
      edges: { primary: edgeBody("primary") },
      maxAge: 0,
    },
  ])("matches serial candidate choice and miss reasons: $name", async ({ rows, edges, maxAge }) => {
    const { env, batch } = fixture(rows, edges);
    const keys = ["primary", "secondary"];
    const serialMisses: CacheMissReason[] = [];
    const serial = await choose(keys, (key) =>
      readGitHubCache(env, key, undefined, maxAge, (reason) => serialMisses.push(reason)),
    );
    const batchedMisses: CacheMissReason[] = [];
    const read = createGitHubCacheCandidateReader(env, keys, undefined, maxAge, (reason) =>
      batchedMisses.push(reason),
    );
    expect(await choose(keys, read)).toEqual(serial);
    expect(batchedMisses).toEqual(serialMisses);
    expect(batch.mock.calls.length).toBeLessThanOrEqual(1);
    if (maxAge === 0 || (edges.primary && serialMisses.length === 0))
      expect(batch).not.toHaveBeenCalled();
  });

  it("deduplicates within a pass and rereads storage in a new pass", async () => {
    const { env, batch, match, rows } = fixture();
    const keys = ["primary", "secondary", "primary"];
    const read = createGitHubCacheCandidateReader(env, keys);
    expect(await read("primary")).toBeUndefined();
    expect(await read("primary")).toBeUndefined();
    expect(await read("secondary")).toBeUndefined();
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]![0].map((statement) => statement.key)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(match).toHaveBeenCalledTimes(2);
    rows.primary = row("newly-published");
    expect(await createGitHubCacheCandidateReader(env, keys)("primary")).toMatchObject({
      body: { id: "newly-published" },
    });
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("keeps an edge hit out of D1 and rechecks it if earlier eligibility work crosses expiry", async () => {
    const { env, batch, rows } = fixture(
      {},
      { secondary: edgeBody("secondary", { expires_at: sqliteTimestamp(now + 1000) }) },
    );
    const read = createGitHubCacheCandidateReader(env, ["primary", "secondary"]);
    expect(await read("primary")).toBeUndefined();
    expect(batch.mock.calls[0]![0].map((statement) => statement.key)).toEqual(["primary"]);
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    rows.secondary = row("replacement");
    expect(await read("secondary")).toMatchObject({ body: { id: "replacement" } });
  });

  it("propagates D1 failures without choosing a later edge candidate", async () => {
    const { env, batch } = fixture({}, { secondary: edgeBody("secondary") });
    batch.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(
      choose(
        ["primary", "secondary"],
        createGitHubCacheCandidateReader(env, ["primary", "secondary"]),
      ),
    ).rejects.toThrow("D1 unavailable");
  });

  it.each([undefined, 0, 10, 60])(
    "matches serial stale eligibility at max-age=%s with one round trip",
    async (maxAge) => {
      const { env, first, batch } = fixture({
        primary: row("primary", { expires_at: sqliteTimestamp(now - 1000) }),
        secondary: row("secondary", { publication_epoch: "old" }),
        expired: row("expired", { stale_expires_at: sqliteTimestamp(now) }),
        malformed: row("malformed", { body_json: "{" }),
        shared: row("shared", { identity_id: null, identity_kind: null }),
      });
      const keys = ["primary", "secondary", "expired", "malformed", "shared", "absent", "primary"];
      const serial = [];
      for (const key of keys) serial.push(await readStaleGitHubCache(env, key, route, maxAge));
      expect(await readStaleGitHubCacheCandidates(env, keys, route, maxAge)).toEqual(serial);
      expect(first).toHaveBeenCalledTimes(maxAge === 0 ? 0 : 7);
      expect(batch).toHaveBeenCalledTimes(maxAge === 0 ? 0 : 1);
      if (maxAge !== 0) expect(batch.mock.calls[0]![0]).toHaveLength(6);
    },
  );
});
