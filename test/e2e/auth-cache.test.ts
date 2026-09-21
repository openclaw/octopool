import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { clearConfigCache } from "../../src/config-cache";
import { CALLER_TOKEN, orgMembershipResponse, POOL, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

it("loads membership independently across native requests and then reuses settled data", async () => {
  await seedPool();
  await env.DB.prepare(
    "UPDATE callers SET org_identity_verified_at = '2000-01-01' WHERE id = 'caller'",
  ).run();
  clearConfigCache();
  const gate = ownedWork.gate();
  const upstream = vi.fn<typeof fetch>(async () => {
    await gate.promise;
    return orgMembershipResponse(true, 42);
  });
  vi.stubGlobal("fetch", upstream);
  const worker = (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL;
  const requests = Array.from({ length: 32 }, () =>
    ownedWork.track(
      (async () => {
        const response = await worker.fetch(`https://octopool.dev/v1/pools/${POOL}/health`, {
          headers: { authorization: `Bearer ${CALLER_TOKEN}` },
        });
        await response.arrayBuffer();
        return response.status;
      })(),
    ),
  );
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(32));
  gate.release();
  expect(await Promise.all(requests)).toEqual(Array(32).fill(200));
  expect(upstream).toHaveBeenCalledTimes(32);
  const warm = await worker.fetch(`https://octopool.dev/v1/pools/${POOL}/health`, {
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
  });
  expect(warm.status).toBe(200);
  await warm.arrayBuffer();
  expect(upstream).toHaveBeenCalledTimes(32);
  const proof = await env.DB.prepare(
    "SELECT org_identity_verified_at FROM callers WHERE id = 'caller'",
  ).first<{ org_identity_verified_at: string }>();
  expect(Date.now() - Date.parse(proof!.org_identity_verified_at)).toBeLessThan(60_000);
});

it("keeps a relay's paginated policy denial out of a concurrent native health request", async () => {
  await seedPool();
  await env.DB.prepare(
    "UPDATE callers SET org_identity_verified_at = '2000-01-01' WHERE id = 'caller'",
  ).run();
  await env.DB.prepare("UPDATE string_rewrite_policy SET rules_json = ? WHERE id = 1")
    .bind(JSON.stringify([{ pattern: "blocked-cursor", replacement: "public" }]))
    .run();
  clearConfigCache();
  const gate = ownedWork.gate();
  const upstream = vi.fn<typeof fetch>(async (_input, init) => {
    const { variables } = JSON.parse(String(init?.body)) as {
      variables: { after: string | null };
    };
    if (upstream.mock.calls.length === 1) await gate.promise;
    return variables.after === null
      ? Response.json({
          data: {
            user: {
              databaseId: 42,
              organizations: {
                nodes: [{ login: "other-org" }],
                pageInfo: { endCursor: "blocked-cursor", hasNextPage: true },
              },
            },
          },
        })
      : orgMembershipResponse(true, 42);
  });
  vi.stubGlobal("fetch", upstream);
  const worker = (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL;
  const headers = { authorization: `Bearer ${CALLER_TOKEN}`, "content-type": "application/json" };
  const relay = ownedWork.track(
    worker.fetch("https://octopool.dev/v1/github/request", {
      method: "POST",
      headers,
      body: JSON.stringify({ pool: POOL, method: "GET", path: "/repos/openclaw/octopool" }),
    }),
  );
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  const health = ownedWork.track(
    worker.fetch(`https://octopool.dev/v1/pools/${POOL}/health`, { headers }),
  );
  // Health must advance to its second page while relay still owns its first.
  try {
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(3));
  } finally {
    gate.release();
  }
  const healthy = await health;
  expect(healthy.status).toBe(200);
  await ownedWork.track(healthy.arrayBuffer());
  const denied = await relay;
  expect(denied.status).toBe(403);
  expect(await ownedWork.track(denied.json())).toMatchObject({
    error: { code: "string_rewrite_denied" },
  });
  expect(upstream).toHaveBeenCalledTimes(3);
});
