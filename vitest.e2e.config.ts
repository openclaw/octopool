import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_APP_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./test/e2e/identity-routing-native-main.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: { IDENTITY_PROTOCOL: { name: "octopool" } },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.resolve("migrations")),
          TEST_PAT_PRIMARY: "test-primary-token",
          TEST_PAT_SECONDARY: "test-secondary-token",
          TEST_APP_KEY,
          TEST_APP_KEY_FAILURE: TEST_APP_KEY,
          OCTOPOOL_GITHUB_APP_ID: "777",
          OCTOPOOL_GITHUB_ORG_TOKEN: "test-org-token",
          OCTOPOOL_ADMIN_TOKEN: "test-admin-token",
          GITHUB_OAUTH_CLIENT_SECRET: "test-oauth-secret",
          DEFAULT_LOGIN_POOL: "maintainers",
          PUBLIC_REPO_TTL_SECONDS: "300",
        },
      },
    })),
  ],
  test: {
    include: ["test/e2e/**/*.test.ts"],
    setupFiles: ["./test/e2e/setup.ts"],
    testTimeout: 15_000,
  },
});
