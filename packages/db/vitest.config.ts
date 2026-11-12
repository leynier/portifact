import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );
  const accessMigrations = await readD1Migrations(
    fileURLToPath(new URL("./access-migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          // MIGRATION_DB starts empty, for tests that apply the migrations in steps.
          // DB_EU, ACCESS_DB_EU and ARTIFACTS_EU are the second region (decision 0005).
          d1Databases: ["DB", "ACCESS_DB", "MIGRATION_DB", "DB_EU", "ACCESS_DB_EU"],
          r2Buckets: ["ARTIFACTS", "ARTIFACTS_EU"],
          bindings: { TEST_MIGRATIONS: migrations, TEST_ACCESS_MIGRATIONS: accessMigrations },
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
        exclude: ["src/schema.ts", "src/auth-schema.ts", "src/access-schema.ts"],
        thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  };
});
