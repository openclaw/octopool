import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";

type TestEnv = Env & {
  TEST_MIGRATIONS: D1Migration[];
};

beforeEach(async () => {
  await reset();
  const testEnv = env as TestEnv;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
