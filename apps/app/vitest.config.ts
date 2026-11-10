import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The same migrations production applies, so the tests run against the real schema.
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/migrations", import.meta.url).href),
  );
  const accessMigrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/access-migrations", import.meta.url).href),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // highlight.js's grammars (packages/render) load from disk as plain ES modules instead
          // of through Vite: the pool sends every module Vite transformed for a test file in one
          // WebSocket message, which workerd caps at 32 MiB, and this suite's graph is close to it.
          modulesRules: [
            {
              type: "ESModule",
              include: ["**/highlight.js/es/core.js", "**/highlight.js/es/languages/*.js"],
            },
            { type: "CommonJS", include: ["**/highlight.js/lib/core.js"] },
          ],
          bindings: {
            // Fixed values that only exist in local tests. Real secrets use wrangler secret.
            BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-else-0123456789",
            GOOGLE_CLIENT_SECRET: "test-google-secret",
            GITHUB_CLIENT_SECRET: "test-github-secret",
            R2_ACCESS_KEY_ID: "test-r2-access-key-id",
            R2_SECRET_ACCESS_KEY: "test-r2-secret-access-key",
            // Cloudflare's documented Turnstile test keys (always pass). Siteverify itself is a
            // fake in test/harness.ts, so no test reaches Cloudflare.
            TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            // Signs and checks comment notice unsubscribe links (test/comment-notices.test.ts).
            UNSUBSCRIBE_SECRET: "test-only-unsubscribe-secret",
            TEST_MIGRATIONS: migrations,
            TEST_ACCESS_MIGRATIONS: accessMigrations,
          },
        },
      }),
    ],
    test: {
      // CI runs every package's tests at once on one runner; time budgets are asserted
      // explicitly where they matter, so the timeout only catches hangs.
      testTimeout: 30_000,
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul" as const,
        reporter: ["text", "json-summary"],
        include: ["src/**/*.ts"],
        // Auth and access-control code: the strictest thresholds in docs/testing.md.
        thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  };
});
