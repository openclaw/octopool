import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { clearConfigCache } from "../../src/config-cache";
import { CALLER_TOKEN, orgMembershipResponse, POOL, seedPool } from "./harness";
import { ownedWork } from "./owned-work";

it("shares membership data across native request contexts without sharing I/O objects", async () => {
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
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
  gate.release();
  expect(await Promise.all(requests)).toEqual(Array(32).fill(200));
  expect(upstream).toHaveBeenCalledTimes(1);
  const proof = await env.DB.prepare(
    "SELECT org_identity_verified_at FROM callers WHERE id = 'caller'",
  ).first<{ org_identity_verified_at: string }>();
  expect(Date.now() - Date.parse(proof!.org_identity_verified_at)).toBeLessThan(60_000);
});
