import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { initializeD1Baseline, type D1Baseline } from "./d1-baseline";
import { IsolationLifecycle } from "./lifecycle";
import { ownedWork } from "./owned-work";
import { CacheWriteLedger, restoreStorage } from "./storage-isolation";

type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };
// Match Vitest's unchanged default hook deadline; the watchdog only poisons
// ownership and never extends or replaces the runner's timeout.
const lifecycle = new IsolationLifecycle(10_000);
const cacheLedger = new CacheWriteLedger(caches);
let baseline: D1Baseline;

beforeAll(() =>
  lifecycle.run(async () => {
    const testEnv = env as TestEnv;
    baseline = await initializeD1Baseline(testEnv.DB, testEnv.TEST_MIGRATIONS);
  }),
);

beforeEach(async ({ signal }) => {
  // Keep listening through the runner's completion-time deadline check, even
  // if our promise has just settled. A timed-out body can also keep running.
  signal.addEventListener(
    "abort",
    () => {
      lifecycle.poison(signal.reason);
      ownedWork.releaseGates();
    },
    { once: true },
  );
  await lifecycle.run(async () => {
    await restoreStorage(env, baseline, cacheLedger);
    ownedWork.start();
    vi.stubGlobal("caches", cacheLedger.caches);
  });
});

afterEach(async () => {
  ownedWork.releaseGates();
  await lifecycle.run(async () => {
    // Requests and waitUntil work still need the test's mocks while draining.
    await ownedWork.drain();
    await cacheLedger.drain();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }, true);
});
