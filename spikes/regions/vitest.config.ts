import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// One migration history for every control database, as the spike recommends: the global
// database and each regional one get the same tables, and the code decides which handle it uses.
const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        // GLOBAL is the control database (identity, the directory, tombstones). DB_DEFAULT and
        // DB_EU are regional. Production keeps the default region in the control database, so
        // tests run both layouts: default region in GLOBAL, and every region separate.
        d1Databases: ["GLOBAL", "DB_DEFAULT", "DB_EU"],
        r2Buckets: ["ARTIFACTS", "ARTIFACTS_EU"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
