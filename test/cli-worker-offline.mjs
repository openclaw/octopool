import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

// Use Wrangler's own simulator version and configuration, including all DOs.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = await import(
  pathToFileURL(wranglerRequire.resolve("miniflare")).href
);
const run = promisify(execFile);
const scratch = await mkdtemp(path.join(tmpdir(), "octopool-cli-offline-"));
let simulator;
try {
  const binary = path.join(scratch, process.platform === "win32" ? "octopool.exe" : "octopool");
  await run("go", ["build", "-o", binary, "./cmd/octopool"], { timeout: 120_000 });
  const bundle = path.join(scratch, "worker");
  await run(
    process.execPath,
    [
      path.resolve("node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--outdir",
      bundle,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const { workerOptions } = unstable_getMiniflareWorkerOptions("wrangler.jsonc");
  // The bundle is one ES module; source-file module rules no longer apply.
  const { modulesRules: _modulesRules, ...bundledOptions } = workerOptions;
  let upstreamCalls = 0;
  simulator = new Miniflare(
    convertV4MiniflareOptions({
      ...bundledOptions,
      modules: true,
      scriptPath: path.join(bundle, "index.js"),
      modulesRoot: bundle,
      host: "127.0.0.1",
      port: 0,
      cf: false,
      outboundService(request) {
        upstreamCalls++;
        assert.equal(request.method, "GET");
        assert.equal(request.url, "https://api.github.com/repos/openclaw/octopool");
        assert.equal(request.headers.get("authorization"), null);
        return Response.json({
          id: 7,
          name: "octopool",
          full_name: "openclaw/octopool",
          private: false,
        });
      },
    }),
  );
  const baseURL = await simulator.ready;
  const db = await simulator.getD1Database("DB");
  for (const migration of await readD1Migrations(path.resolve("migrations"))) {
    await db.batch(migration.queries.map((query) => db.prepare(query)));
  }
  const token = "octopool-e2e-caller-token";
  const hash = "e5rKdZ4MIfLksXT_641m9weO2LawisHnqrwEZtn6uTM";
  await db.batch([
    db
      .prepare("INSERT INTO pools (id, name, policy_json) VALUES ('maintainers', 'maintainers', ?)")
      .bind(JSON.stringify({ allowed_owners: ["openclaw"], allow_public_repos: true })),
    db
      .prepare(
        "INSERT INTO callers (id, name, token_hash, github_login, org_login, org_identity_verified_at, status, github_user_id) VALUES ('cli-e2e', 'CLI E2E', ?, 'cli-e2e', 'openclaw', CURRENT_TIMESTAMP, 'active', 424242)",
      )
      .bind(hash),
    db
      .prepare(
        "INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES ('cli-e2e-token', 'cli-e2e', ?, 'cli-e2e')",
      )
      .bind(hash),
    db.prepare("INSERT INTO caller_pools (caller_id, pool_id) VALUES ('cli-e2e', 'maintainers')"),
  ]);
  const cliEnv = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    APPDATA: path.join(scratch, "config"),
    LOCALAPPDATA: path.join(scratch, "cache"),
    OCTOPOOL_STRING_REWRITE_FILE: "",
    OCTOPOOL_FRESH: "",
    OCTOPOOL_NO_FALLBACK: "1",
    OCTOPOOL_RELAY_CONCURRENCY: "0",
    OCTOPOOL_GH_PATH: path.join(scratch, "must-not-run-gh"),
    OCTOPOOL_TOKEN: token,
    OCTOPOOL_URL: baseURL.toString(),
    OCTOPOOL_POOL: "maintainers",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { stdout } = await run(binary, ["gh", "api", "repos/openclaw/octopool"], {
      env: cliEnv,
      timeout: 15_000,
    });
    assert.equal(JSON.parse(stdout).name, "octopool");
    assert.equal(upstreamCalls, 1, "the second CLI request must reuse the Worker cache");
  }
  // Audit settlement is asynchronous; wait for both records before checking order.
  let audits;
  for (let attempt = 0; attempt < 80; attempt++) {
    audits = await db
      .prepare("SELECT cache_status, identity_id, status FROM audit_events ORDER BY rowid")
      .all();
    if (audits.results.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(audits.results, [
    { cache_status: "miss", identity_id: null, status: 200 },
    { cache_status: "hit", identity_id: null, status: 200 },
  ]);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM github_cache_entries").first("count"),
    1,
  );
  console.log(
    "octopool CLI→Worker offline smoke ok: compiled CLI, real Worker, miss then cache hit",
  );
} finally {
  try {
    await simulator?.dispose();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
