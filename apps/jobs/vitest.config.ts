import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/migrations", import.meta.url)),
  );
  const accessMigrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/access-migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The second region (decision 0005): its own control and access log databases and its
          // own bucket, bound only in tests and the e2e Worker, never in wrangler.jsonc.
          d1Databases: ["DB_EU", "ACCESS_DB_EU"],
          r2Buckets: ["ARTIFACTS_EU"],
          bindings: {
            // Every handle refuses the other side's tables (packages/db/src/region-guard.ts).
            REGION_GUARD: process.env.REGION_GUARD ?? "strict",
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
        thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  };
});
