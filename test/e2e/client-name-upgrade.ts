import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { restoreD1Baseline } from "./d1-baseline";

const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

export async function beforeClientNameUpgrade(): Promise<void> {
  await restoreD1Baseline(env.DB, ["PRAGMA defer_foreign_keys=TRUE;"]);
  await applyD1Migrations(
    env.DB,
    migrations().filter(({ name }) => name < "0019_"),
  );
}

export async function applyClientNameUpgrade(): Promise<void> {
  await applyD1Migrations(
    env.DB,
    migrations().filter(({ name }) => name >= "0019_"),
  );
}
