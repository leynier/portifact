import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The data Worker's tests run in workerd with the documents object on real SQLite storage. The
// configuration is the deployable one (wrangler.jsonc), with the class and its migration. The
// lifecycle tests (delivery 4, second half) also need what the jobs Worker has: the control
// databases of two regions and their buckets, bound here for the tests only, so the jobs'
// services drive the real object exactly as the jobs Worker does.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["DB", "DB_EU"],
          r2Buckets: ["ARTIFACTS", "ARTIFACTS_EU"],
          bindings: {
            // Every handle refuses the other side's tables (packages/db/src/region-guard.ts).
            REGION_GUARD: process.env.REGION_GUARD ?? "strict",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      // CI runs every package's tests at once on one runner; time budgets are asserted
      // explicitly where they matter, so the timeout only catches hangs.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul" as const,
        reporter: ["text", "json-summary"],
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.d.ts"],
        thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  };
});
