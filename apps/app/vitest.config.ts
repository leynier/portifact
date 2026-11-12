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
      // The pool sends every module a test file's graph already transformed in one WebSocket
      // message, which workerd caps at 32 MiB, and inline source maps were most of each
      // dependency's code. Dependencies keep no map here; this package's code keeps its own,
      // so coverage and stack traces into src are unchanged.
      {
        name: "portifact:no-dependency-sourcemaps",
        enforce: "post",
        transform(code: string, id: string) {
          return id.includes("/node_modules/") ? { code, map: { mappings: "" } } : undefined;
        },
      },
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The second region (decision 0005): its own control and access log databases and its
          // own bucket. The configuration binds the real ones; tests use these local ones.
          d1Databases: ["DB_EU", "ACCESS_DB_EU"],
          r2Buckets: ["ARTIFACTS_EU"],
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
            // Every handle refuses the other side's tables (packages/db/src/region-guard.ts).
            REGION_GUARD: process.env.REGION_GUARD ?? "strict",
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
            WEBHOOK_KEY: "test-only webhook sealing key for the app suite",
            // Offered in tests; the deployed configuration leaves it unset (decision 0009).
            WEBHOOKS_ENABLED: "true",
            // Single sign-on is offered in tests; the deployed configuration leaves it unset
            // (decision 0016). Identity providers are fakes (FakeIdentityProvider).
            SSO_ENABLED: "true",
            SSO_KEY: "test-only single sign-on sealing key for the app suite",
            // SCIM is offered in tests; the deployed configuration leaves it unset (decision 0017).
            SCIM_ENABLED: "true",
            // GitHub OIDC federation is offered in tests; the deployed configuration leaves it unset
            // (decision 0024). GitHub is a fake issuer (FakeGitHubIssuer).
            GITHUB_OIDC_ENABLED: "true",
            // Issue integrations are offered in tests; the deployed configuration leaves them
            // unset (decision 0018). GitHub and Linear are fakes (FakeIssueTrackers).
            INTEGRATIONS_ENABLED: "true",
            SLACK_ENABLED: "true",
            INTEGRATIONS_KEY: "test-only integrations sealing key for the app suite",
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
      // Hooks start the Worker and its databases; the 10 second default fails on a slow runner.
      hookTimeout: 30_000,
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
