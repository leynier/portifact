import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Resolved through the package rather than a relative path, so the config also works from a
  // Stryker sandbox, which copies this package elsewhere.
  const dbSource = dirname(createRequire(import.meta.url).resolve("@portifact/db"));
  const migrations = await readD1Migrations(join(dbSource, "..", "migrations"));
  const accessMigrations = await readD1Migrations(join(dbSource, "..", "access-migrations"));
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          // DB_EU, ACCESS_DB_EU and ARTIFACTS_EU are the second region (decision 0005), each its
          // own database and bucket; SECOND_DB is a scratch control database for single tests.
          d1Databases: ["DB", "ACCESS_DB", "SECOND_DB", "DB_EU", "ACCESS_DB_EU"],
          r2Buckets: ["ARTIFACTS", "ARTIFACTS_EU"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_ACCESS_MIGRATIONS: accessMigrations,
            // Every handle refuses the other side's tables (packages/db/src/region-guard.ts).
            REGION_GUARD: process.env.REGION_GUARD ?? "strict",
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
        exclude: ["src/index.ts", "src/testing/**"],
        thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
      },
    },
  };
});
