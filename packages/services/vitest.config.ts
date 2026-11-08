import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../db/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["ARTIFACTS"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul" as const,
        reporter: ["text", "json-summary"],
        include: ["src/**/*.ts"],
        exclude: ["src/index.ts"],
        thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
      },
    },
  };
});
