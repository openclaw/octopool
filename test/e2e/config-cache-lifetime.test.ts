import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { hashToken } from "../../src/auth";
import { CALLER_TOKEN, POOL, seedPool } from "./harness";

it("loads independently after another native request leaves an unresolved config lookup", async () => {
  const worker = (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL;
  const abandoned = await worker.fetch("https://octopool.dev/__test/config-cache/abandon");
  expect(await abandoned.text()).toBe("abandoned");
  const response = await worker.fetch("https://octopool.dev/__test/config-cache/read");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("independent load");
});

it("serves policy GET after another native request abandons the same caller lookup", async () => {
  await seedPool();
  const worker = (env as Env & { IDENTITY_PROTOCOL: Fetcher }).IDENTITY_PROTOCOL;
  const key = `caller:${await hashToken(CALLER_TOKEN)}:${POOL}`;
  const abandoned = await worker.fetch(
    `https://octopool.dev/__test/config-cache/abandon?key=${encodeURIComponent(key)}`,
  );
  expect(await abandoned.text()).toBe("abandoned");
  const response = await worker.fetch(`https://octopool.dev/v1/pools/${POOL}/string-rewrites`, {
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ schema_version: 1, revision: 1, rules: [] });
});
